// 蓝图校验桥（add-blueprint-studio Slice 1, design D3/D5；v1 兼容层已摘除——
// remove-blueprint-v1-compat）。
//
// 零第二造：本模块的每一则校验错误都来自既有校验器原文——
//   parseFleetTemplate      fleet 段（server/fleet-template.js，含编排成环）
//   validatePackManifest    manifest 段（lib/pack-manifest.js，发布门同函数）
//   toolFaceErrors/toolClosureErrors
//                           发布工具闸的 consult 复用（lib/publish-tool-gate.js
//                           同步导出；异步带探针的 toolGateErrors 留在发布门，
//                           design「实施口径对账」D3 补充）
// 唯一本地生成的发现是 shape 闸（凭据扫描 + dataSources 契约），粒度同样
// 逐字段指名——spec「错误文案不得超过既有校验器原文的字段粒度」。
//
// 形状纪律（spec 蓝图不含凭据）：dataSources 只收 registry 在册 server 名或
// 内部库逻辑名；端点/凭据在存储层另有硬拒（blueprints-db.js assertStorable）。

import { parseFleetTemplate } from "./fleet-template.js";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { toolFaceErrors, toolClosureErrors } from "../lib/publish-tool-gate.js";
import { buildUserProviderEntries, getDefault } from "../llm-providers.js";

// ── Shape gate: 凭据扫描（存储层与 validate 路由共用） ─────────────────────

// 键名禁带：子串匹配长词（token/secret/…），短小通用词用精确集合避免误伤
// （"headline" 不吃 "headers" 这类亏）。契约白名单里的键永不判罚。
const FORBIDDEN_KEY_PARTS = /token|secret|password|credential|api[-_]?key|private[-_]?key/i;
const FORBIDDEN_KEY_EXACT = new Set(["endpoint", "url", "headers", "baseurl", "base_url", "base-url", "host"]);
const CONTRACT_KEY_WHITELIST = new Set(["target", "registryName", "allowTools", "requiredGroup", "fullSurface", "reason"]);

// 秘密字面值：命中常见的真凭据形态；普通 URL/散文不匹配。
const SECRET_LITERAL_RE =
  /(sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|bearer\s+[A-Za-z0-9._-]{12,})/i;

export function credentialFindings(content) {
  const findings = [];
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${at}[${i}]`);
      return;
    }
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && SECRET_LITERAL_RE.test(node)) {
        findings.push({ error: `secret-like literal is not allowed in a blueprint`, entry: at || "$" });
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const entry = at ? `${at}.${key}` : key;
      if (
        !CONTRACT_KEY_WHITELIST.has(key) &&
        (FORBIDDEN_KEY_PARTS.test(key) || FORBIDDEN_KEY_EXACT.has(key.toLowerCase()))
      ) {
        findings.push({ error: `key '${key}' may not carry endpoints or credentials in a blueprint`, entry });
        continue; // 命中禁键即名之，不再下探该子树（错误归主键）。
      }
      walk(value, entry);
    }
  };
  walk(content, "");
  return findings;
}

// ── Shape gate: dataSources 契约（只在册名/逻辑名/知识库集合，禁端点禁凭据） ──

const DATASOURCE_REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Third ref kind (add-knowledge-memory-surface 3.1): a knowledge-base
// collection pinned into the blueprint. `library:<collectionId>` makes the
// materialized member a KB-scoped agent (its library tools see that collection
// ∪ shared, per document-library-tools' boundary). This module stays DB-free,
// so it validates the SHAPE here and takes an optional `resolveLibrary(id)`
// callback from the caller that owns DB access — returning true (visible), a
// string (why not) or false (dangling/invisible).
const LIBRARY_REF_RE = /^library:([A-Za-z0-9_-]{1,64})$/;

export function dataSourceFindings(content, resolveLibrary = null) {
  const findings = [];
  const sources = content?.dataSources;
  if (sources === undefined || sources === null) return findings;
  if (!Array.isArray(sources)) {
    return [{ error: "dataSources must be an array of { ref } entries naming registry servers, internal libraries, or knowledge collections (library:<id>)", entry: "dataSources" }];
  }
  sources.forEach((src, i) => {
    const entry = `dataSources[${i}]`;
    if (!src || typeof src !== "object" || Array.isArray(src)) {
      findings.push({ error: `data source must be an object of { ref, note? } naming a registry server, an internal-library logical name, or a knowledge collection (library:<id>)`, entry });
      return;
    }
    const ref = src.ref;
    const isLibrary = typeof ref === "string" && LIBRARY_REF_RE.test(ref);
    if (typeof ref !== "string" || (!DATASOURCE_REF_RE.test(ref) && !isLibrary)) {
      findings.push({
        error: `data source ref '${ref}' must be a registry server name, an internal-library logical name, or a knowledge collection (library:<id>) — no endpoints, no credentials`,
        entry: `${entry}.ref`,
      });
      return;
    }
    // Resolution: when the caller can check the collection, a dangling or
    // invisible id is refused BY NAME (spec: 悬空引用指名拒绝).
    if (isLibrary && typeof resolveLibrary === "function") {
      const id = ref.slice("library:".length);
      const verdict = resolveLibrary(id);
      if (verdict !== true) {
        findings.push({
          error: `data source ${entry}.ref 'library:${id}' does not name a collection you can see${typeof verdict === "string" ? ` (${verdict})` : ""}`,
          entry: `${entry}.ref`,
        });
      }
    }
    if (src.note !== undefined && typeof src.note !== "string") {
      findings.push({ error: `data source note must be a string when present`, entry: `${entry}.note` });
    }
  });
  return findings;
}

export function shapeFindings(content) {
  return [...credentialFindings(content), ...dataSourceFindings(content)];
}

// 判定模型在册校验（add-blueprint-judge-model-choice D3）：错配置要在校验面就暴露，
// 不放试跑到「装台+点火+一轮」之后才说模型不存在。名册读不到时降级为不校验
// （存储问题不该让所有蓝图无法批准）。
export function judgeModelFindings(content) {
  const wanted = content?.judgeModel;
  if (typeof wanted !== "string" || !wanted.trim()) return [];
  // 名册来源（2026-10-29 生产实证）：cell 进程有自己的 PLATFORM_DATA_DIR，
  // 其 llm-providers.json 常为空（模型配置在网关/部署侧）→ 只读 cell 名册会把
  // 「不在册」误判成「在册」。补两个来源：部署 env 的 BLUEPRINT_JUDGE_MODEL 与
  // default 指针。三者全不可知才降级为不校验（存储问题不该阻塞全部批准）。
  const known = new Set();
  try {
    for (const m of buildUserProviderEntries().models ?? []) {
      known.add(m.id);
      if (m.name) known.add(m.name);
    }
  } catch {
    // ignore — 走下面的补充来源
  }
  try {
    const d = getDefault();
    if (d?.modelId) known.add(d.modelId);
  } catch {
    // ignore
  }
  const deployed = (process.env.BLUEPRINT_JUDGE_MODEL || "").trim();
  if (deployed) known.add(deployed);
  if (known.size === 0) return [];
  if (known.has(wanted)) return [];
  return [
    {
      error: `judgeModel '${wanted}' is not in this deployment's model roster — pick one on the model settings page, or clear the field to follow the deployment default`,
      entry: "judgeModel",
    },
  ];
}

// ── Shape gate: v1 方言如实拒绝（remove-blueprint-v1-compat, design D1/D2） ──
//
// 平台只接受蓝图格式 v2。收到 v1 方言——出现 v1 独有键（vertical / sources /
// boards）而对应 v2 键（boundary / dataSources / board）缺位——时如实指名拒绝，
// 不归一化、不猜测。与「未知断言 kind 拒绝而非猜测」同族。
//
// 判别与 v2 键成对比较：一份合规的 v2 文档即便另带一个无害旧键也不触发（对应
// v2 键在场）。命中即返回唯一一条根因错误；调用方（validateBlueprint / 存储层）
// 须短路或硬拒，不得再叠加方言错位派生的散错。
const V1_FORMAT_ERROR = [
  // 开发者：v2 格式全文真源 = fleet-packs 仓（GitHub FindDataTechnology/fleet-packs，
  // 2026-10-30 起入版本控制）blueprints/schema.md v2；此处用户可见文案只列字段闭集，不带内部路径。
  "蓝图格式为 v1（vertical/sources/boards + 自由文本 acceptance），本平台只接受 v2。",
  "v2 字段：boundary{name, oneLine, outOfScope} / dataSources[{ref, note?}] / board[] / acceptance[{id, kind, target?, expect?, rubric?}]。",
  "迁移：把 vertical{name,tagline,non_goals[]} 换成 boundary{name, oneLine, outOfScope}、sources[].registryName 换成 dataSources[].ref、boards 换 board、自由文本断言换成五型结构化条目。",
].join("\n");

export function v1FormatFindings(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  const has = (k) => Object.hasOwn(content, k) && content[k] !== undefined;
  const v1Shaped =
    (has("vertical") && !has("boundary")) ||
    (has("sources") && !has("dataSources")) ||
    (has("boards") && !has("board"));
  if (!v1Shaped) return [];
  return [{ error: V1_FORMAT_ERROR, entry: "content" }];
}

// ── Manifest 组装与全链校验 ────────────────────────────────────────────────

export const MACHINE_ASSERTION_KINDS = ["post-materialized", "first-round-fired", "report-landed", "escalate-bounded"];
// llm-judged（add-blueprint-llm-assertions）：自由文本 rubric 交 judge 车道三态判定
// （pass/fail/insufficient-evidence），判绿还须 owner 签报告——双钥匙，见 design D1。
export const TRIAL_ASSERTION_KINDS = [...MACHINE_ASSERTION_KINDS, "llm-judged"];

// 成本闸（design D6）：超限如实拒，不静默截断。
export const JUDGE_ASSERTION_CAP = Number(process.env.BLUEPRINT_JUDGE_MAX || 8);

// 断言条目形状：{ id, kind, target?, expect? }。target = 岗位 title（缺省=全岗）。
export function normalizeAcceptance(acceptance) {
  const list = Array.isArray(acceptance) ? acceptance : [];
  const assertions = [];
  const errors = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ error: `acceptance[${i}] must be an object of { id, kind, target?, expect? }`, entry: `acceptance[${i}]` });
      return;
    }
    const id = typeof item.id === "string" && item.id.trim() ? item.id : `a${i + 1}`;
    const kind = item.kind;
    if (!TRIAL_ASSERTION_KINDS.includes(kind)) {
      errors.push({ error: `acceptance[${i}] '${id}' declares unsupported assertion kind '${kind ?? "(none)"}' (supported: ${TRIAL_ASSERTION_KINDS.join(", ")})`, entry: `acceptance[${i}].kind` });
    }
    if (item.target !== undefined && typeof item.target !== "string") {
      errors.push({ error: `acceptance[${i}] '${id}' target must be a post title when present`, entry: `acceptance[${i}].target` });
    }
    if (kind === "escalate-bounded" && item.expect !== undefined && !Number.isFinite(item.expect)) {
      errors.push({ error: `acceptance[${i}] '${id}' expect must be a number for escalate-bounded`, entry: `acceptance[${i}].expect` });
    }
    // llm-judged：rubric 是判据原文，必须非空——空判据等于没判据。
    let rubric = null;
    if (kind === "llm-judged") {
      if (typeof item.rubric !== "string" || !item.rubric.trim()) {
        errors.push({
          error: `acceptance[${i}] '${id}' llm-judged needs a non-empty rubric (the acceptance text the judge reads)`,
          entry: `acceptance[${i}].rubric`,
        });
      } else {
        rubric = item.rubric.trim();
      }
    }
    assertions.push({ id, kind, target: item.target ?? null, expect: item.expect ?? null, ...(rubric ? { rubric } : {}) });
  });
  const judged = assertions.filter((a) => a.kind === "llm-judged");
  if (judged.length > JUDGE_ASSERTION_CAP) {
    errors.push({
      error: `this blueprint declares ${judged.length} llm-judged assertions, over the cap of ${JUDGE_ASSERTION_CAP} (each one is a model call) — merge or drop some`,
      entry: "acceptance",
    });
  }
  return { assertions, errors };
}

// 铸造时喂给既有校验器的 manifest：名字取场景中文主名（类型由「集群模板」
// 专辑位/徽章承载，名字不背类型——产品命名决议）；category 钉 "fleet"
// （代码键零改老律：专辑显示名是市场层的词，键不动）。
export function assembleManifest(content, { name } = {}) {
  const sceneName = name ?? content?.boundary?.name ?? content?.fleet?.name ?? content?.fleet?.nameKey ?? "";
  const manifest = {
    name: sceneName,
    description: content?.boundary?.oneLine ?? "",
    category: "fleet",
  };
  if (Array.isArray(content?.tags)) manifest.tags = content.tags;
  if (content?.agents !== undefined) manifest.agents = content.agents;
  if (content?.mcpServers !== undefined) manifest.mcpServers = content.mcpServers;
  if (content?.fleet !== undefined) manifest.fleet = content.fleet;
  return manifest;
}

// 提交前全套校验链（spec 要求三 + D3 consult）：shape → parseFleetTemplate
// → validatePackManifest → toolFace/toolClosure。返回按链序摊平的 errors
// （既有校验器原文逐字段）+ manifestPreview 供编辑面/铸造复用。
export function validateBlueprint(content, { resolveLibrary = null } = {}) {
  const manifestPreview = assembleManifest(content);
  // v1 方言前置短路（design D1）：错方言的派生发现（逐条 acceptance 形状错、
  // 无字段归属的包级错）会淹没根因——命中即只报这一条。
  const v1 = v1FormatFindings(content);
  if (v1.length) {
    return {
      ok: false,
      errors: v1,
      findings: { v1, shape: [], acceptance: [], fleet: [], manifest: [], toolFace: [], toolClosure: [] },
      manifestPreview,
    };
  }
  const shape = [...credentialFindings(content ?? {}), ...dataSourceFindings(content ?? {}, resolveLibrary)];
  // 验收断言段也进校验链：试跑只有五类可判绿的断言，未知 kind 在此就指名，
  // 不留到试跑才暴露。
  const acceptance = normalizeAcceptance(content?.acceptance).errors;
  const judgeModel = judgeModelFindings(content);
  const fleetParsed = parseFleetTemplate(manifestPreview);
  const fleet = fleetParsed.ok ? [] : [{ error: fleetParsed.error, entry: "fleet" }];
  const manifest = validatePackManifest(manifestPreview);
  const toolFace = toolFaceErrors(manifestPreview);
  const toolClosure = toolClosureErrors(manifestPreview);
  const errors = [...shape, ...judgeModel, ...acceptance, ...fleet, ...manifest, ...toolFace, ...toolClosure];
  return {
    ok: errors.length === 0,
    errors,
    findings: { v1: [], shape, judgeModel, acceptance, fleet, manifest, toolFace, toolClosure },
    manifestPreview,
  };
}

// ── 归一化 diff（批准面渲染与批准凭据同源） ────────────────────────────────

const clip = (s) => {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  return text && text.length > 80 ? `${text.slice(0, 77)}…` : text;
};
const countOf = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);

export function diffBlueprint(prev, next) {
  const diff = [];
  const pushScalar = (field, a, b) => {
    if ((a ?? "") !== (b ?? "")) diff.push({ field, before: clip(a ?? ""), after: clip(b ?? "") });
  };
  const pushCount = (field, a, b) => {
    if (countOf(a) !== countOf(b)) diff.push({ field, before: countOf(a), after: countOf(b) });
  };

  pushScalar("boundary.name", prev?.boundary?.name, next?.boundary?.name);
  pushScalar("boundary.oneLine", prev?.boundary?.oneLine, next?.boundary?.oneLine);
  pushScalar("boundary.outOfScope", prev?.boundary?.outOfScope, next?.boundary?.outOfScope);
  pushCount("dataSources", prev?.dataSources, next?.dataSources);
  pushCount("fleet.members", prev?.fleet?.members, next?.fleet?.members);
  pushCount("fleet.orchestration.edges", prev?.fleet?.orchestration?.edges, next?.fleet?.orchestration?.edges);
  pushCount("agents", prev?.agents, next?.agents);
  pushCount("mcpServers", prev?.mcpServers, next?.mcpServers);
  pushCount("acceptance", prev?.acceptance, next?.acceptance);
  pushCount("monitoring", prev?.monitoring, next?.monitoring);
  if (Boolean(prev?.board) !== Boolean(next?.board)) {
    diff.push({ field: "board", before: Boolean(prev?.board), after: Boolean(next?.board) });
  }
  return diff;
}

// ── 铸造：依赖占位补齐 + _casting 追溯 ────────────────────────────────────
//
// 占位形态（finddata fleet-packs 契约）：
//   {{PACK_ID:<name>}}  依赖包引用（纪律 pack 等）——铸造时按名字经市场解析
//                       落实 packId；解析不出 = 依赖漂移，铸造拒（design D4）。
//   {{PACK_ID}} / {{PACK_ID:self}}  包自引用——续铸（已知 cast_pack_id）回补
//                       自身谱系；首铸保持占位（paas 装台链按 presetId 物化，
//                       从不消费 target.packId——fleet-provisioner.js 实证，
//                       占位在发布后呈惰性）。

const PACK_REF_RE = /\{\{PACK_ID:([^}]+)\}\}/g;
const SELF_REF_RE = /\{\{PACK_ID(?::self)?\}\}/g;

export function collectPackRefs(content) {
  const refs = new Set();
  const text = JSON.stringify(content ?? {});
  for (const match of text.matchAll(PACK_REF_RE)) {
    const name = match[1]?.trim();
    if (name && name !== "self") refs.add(name);
  }
  return [...refs];
}

export function buildCastManifest({ content, resolved = {}, selfPackId = null, casting }) {
  const assembled = assembleManifest(content);
  let text = JSON.stringify(assembled);
  const missing = [];
  text = text.replace(PACK_REF_RE, (whole, raw) => {
    const name = raw.trim();
    if (name === "self") return whole; // 自引用走 SELF_REF_RE 通道
    const hit = resolved[name];
    if (!hit?.packId) {
      missing.push(name);
      return whole;
    }
    return hit.packId;
  });
  let selfPending = false;
  text = text.replace(SELF_REF_RE, (whole) => {
    if (selfPackId) return selfPackId;
    selfPending = true;
    return whole;
  });
  const manifest = JSON.parse(text);
  manifest._casting = {
    source: "fleet-blueprint-studio",
    blueprintId: casting.blueprintId,
    version: casting.version,
    approvedBy: casting.approvedBy,
    approvedAt: casting.approvedAt,
    diffSummary: casting.diffSummary ?? null,
  };
  // 试跑报告随铸造追溯走（可售闸只读 manifest，不跨服务查）：只带判绿所需的
  // 三件——green / 模型判决 / 签字，不塞全量证据（体积与泄密面）。
  if (casting.trialReport) {
    const r = casting.trialReport;
    manifest._casting.trialReport = {
      green: r.green === true,
      ranAt: r.ranAt ?? null,
      ...(Array.isArray(r.judged) && r.judged.length ? { judged: r.judged.map((j) => ({ id: j.id, verdict: j.verdict, pass: j.pass })) } : {}),
      ...(r.signoff ? { signoff: r.signoff } : {}),
    };
  }
  return { manifest, missing, selfPending };
}
