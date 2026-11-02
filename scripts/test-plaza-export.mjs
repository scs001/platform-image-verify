// plaza-export gate tests (add-agent-materials-plaza v2): the six-lint, the
// annotation shape gate, the per-source count reconciliation gates, species
// pages, and the slug/address stability contract — driven on fixtures, no
// network.
//
// Run: node --test scripts/test-plaza-export.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admissionPredicate,
  annotatePack,
  annotateSkill,
  annotateMcp,
  buildCatalog,
  buildInfrastructurePage,
  buildLlmsTxt,
  buildMaterialPages,
  lintAiReadable,
  lintAnnotationShape,
  materialSlug,
  speciesSlug,
  runExport,
} from "./plaza-export.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const genAt = "2026-11-03";
const mkPack = (id, over = {}) => ({
  id,
  name: `Pack ${id}`,
  description: `Material ${id}: a versioned bundle of skills, MCP references, and personas.`,
  category: "demo",
  featured: false,
  official: false,
  badge: null,
  ...over,
});

const mkFixture = () => {
  const packs = [
    mkPack("alpha-suite", { featured: true, official: true, manifest: { skills: [{ name: "alpha-skill", description: "bundled skill" }], mcpServers: [{ registryName: "eco-mcp-fetch" }] } }),
    mkPack("beta-facade", { badge: "facade", category: "company" }),
    mkPack("gamma-private", { category: null, featured: false }), // fails the predicate
  ];
  const listingsByLocale = Object.fromEntries(
    ["zh-CN", "en", "es", "fr", "ja"].map((l) => [
      l,
      l === "en" ? packs : packs.map((p) => ({ ...p, name: `${p.name} (${l})`, description: `${p.description} [${l}]` })),
    ]),
  );
  const skills = [
    { name: "contract-review", displayName: "contract-review", description: "中文合同审查:风险维度系统审查商事合同条款", tags: ["法律"], version: "1.0.0", repositoryUrl: null },
    { name: "financial-statement-analysis", description: "上市公司财报分析:三表联动+比率分析", tags: ["金融"] },
  ];
  const mcpZh = [
    { name: "eco-mcp-fetch", displayName: "eco-mcp-fetch", description: "Fetch content from any URL — no configuration needed", endpoint: "https://mcp.example/eco-mcp-fetch/mcp", requiredGroups: [],
      annotation: { name: "网页抓取（托管版）", summary: "托管在平台上的网页抓取：取回指定网址内容并转成可读文本。", whenToUse: "不想在本机装进程时。", source: "finddata-supply-annotations" } },
    { name: "fd-daas-mcp", displayName: "fd-daas-mcp", description: "FindData data MCP: macro and financial real sources", endpoint: "https://mcp.example/fd-daas-mcp/mcp", requiredGroups: [] },
  ];
  const mcpEn = mcpZh.map((s) => s.name === "eco-mcp-fetch"
    ? { ...s, annotation: { name: "Web fetch (hosted)", summary: "Hosted web fetch: retrieve a URL's content.", whenToUse: "When you want page content without installing anything.", source: "finddata-supply-annotations" } }
    : s);
  return {
    listingsByLocale,
    skills,
    mcpServers: mcpZh,
    mcpByLocale: { "zh-CN": mcpZh, en: mcpEn },
    mcpDepths: {
      "eco-mcp-fetch": { name: "eco-mcp-fetch", tools: [{ name: "fetch", description: "Fetches a URL" }], toolCount: 1, license: "MIT", providerOrganization: "modelcontextprotocol", tags: [] },
      "fd-daas-mcp": { name: "fd-daas-mcp", tools: [{ name: "macro_query", description: "Query macro series" }, { name: "stock_query", description: "Query stock series" }], toolCount: 2, license: null, providerOrganization: "FindData", tags: ["数据"] },
    },
    marketplaceCount: 2,
  };
};

const listFromFixture = (fx) => fx.listingsByLocale;

test("admission predicate mirrors loadListedPacks: public+non-unlisted+curated, whitelist replaces", () => {
  assert.equal(admissionPredicate(mkPack("a", { category: "x" })), true);
  assert.equal(admissionPredicate(mkPack("a", { featured: true })), true);
  assert.equal(admissionPredicate(mkPack("a", { category: null, featured: false })), false);
  assert.equal(admissionPredicate(mkPack("a", { category: null, featured: false }), ["a"]), true);
});

test("slug is species-namespaced and stable across content updates", () => {
  assert.equal(materialSlug("Alpha_Suite 2"), "pack-alpha-suite-2");
  assert.equal(speciesSlug("skill", "contract-review"), "skill-contract-review");
  assert.equal(speciesSlug("mcp", "eco-mcp-fetch"), "mcp-eco-mcp-fetch");
  // stability: the same species+id always maps to the same slug
  assert.equal(speciesSlug("skill", "x"), speciesSlug("skill", "x"));
  // no cross-registry collision: same id in different species → different pages
  assert.notEqual(speciesSlug("pack", "fetch"), speciesSlug("mcp", "fetch"));
});

test("skills annotate honestly: zh verbatim in all five slots, provenance names the skills source", () => {
  const fx = mkFixture();
  const m = annotateSkill(fx.skills[0], genAt, "fixture://skills-catalog");
  assert.equal(m.category, "skill");
  for (const l of ["zh-CN", "en", "es", "fr", "ja"]) {
    assert.equal(m.human[l].summary, fx.skills[0].description, `${l} carries the zh source verbatim (no fabricated translation)`);
  }
  assert.equal(m.provenance.source, "fixture://skills-catalog");
  assert.ok(m.whenToUse.includes("法律"), "tags inform whenToUse");
});

test("MCP annotation projects per locale and the tool surface rides the entry", () => {
  const fx = mkFixture();
  const pick = (loc) => fx.mcpByLocale[loc].find((s) => s.name === "eco-mcp-fetch");
  const m = annotateMcp(
    Object.fromEntries(["zh-CN", "en"].map((l) => [l, pick(l)])),
    fx.mcpDepths["eco-mcp-fetch"],
    genAt,
    "fixture://mcp-catalog",
  );
  assert.equal(m.category, "mcp");
  assert.equal(m.human["zh-CN"].name, "网页抓取（托管版）");
  assert.equal(m.human.en.name, "Web fetch (hosted)");
  assert.equal(m.toolCount, 1);
  assert.equal(m.license, "MIT");
  assert.deepEqual(m.tools.map((t) => t.name), ["fetch"]);
  assert.ok(m.endpoint);
});

test("pack contents enumerate the manifest's own skills and MCP references", () => {
  const fx = mkFixture();
  const listings = listFromFixture(fx);
  for (const p of listings["zh-CN"]) {
    if (p.id === "alpha-suite") p.contents = { skills: [{ name: "alpha-skill", description: "bundled skill" }], mcpServers: [{ registryName: "eco-mcp-fetch" }] };
  }
  const materials = annotatePack(listings, genAt, "fixture://facet");
  const alpha = materials.find((m) => m.id === "alpha-suite");
  assert.deepEqual(alpha.contents.skills, [{ name: "alpha-skill", description: "bundled skill" }]);
  assert.deepEqual(alpha.contents.mcpServers, [{ registryName: "eco-mcp-fetch" }]);
});

test("annotation shape gate: complete entries pass, missing provenance/category red", () => {
  const fx = mkFixture();
  const materials = [
    ...annotatePack(listFromFixture(fx), genAt, "fixture://facet"),
    ...fx.skills.map((s) => annotateSkill(s, genAt, "fixture://skills-catalog")),
    ...fx.mcpServers.map((s) => annotateMcp({ "zh-CN": s }, fx.mcpDepths[s.name], genAt, "fixture://mcp-catalog")),
  ];
  assert.equal(materials.length, 6, "2 packs (predicate) + 2 skills + 2 mcp");
  assert.deepEqual(lintAnnotationShape(materials), [], "complete entries pass G2");
  const broken = structuredClone(materials);
  delete broken[0].provenance.updatedAt;
  assert.ok(lintAnnotationShape(broken).some((v) => v.includes("provenance")), "G2 catches missing provenance");
  broken[0].provenance = { source: "x", updatedAt: genAt };
  broken[0].category = "fleet";
  assert.ok(lintAnnotationShape(broken).some((v) => v.includes("closed enum")), "G2 catches enum escape");
});

test("ai_readable lint: cold-read applies to ALL species pages, table on infrastructure", () => {
  const fx = mkFixture();
  const materials = [
    ...annotatePack(listFromFixture(fx), genAt, "fixture://facet"),
    ...fx.skills.map((s) => annotateSkill(s, genAt, "fixture://skills-catalog")),
    ...fx.mcpServers.map((s) => annotateMcp({ "zh-CN": s }, fx.mcpDepths[s.name], genAt, "fixture://mcp-catalog")),
  ];
  const pages = [...buildMaterialPages(materials, "https://x", genAt), buildInfrastructurePage(genAt, "https://x")];
  assert.deepEqual(lintAiReadable(pages), [], "well-formed pages of every species pass G3");
  const bad = structuredClone(pages);
  bad.find((p) => p.name.includes("skill-")).content = bad.find((p) => p.name.includes("skill-")).content.replace(/## How to obtain/, "## Usage");
  assert.ok(lintAiReadable(bad).some((v) => v.includes("cold-read")), "skill page without obtain section red");
});

test("species pages embed their specifics: mcp tools, skill obtain, pack contents", () => {
  const fx = mkFixture();
  const materials = [
    ...annotatePack(listFromFixture(fx), genAt, "fixture://facet"),
    ...fx.skills.map((s) => annotateSkill(s, genAt, "fixture://skills-catalog")),
    ...fx.mcpServers.map((s) => annotateMcp({ "zh-CN": s }, fx.mcpDepths[s.name], genAt, "fixture://mcp-catalog")),
  ];
  const pages = buildMaterialPages(materials, "https://x", genAt);
  const mcpPage = pages.find((p) => p.name.includes("mcp-eco-mcp-fetch"));
  assert.ok(mcpPage.content.includes("fetch"), "tool name on the page");
  assert.ok(/Public tools: 1/.test(mcpPage.content), "toolCount on the page");
  assert.ok(mcpPage.content.includes("Extensions → MCP"), "mcp obtain = connect path");
  const skillPage = pages.find((p) => p.name.includes("skill-contract-review"));
  assert.ok(skillPage.content.includes("Extensions → Skills"), "skill obtain = extensions face");
  const packPage = pages.find((p) => p.name.includes("pack-alpha-suite"));
  assert.ok(packPage.content.includes("## What it contains"), "pack page enumerates contents");
  assert.ok(packPage.content.includes("alpha-skill"), "bundled skill named");
  assert.ok(packPage.content.includes("eco-mcp-fetch"), "mcp reference named");
});

test("count reconciliation gate: any species mismatch red, zero artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-export-"));
  const fixture = path.join(dir, "fixture.json");
  const fx = mkFixture();
  fx.skills = [...fx.skills, { description: "malformed registry entry without a name — annotator skips it, G1 must see the drop", tags: [] }];
  fs.writeFileSync(fixture, JSON.stringify(fx));
  await assert.rejects(
    () => runExport({ fixture, outDir: path.join(dir, "gen") }),
    (err) => err.message.includes("G1 skills"),
  );
  assert.equal(fs.existsSync(path.join(dir, "gen", "catalog.json")), false, "zero artifacts on red");
});

test("full export on green fixture writes all artifact kinds with three species", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-export-"));
  const fixture = path.join(dir, "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify(mkFixture()));
  const r = await runExport({ fixture, outDir: path.join(dir, "gen") });
  assert.deepEqual(r.counts, { packs: 2, skills: 2, mcpServers: 2, tools: 3 });
  for (const f of ["snapshot.json", "catalog.json", "llms.txt", "llms-full.txt", "infrastructure.md", "counts.json", "skills-snapshot.json"]) {
    assert.ok(fs.existsSync(path.join(dir, "gen", f)), `${f} written`);
  }
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "skill-contract-review.md")));
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "mcp-eco-mcp-fetch.md")));
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "gen", "catalog.json"), "utf8"));
  assert.equal(cat.schema, "yizuo-agent-materials-plaza/catalog@2");
  assert.equal(cat.count, 6);
  const llms = fs.readFileSync(path.join(dir, "gen", "llms.txt"), "utf8");
  assert.ok(llms.includes("## Skills (2)"), "skills section in the index");
  assert.ok(llms.includes("## MCP servers (2 — 3 public tools embedded per page)"), "mcp section with tool total");
});
