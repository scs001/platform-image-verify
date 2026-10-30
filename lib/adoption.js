// lib/adoption.js — 官方精选转正管线（add-official-adopted-agents 2.3 / 2.4 / 2.5）
//
// 一条链，从「货架条目」到「可直接发布的官方 Agent manifest 草稿」：
//
//   取包(fetchPackage) → 采许可证据(collectUpstreamLicenseEvidence)
//     → 许可门(assertLicenseAdmissible)         ← 不过就整条失败，零副作用
//     → 钉定上游 revision(resolvePinnedRevision)
//     → 组装 manifest(技能内联 + persona + serving.toolFace=chat + provenance)
//     → 自检(validatePackManifest)              ← 用发布门同一套规则
//
// 三条不可让步的设计约束（对应 spec）：
//
//   1. **不引用货架**：技能正文与辅助文件整棵内联进 manifest，运行期不回源。
//      上游 404 时转正资产仍完整可用（D2）。provenance.revision 只是审计锚点。
//   2. **工具面默认收窄**：产物声明 serving.toolFace = "chat"，无 shell/文件/
//      浏览器/子代理触手。第三方正文是不可信文本，先关在「只能说」的范围里（D4）。
//   3. **不自带官方身份**：manifest.provenance 只是来源标注。official 仍由部署
//      roster 决定（gateway/packs.js），本模块永远不写任何「我是官方」字段（D1）。
//
// 本模块不落库、不发布：它产出一份 manifest 草稿与一份转换报告，发布仍走既有
// publish 通道（所以 roster、定价门、审核门一条都不绕过）。

import { assertLicenseAdmissible, evaluateLicense } from "./license-gate.js";
import { collectUpstreamLicenseEvidence } from "./upstream-license.js";
import { parseGitTreeUrl, outboundFetch } from "../external-sources.js";
import { validatePackManifest } from "./pack-manifest.js";
import { sanitizeFrontmatter } from "../external-install.js";
import { safePackagePath } from "./skill-files.js";

// 转正产出的接待角色 id。固定值，便于运营与 UI 一致引用。
export const ADOPTED_AGENT_ID = "curator";

// 名字归一化到 dsh 技能文法（与 external-install 同一目标文法）。
function slugifySkillName(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// 包内文件 → manifest 的 skills[].files。
// 两道门与发布校验器同源：SKILL.md 必须剔除（渲染时由 content 生成，留着会被
// 校验器判冲突）；路径必须过 safePackagePath（逃逸即弃）。
function inlinableFiles(files) {
  const out = {};
  if (!files || typeof files !== "object") return out;
  for (const [rawPath, text] of Object.entries(files)) {
    const safe = safePackagePath(rawPath);
    if (!safe || typeof text !== "string") continue;
    const base = safe.split("/").pop() || safe;
    if (/^SKILL\.md$/i.test(base)) continue; // generated from content
    out[safe] = text;
  }
  return out;
}

// 版本号：转正首发一律 1.0.0；上游变更走 vN+1（D6），由发布通道递增。
const INITIAL_VERSION = 1;

/**
 * 解析上游钉定 revision：把分支/标签 ref 解析成 commit sha。
 *
 * 拿不到 sha 时**不抛**，退回落到的 ref 名字并在报告里标记 `revisionKind`。
 * 理由：revision 是审计锚点，不是可用性依赖（内容已内联）；但必须如实告诉
 * 运营「这条钉的是分支还是提交」，不能假装钉住了。
 */
export async function resolvePinnedRevision(entry, { fetchImpl = outboundFetch } = {}) {
  const originUrl = entry?.originUrl ?? null;
  const parsed = originUrl ? parseGitTreeUrl(originUrl) : null;
  if (!parsed) return { revision: null, revisionKind: "none", repo: null };
  const { owner, repo, ref, subPath } = parsed;
  const repoLabel = `${owner}/${repo}`;
  // 已经是 40 位 sha（或 7-39 位短 sha）就直接用，省一次请求。
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    return { revision: ref, revisionKind: "commit", repo: repoLabel, subPath };
  }
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
    if (res.ok) {
      const doc = await res.json();
      const sha = typeof doc?.sha === "string" ? doc.sha : null;
      if (sha) return { revision: sha, revisionKind: "commit", repo: repoLabel, subPath };
    }
  } catch {
    // 网络/限额失败 → 落到下面的 ref 回落，不中断转正
  }
  return { revision: ref || null, revisionKind: "ref", repo: repoLabel, subPath };
}

// 由技能正文与描述起草一个最小 persona。**这是草稿**：运营须定稿后再发布。
// 起草纪律对齐 facade-builder：只答技能覆盖的、覆盖不到就如实说、不编造。
function draftPersona({ displayName, skillDescriptions }) {
  const coverage = skillDescriptions.filter(Boolean).map((d) => `- ${d}`).join("\n") || "- （待补充）";
  return [
    `你是「${displayName}」——把这个技能的能力直接交付给用户的助手。`,
    "",
    "你的工作方式与边界由本包内联的技能定义：",
    coverage,
    "",
    "纪律：",
    "- 只按技能里写明的流程与方法作答；技能没覆盖的问题，如实说「这个不在我的能力范围内」，不要编造。",
    "- 不承诺技能之外的能力，不替用户对外许诺价格、合同或交付日期。",
    "- 引用技能里的步骤时给出可执行的下一步，而不是复述概念。",
  ].join("\n");
}

/**
 * 组装转正 manifest（纯函数，便于测试）。
 *
 * @param {{pack: object, entry: object, license: object, pin: object, operator: string, reviewer: string, now?: string, displayName?: string}} args
 * @returns {{manifest: object, report: object}}
 */
export function buildAdoptedManifest({ pack, entry, license, pin, operator, reviewer, now, displayName }) {
  const upstreamName = entry?.name ?? entry?.displayName ?? "adopted-skill";
  const name = displayName || entry?.displayName || entry?.name || upstreamName;
  const skillName = slugifySkillName(upstreamName) || "adopted-skill";

  const auxFiles = inlinableFiles(pack?.files);
  const frontmatter = sanitizeFrontmatter(pack?.frontmatter);

  const skills = [
    {
      name: skillName,
      description: String(pack?.frontmatter?.description || entry?.description || name).slice(0, 300),
      content: pack.body,
      // 辅助文件整棵内联（有才带，空不带）——与 preset-pack-bridge 的既有形状一致。
      ...(Object.keys(auxFiles).length > 0 ? { files: auxFiles } : {}),
      ...(Object.keys(frontmatter).length > 0 ? { frontmatter } : {}),
    },
  ];

  const manifest = {
    name,
    description: String(entry?.description || pack?.frontmatter?.description || name).slice(0, 2000),
    tags: Array.isArray(entry?.tags) ? entry.tags.filter((t) => typeof t === "string").slice(0, 10) : [],
    visibility: "public",
    version: INITIAL_VERSION,
    skills,
    agents: [
      {
        id: ADOPTED_AGENT_ID,
        name,
        description: `由「${upstreamName}」转正的官方助手`,
        persona: draftPersona({ displayName: name, skillDescriptions: skills.map((s) => s.description) }),
        serving: {
          // toolFace 只能挂在 serving 上；chat = 无 shell/文件/浏览器/子代理触手。
          protocol: "a2a",
          toolFace: "chat",
          card: {
            name,
            description: String(entry?.description || name).slice(0, 300),
            // 校验器要求 1-3 条示例（serving.card.examples）。转正产物没有人为
            // 撰写的试问，用一个由技能名生成的最小示例占位；运营可在定稿时替换。
            examples: [`用「${name}」帮我处理一个任务`].map((s) => s.slice(0, 200)),
          },
        },
      },
    ],
    provenance: {
      kind: "official-adopted",
      upstreamUrl: String(entry?.originUrl || ""),
      upstreamName: String(upstreamName).slice(0, 200),
      license: license.governing,
      revision: pin.revision,
      adoptedBy: operator,
      reviewedBy: reviewer,
      reviewedAt: now || new Date().toISOString(),
    },
    notes: [
      `转正自 ${entry?.source ?? "external"}/${entry?.slug ?? upstreamName}`,
      `钉定 ${pin.revisionKind === "commit" ? "提交" : "引用"} ${pin.revision}`,
      "工具面默认 chat（无 shell/文件/浏览器/子代理）；放宽须审校记录。",
    ].join("；"),
  };

  const report = {
    upstreamName,
    source: entry?.source ?? null,
    slug: entry?.slug ?? null,
    originUrl: entry?.originUrl ?? null,
    repo: pin.repo,
    revision: pin.revision,
    revisionKind: pin.revisionKind,
    license: license.governing,
    licenseObserved: license.observed,
    licenseNotes: license.notes,
    toolFace: "chat",
    inlinedSkillFiles: Object.keys(pack?.files ?? {}),
    // 明确告知运营这是草稿：persona 需要人看一遍。
    personaDrafted: true,
    mustReview: ["persona 是否贴合上游技能的职责边界", "技能正文是否需要删改平台内部信息"],
  };

  return { manifest, report };
}

/**
 * 完整转正：取包 → 许可 → 钉定 → 组装 → 自检。
 *
 * 任一步失败即抛，且**零副作用**（本模块不写库、不发布）。错误对象带
 * `code`，便于端点层映射：license-rejected / upstream-not-found / manifest-invalid。
 *
 * @param {{source: string, slug: string, registry: object, operator: string, reviewer: string,
 *          fetchImpl?: Function, now?: string, displayName?: string}} args
 */
export async function adoptExternalSkill({
  source,
  slug,
  registry,
  operator,
  reviewer,
  fetchImpl = outboundFetch,
  now,
  displayName,
} = {}) {
  if (!operator || !reviewer) {
    throw Object.assign(new Error("adoption requires an operator and a reviewer (attributability)"), {
      code: "adoption-unattributed",
      status: 400,
    });
  }

  // 1. 取包（复用既有链路，不新增适配器）
  const pack = await registry.fetchPackage(source, slug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${source}`), { code: "unknown-source", status: 404 });
  }
  const entry = await registry.getEntry(source, slug).then((r) => r?.entry ?? null).catch(() => null);
  if (!entry) {
    throw Object.assign(new Error(`External entry not found: ${source}/${slug}`), { code: "upstream-not-found", status: 502 });
  }

  // 2. 许可证据 + 门（货架 licenseState 不参与判定）
  const evidence = await collectUpstreamLicenseEvidence({ source, slug, entry, pack }, { fetchImpl });
  const license = assertLicenseAdmissible(evidence);

  // 3. 钉定 revision
  const pin = await resolvePinnedRevision(entry, { fetchImpl });
  if (!pin.revision) {
    throw Object.assign(
      new Error("adoption requires a pinnable upstream revision (no commit/ref resolvable from the origin URL)"),
      { code: "unpinnable-upstream", status: 422, licenseState: license.state },
    );
  }

  // 4. 组装
  const { manifest, report } = buildAdoptedManifest({
    pack,
    entry,
    license,
    pin,
    operator,
    reviewer,
    now,
    displayName,
  });

  // 5. 用发布门同一套规则自检——转正产物必须是个合法包
  const errors = validatePackManifest(manifest);
  if (errors.length > 0) {
    throw Object.assign(new Error(`adopted manifest failed validation: ${errors[0].error}`), {
      code: "manifest-invalid",
      status: 422,
      errors,
    });
  }

  return { manifest, report, evidence: { count: evidence.length, license } };
}

// 供端点做「先预览不转正」：只评估许可与可钉定性，不组装产物。
export async function previewAdoption({ source, slug, registry, fetchImpl = outboundFetch } = {}) {
  const pack = await registry.fetchPackage(source, slug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${source}`), { code: "unknown-source", status: 404 });
  }
  const entry = await registry.getEntry(source, slug).then((r) => r?.entry ?? null).catch(() => null);
  if (!entry) {
    throw Object.assign(new Error(`External entry not found: ${source}/${slug}`), { code: "upstream-not-found", status: 502 });
  }
  const evidence = await collectUpstreamLicenseEvidence({ source, slug, entry, pack }, { fetchImpl });
  const license = evaluateLicense(evidence);
  const pin = await resolvePinnedRevision(entry, { fetchImpl });
  return {
    entry: { source, slug, name: entry.name, displayName: entry.displayName, originUrl: entry.originUrl },
    license,
    evidence: evidence.map((e) => e.source),
    pinnable: Boolean(pin.revision),
    revision: pin.revision,
    revisionKind: pin.revisionKind,
    inlinedFiles: Object.keys(pack.files ?? {}).length,
    bodyChars: String(pack.body ?? "").length,
    hasScripts: Array.isArray(pack.inventory) && pack.inventory.some((f) => f.script && f.action === "stored"),
  };
}
