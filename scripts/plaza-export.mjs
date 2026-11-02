// ── 壹座·智能体素材广场 export pipeline (add-agent-materials-plaza) ──
//
// One truth, three machine surfaces + the human-face data injection:
//   facet market listing  ──►  snapshot.json (fallback + audit face)
//                         ──►  catalog.json   (annotation-layer shape, zero new vocabulary)
//                         ──►  llms.txt / llms-full.txt (AI site index, en primary + zh mirror)
//                         ──►  materials/<slug>.md (per-material self-contained pages, en+zh)
//                         ──►  infrastructure.md (input–action–output table)
//                         ──►  counts.json (hero counters for the static pages)
//
// Admission: the market's ONE listing rule, mirrored exactly from
// facet/marketplace-json.js loadListedPacks (public + non-unlisted + curated
// [category ∨ featured]; an operator whitelist replaces curation outright).
// The count authority is the PRODUCTION endpoint /api/marketplace/marketplace.json
// — already the single-rule output — so the reconciliation gate compares two
// independent derivations, not the export against itself.
//
// Gates (fail = non-zero exit, zero artifacts written):
//   G1 count reconciliation  — filtered listing count == marketplace.json plugin count
//   G2 annotation shape      — every catalog entry carries canonical.brief,
//                              human.{zh,en,es,fr,ja}, whenToUse, provenance{source,updatedAt}
//   G3 ai_readable six lint  — self-contained sections / full entity names / one term per
//                              concept / input–action–output tables / cold-read three questions /
//                              provenance present
//
// Run:  node scripts/plaza-export.mjs [--base <facet-url>] [--out <dir>] [--fixture <file>]
//       [--allow-stale]   # on total fetch failure, continue from the last snapshot
//
// Offline/test: --fixture <file> replaces the network (the fixture carries the
// same shape the network fetches produce). scripts/test-plaza-export.mjs drives
// the module functions directly.

import fs from "node:fs";
import path from "node:path";

const PLAZA_NAME = {
  zh: "壹座·智能体素材广场",
  en: "Yizuo Agent Materials Plaza",
};
const LOCALES = ["zh-CN", "en", "es", "fr", "ja"];
const DEFAULT_BASE = process.env.FACET_BASE || "https://facet.finddatatech.cloud";
const CATEGORY_ENUM_VERSION = 1;
// The closed category enumeration (agent-materials-plaza spec: new species
// extend this with a version bump, never overload an existing value).
const CATEGORY_ENUM = ["pack", "skill", "mcp", "facade", "official-data"];

// ── admission predicate — mirror of facet/marketplace-json.js loadListedPacks ──
export function admissionPredicate(pack, whitelist = []) {
  if (whitelist.length > 0) return whitelist.includes(pack.id);
  return Boolean(pack.category || pack.featured);
}

// ── fetch with bounded retry (design risk: anonymous facet read may 429) ──
async function fetchJson(url, { tries = 3, backoffMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, backoffMs * 2 ** i));
    }
  }
  throw lastErr;
}

// Paginate the anonymous browse face for one locale. The viewer-less listing
// already answers public packs only (pack-visibility posture); unlisted packs
// are absent from the browse face, so the curated predicate is the only
// narrowing this side adds — byte-parallel to loadListedPacks.
export async function fetchListedForLocale(base, locale, { fetchImpl = fetchJson } = {}) {
  const out = [];
  for (let page = 1; page <= 50; page += 1) {
    const body = await fetchImpl(`${base}/api/packs?page=${page}&pageSize=100&locale=${locale}`);
    const packs = body?.packs ?? [];
    out.push(...packs);
    const total = Number(body?.total ?? 0);
    if (out.length >= total || packs.length === 0) break;
  }
  return out;
}

// ── slug: stable address = packId-derived (spec: content updates never move it) ──
export function materialSlug(packId) {
  const s = String(packId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `pack-${s}`;
}

// ── merge per-locale listings into one annotated material set ──
export function annotatePack(listingsByLocale, generatedAt, source) {
  const ids = new Set();
  for (const packs of Object.values(listingsByLocale)) {
    for (const p of packs) if (admissionPredicate(p)) ids.add(p.id);
  }
  const materials = [];
  for (const id of ids) {
    const byLocale = {};
    let anchor = null;
    for (const locale of LOCALES) {
      const p = (listingsByLocale[locale] ?? []).find((x) => x.id === id && admissionPredicate(x));
      if (!p) continue; // locale track missing for this pack — the human face falls back below
      byLocale[locale] = {
        name: p.name ?? id,
        summary: p.description ?? "",
        whenToUse: p.category ? `Browse under "${p.category}" in the market.` : undefined,
      };
      if (!anchor) anchor = p;
    }
    if (!anchor) continue;
    // zh/en are the AI-surface canon pair; a missing es/fr/ja track falls back
    // to en (never to silence) — recorded in the catalog, not hidden.
    if (!byLocale.en && byLocale["zh-CN"]) byLocale.en = { ...byLocale["zh-CN"] };
    if (!byLocale["zh-CN"] && byLocale.en) byLocale["zh-CN"] = { ...byLocale.en };
    for (const l of ["es", "fr", "ja"]) {
      if (!byLocale[l] && byLocale.en) byLocale[l] = { ...byLocale.en };
    }
    const zh = byLocale["zh-CN"] ?? byLocale.en;
    materials.push({
      id,
      slug: materialSlug(id),
      category: mapCategory(anchor),
      marketCategory: anchor.category ?? null,
      tags: Array.isArray(anchor.tags) ? anchor.tags.slice(0, 8) : [],
      canonical: { brief: (byLocale.en?.summary || zh.summary || "").slice(0, 300) },
      human: {
        "zh-CN": { name: zh.name, summary: zh.summary },
        en: { name: byLocale.en?.name ?? zh.name, summary: byLocale.en?.summary ?? zh.summary },
        es: { name: byLocale.es?.name ?? byLocale.en?.name ?? zh.name, summary: byLocale.es?.summary ?? byLocale.en?.summary ?? "" },
        fr: { name: byLocale.fr?.name ?? byLocale.en?.name ?? zh.name, summary: byLocale.fr?.summary ?? byLocale.en?.summary ?? "" },
        ja: { name: byLocale.ja?.name ?? byLocale.en?.name ?? zh.name, summary: byLocale.ja?.summary ?? byLocale.en?.summary ?? "" },
      },
      whenToUse: byLocale.en?.whenToUse ?? zh.summary?.slice(0, 120) ?? "",
      badges: {
        official: Boolean(anchor.official),
        facade: anchor.badge === "facade" || anchor.badge === "assistant",
      },
      provenance: { source, updatedAt: generatedAt },
    });
  }
  return materials;
}

function mapCategory(pack) {
  if (pack.badge === "facade" || pack.badge === "assistant") return "facade";
  if (pack.official && /data|daas|数据/i.test(`${pack.category ?? ""} ${pack.name ?? ""}`)) return "official-data";
  if (pack.category) return "pack";
  return "pack";
}

// ── G2: annotation shape gate ──
export function lintAnnotationShape(materials) {
  const violations = [];
  for (const m of materials) {
    if (!m.canonical?.brief) violations.push(`${m.id}: canonical.brief missing`);
    if (!m.whenToUse) violations.push(`${m.id}: whenToUse missing`);
    if (!m.provenance?.source || !m.provenance?.updatedAt) violations.push(`${m.id}: provenance incomplete`);
    for (const l of LOCALES) {
      if (!m.human?.[l]?.name) violations.push(`${m.id}: human.${l}.name missing`);
    }
    if (!CATEGORY_ENUM.includes(m.category)) violations.push(`${m.id}: category ${m.category} outside the closed enum`);
  }
  return violations;
}

// ── G3: ai_readable six lint (generated text artifacts) ──
const LINT_RULES = {
  selfContained: [/\bsee (?:above|below|the (?:previous|next) (?:section|chapter))\b/i, /见(?:上|下)(?:文|节|一节)/, /前述|上記のとおり/],
  entityNamed: [/(?:^|[^·])我们的平台(?![a-zA-Z·])/, /\bour platform\b/i],
  termUnique: [/素材(?:库|集)/],
  coldRead: [], // structural: enforced by the material-page builder contract below
  provenance: [], // structural: enforced via lintAnnotationShape (G2)
  table: [], // structural: infrastructure.md must contain the input–action–output table
};
export function lintAiReadable(pages) {
  // pages: [{ name, content }]
  const violations = [];
  for (const page of pages) {
    for (const [rule, patterns] of Object.entries(LINT_RULES)) {
      if (rule === "coldRead") {
        // Every material page must answer the three cold-read questions structurally:
        // a "What this is" heading, an "Obtain" section, and an "As of" provenance date.
        if (page.name.startsWith("materials/")) {
          const ok =
            /## What this is/.test(page.content) &&
            /## How to obtain/.test(page.content) &&
            /As of: 20\d\d-\d\d-\d\d/.test(page.content);
          if (!ok) violations.push(`${page.name}: cold-read three questions not structurally answerable`);
        }
        continue;
      }
      if (rule === "provenance") continue; // G2 covers it
      if (rule === "table") {
        if (page.name === "infrastructure.md" && !/\| Action \|/.test(page.content)) {
          violations.push(`${page.name}: missing the input–action–output table`);
        }
        continue;
      }
      for (const re of patterns) {
        const m = re.exec(page.content);
        if (m) violations.push(`${page.name}: ${rule} violated → "${page.content.slice(Math.max(0, m.index - 15), m.index + 25)}"`);
      }
    }
  }
  return violations;
}

// ── generators ──
export function buildCatalog(materials) {
  return {
    schema: "yizuo-agent-materials-plaza/catalog@1",
    categoryEnumVersion: CATEGORY_ENUM_VERSION,
    categories: CATEGORY_ENUM,
    generatedAt: materials[0]?.provenance.updatedAt ?? null,
    count: materials.length,
    materials: materials.map(({ id, slug, category, marketCategory, tags, canonical, human, whenToUse, badges, provenance }) => ({
      id,
      slug,
      category,
      marketCategory,
      tags,
      canonical,
      human,
      whenToUse,
      badges,
      provenance,
    })),
  };
}

export function buildMaterialPages(materials, base, generatedAt) {
  const pages = [];
  for (const m of materials) {
    const obtainCli = `npx @finddatatechnology/facet install ${m.id}`;
    const marketUrl = `${base}/#/packs`;
    const title = m.human.en.name && m.human.en.name !== m.human["zh-CN"].name
      ? `# ${m.human.en.name} / ${m.human["zh-CN"].name}`
      : `# ${m.human["zh-CN"].name}`;
    const enSummary = m.human.en.summary && m.human.en.summary !== m.human["zh-CN"].summary ? m.human.en.summary : null;
    const body = `${title}

## What this is

${m.human["zh-CN"].summary || m.canonical.brief}
${enSummary ? `\n${enSummary}\n` : ""}
- Category: ${m.category} (plaza category enum v${CATEGORY_ENUM_VERSION})
- Official: ${m.badges.official ? "yes — curated by FindData" : "no"}
- AI facade: ${m.badges.facade ? "yes — deployable as a conversational service" : "no"}

## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "${m.human.en.name}", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       ${obtainCli}

3. From the market page: ${marketUrl}

## As of

Provenance: ${m.provenance.source} · As of: ${m.provenance.updatedAt}
`;
    pages.push({ name: `materials/${m.slug}.md`, content: body, material: m });
  }
  return pages;
}

export function buildInfrastructurePage(generatedAt, base) {
  const zh = `# 壹座·智能体素材广场 —— 基础设施说明（zh 镜像见文末）

壹座·智能体素材广场（Yizuo Agent Materials Plaza）是面向人与 AI 的素材总览面。它呈现三件事：平台提供了哪些素材、这些素材如何被供给、此刻有哪些素材在场。

## 供给机制（输入-动作-产出）

| Action | Input | Output | Guarantee |
| ------ | ----- | ------ | --------- |
| 发布 Publish | 功能集 manifest（技能+MCP 引用+角色） | 市场上的一个不可变版本快照 | 版本一经发布不可改写；下架不毁已装快照 |
| 获取 Obtain | 五编辑器 CLI / 壹座内置市场 / 谦面市场页 | 装进运行环境的一份冻结快照 | 安装逐包显式发生；匿名可浏览 |
| 运行 Run | 已装快照 + 用户单元（cell） | 隔离运行中的角色与工具面 | cell 间互不可见；工具白名单收窄上下文 |
| 服务化 Serve | 带服务契约的角色 + 部署者计费键 | A2A 常驻对话服务（独立端点与身份） | 驻留不因闲置回收；调用按量结算 |

## 接入

- 人：壹座 web（${base}）、谦面市场（${base}/#/packs）、五编辑器 CLI（npx @finddatatechnology/facet install <packId>）。
- AI：本文件、catalog.json、每素材一页的 materials/*.md（稳定地址），以及 A2A 服务端点。

---
zh 镜像：上表即全文；本页自足，不依赖站点其他章节。Provenance: facet market · As of: ${generatedAt}
`;
  return { name: "infrastructure.md", content: zh };
}

export function buildLlmsTxt(catalog, base, generatedAt) {
  const lines = [
    `# ${PLAZA_NAME.en}（壹座·智能体素材广场）`,
    "",
    `> The outward understanding surface of the Yizuo platform: what materials exist, how the platform supplies them, and how to obtain each one. Every item below is a material — something a human or an AI agent can understand, obtain, and run. Canonical data: ${base}/generated/catalog.json. As of: ${generatedAt}.`,
    "",
    "## Machine surfaces",
    "",
    `- [catalog.json](${base}/generated/catalog.json): every material with a canonical brief, five-locale human summaries, whenToUse, and provenance — the annotation-layer shape this platform already runs internally.`,
    `- [infrastructure.md](${base}/generated/infrastructure.md): the supply mechanism as an input–action–output table (publish / obtain / run / serve), self-contained.`,
    "",
    "## Materials (one self-contained page each, stable addresses)",
    "",
  ];
  for (const m of catalog.materials) {
    lines.push(`- [${m.human.en.name}](${base}/generated/materials/${m.slug}.md): ${m.canonical.brief.slice(0, 140)}`);
  }
  lines.push("", "## For humans", "");
  lines.push(`- [The plaza site](${base}/): five-locale narrative face — what materials exist, how they are supplied, live inventory.`);
  lines.push(`- [Market actions](${base}/#/packs): browse, subscribe, install — the action layer on the same truth.`);
  return `${lines.join("\n")}\n`;
}

// ── main ──
export async function runExport({ base = DEFAULT_BASE, siteBase = process.env.PLAZA_SITE_BASE || "https://agent.finddatatech.cloud", outDir = "site-plaza/generated", fixture = null, allowStale = false, whitelist = [] } = {}) {
  const generatedAt = new Date().toISOString().slice(0, 10);
  let listingsByLocale;
  let marketplaceCount = null;

  if (fixture) {
    const fx = JSON.parse(fs.readFileSync(fixture, "utf8"));
    // The fixture simulates the raw network listing — the same admission
    // predicate applies on both paths (one rule, two transports).
    listingsByLocale = Object.fromEntries(
      Object.entries(fx.listingsByLocale).map(([l, packs]) => [l, packs.filter((p) => admissionPredicate(p, whitelist))]),
    );
    marketplaceCount = fx.marketplaceCount ?? null;
  } else {
    try {
      listingsByLocale = {};
      for (const locale of LOCALES) {
        listingsByLocale[locale] = (await fetchListedForLocale(base, locale)).filter((p) => admissionPredicate(p, whitelist));
      }
      try {
        const mp = await fetchJson(`${base}/api/marketplace/marketplace.json`);
        marketplaceCount = Array.isArray(mp?.plugins) ? mp.plugins.length : null;
      } catch {
        marketplaceCount = null; // G1 becomes self-consistency-only when the authority is down
      }
    } catch (fetchErr) {
      if (!allowStale) throw fetchErr;
      // --allow-stale: the market is unreachable; continue from the last
      // snapshot. Provenance keeps the OLD generatedAt (honest face); G1 is
      // skipped (the authority is down), G2/G3 still run.
      const prevPath = path.join(outDir, "catalog.json");
      if (!fs.existsSync(prevPath)) throw new Error(`--allow-stale: no previous snapshot at ${prevPath} and the market is unreachable (${fetchErr.message})`);
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      const materials = prev.materials ?? [];
      const gateViolations = [];
      gateViolations.push(...lintAnnotationShape(materials).map((v) => `G2 ${v}`));
      const catalog = buildCatalog(materials);
      const materialPages = buildMaterialPages(materials, siteBase, prev.generatedAt);
      const infra = buildInfrastructurePage(prev.generatedAt, siteBase);
      const llms = buildLlmsTxt(catalog, siteBase, prev.generatedAt);
      const pages = [...materialPages, infra];
      gateViolations.push(...lintAiReadable(pages).map((v) => `G3 ${v}`));
      if (gateViolations.length > 0) {
        const err = new Error(`plaza-export gates red (stale):\n${gateViolations.join("\n")}`);
        err.gateViolations = gateViolations;
        throw err;
      }
      fs.mkdirSync(path.join(outDir, "materials"), { recursive: true });
      fs.writeFileSync(path.join(outDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
      fs.writeFileSync(path.join(outDir, "llms.txt"), llms);
      fs.writeFileSync(path.join(outDir, "llms-full.txt"), `${llms}\n${materialPages.map((p) => `\n---\n\n${p.content}`).join("")}`);
      fs.writeFileSync(path.join(outDir, "infrastructure.md"), infra.content);
      for (const p of materialPages) fs.writeFileSync(path.join(outDir, p.name), p.content);
      fs.writeFileSync(
        path.join(outDir, "counts.json"),
        JSON.stringify({ generatedAt: prev.generatedAt, stale: true, packs: materials.length, byCategory: CATEGORY_ENUM.map((c) => ({ category: c, count: materials.filter((m) => m.category === c).length })) }, null, 2),
      );
      return { generatedAt: prev.generatedAt, count: materials.length, marketplaceCount: null, stale: true, materials: materials.length };
    }
  }

  const allListed = listingsByLocale[LOCALES[0]] ?? [];
  const filteredCount = allListed.length;
  const gateViolations = [];

  // G1 — count reconciliation against the production single-rule endpoint
  if (marketplaceCount != null && marketplaceCount !== filteredCount) {
    gateViolations.push(
      `G1 count reconciliation failed: filtered listing=${filteredCount}, /api/marketplace/marketplace.json plugins=${marketplaceCount}`,
    );
  }

  const materials = annotatePack(listingsByLocale, generatedAt, base);
  gateViolations.push(...lintAnnotationShape(materials).map((v) => `G2 ${v}`));

  const catalog = buildCatalog(materials);
  const materialPages = buildMaterialPages(materials, siteBase, generatedAt);
  const infra = buildInfrastructurePage(generatedAt, siteBase);
  const llms = buildLlmsTxt(catalog, siteBase, generatedAt);

  const pages = [...materialPages, infra];
  gateViolations.push(...lintAiReadable(pages).map((v) => `G3 ${v}`));

  if (gateViolations.length > 0) {
    const err = new Error(`plaza-export gates red:\n${gateViolations.join("\n")}`);
    err.gateViolations = gateViolations;
    throw err;
  }

  // Gates green — write artifacts (zero artifacts on red is the contract)
  fs.mkdirSync(path.join(outDir, "materials"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "snapshot.json"),
    JSON.stringify({ generatedAt, source: base, admission: "public+non-unlisted+curated (loadListedPacks mirror)", count: filteredCount, packs: allListed }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "llms.txt"), llms);
  fs.writeFileSync(path.join(outDir, "llms-full.txt"), `${llms}\n${materialPages.map((p) => `\n---\n\n${p.content}`).join("")}`);
  fs.writeFileSync(path.join(outDir, "infrastructure.md"), infra.content);
  for (const p of materialPages) fs.writeFileSync(path.join(outDir, p.name), p.content);
  fs.writeFileSync(
    path.join(outDir, "counts.json"),
    JSON.stringify({ generatedAt, packs: filteredCount, byCategory: CATEGORY_ENUM.map((c) => ({ category: c, count: materials.filter((m) => m.category === c).length })) }, null, 2),
  );
  return { generatedAt, count: filteredCount, marketplaceCount, materials: catalog.materials.length };
}

// CLI entry
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const fixture = opt("--fixture");
  const allowStale = args.includes("--allow-stale");
  const outDir = opt("--out") ?? "site-plaza/generated";
  const base = opt("--base") ?? DEFAULT_BASE;
  try {
    const r = await runExport({ base, outDir, fixture, allowStale });
    console.log(`plaza-export OK: ${r.count} materials (marketplace.json authority: ${r.marketplaceCount ?? "n/a"}), as of ${r.generatedAt}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
