// plaza-export gate tests (add-agent-materials-plaza): the six-lint, the
// annotation shape gate, the count reconciliation gate, and the slug/address
// stability contract — driven on fixtures, no network.
//
// Run: node --test scripts/test-plaza-export.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admissionPredicate,
  annotatePack,
  buildCatalog,
  buildInfrastructurePage,
  buildLlmsTxt,
  buildMaterialPages,
  lintAiReadable,
  lintAnnotationShape,
  materialSlug,
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

const fixtureListings = (locale) => {
  const packs = [
    mkPack("alpha-suite", { featured: true, official: true }),
    mkPack("beta-facade", { badge: "facade", category: "company" }),
    mkPack("gamma-private", { category: null, featured: false }), // fails the predicate
  ];
  return locale === "en" ? packs : packs.map((p) => ({ ...p, name: `${p.name} (${locale})`, description: `${p.description} [${locale}]` }));
};

const listingsByLocale = Object.fromEntries(["zh-CN", "en", "es", "fr", "ja"].map((l) => [l, fixtureListings(l)]));

test("admission predicate mirrors loadListedPacks: public+non-unlisted+curated, whitelist replaces", () => {
  assert.equal(admissionPredicate(mkPack("a", { category: "x" })), true);
  assert.equal(admissionPredicate(mkPack("a", { featured: true })), true);
  assert.equal(admissionPredicate(mkPack("a", { category: null, featured: false })), false);
  assert.equal(admissionPredicate(mkPack("a", { category: null, featured: false }), ["a"]), true);
});

test("slug is packId-derived and stable across content updates", () => {
  assert.equal(materialSlug("Alpha_Suite 2"), "pack-alpha-suite-2");
  assert.equal(materialSlug("beta"), "pack-beta");
  // stability: the same id always maps to the same slug regardless of content
  assert.equal(materialSlug("beta"), materialSlug("beta"));
});

test("annotation shape gate: complete entries pass, missing provenance/category red", () => {
  const materials = annotatePack(listingsByLocale, genAt, "fixture://facet");
  assert.equal(materials.length, 2, "gamma-private must be held out by the predicate");
  assert.deepEqual(lintAnnotationShape(materials), [], "complete entries pass G2");
  const broken = structuredClone(materials);
  delete broken[0].provenance.updatedAt;
  assert.ok(lintAnnotationShape(broken).some((v) => v.includes("provenance")), "G2 catches missing provenance");
  broken[0].provenance = { source: "x", updatedAt: genAt };
  broken[0].category = "fleet"; // outside the closed enum
  assert.ok(lintAnnotationShape(broken).some((v) => v.includes("closed enum")), "G2 catches enum escape");
});

test("catalog carries the production annotation shape with zero new vocabulary", () => {
  const catalog = buildCatalog(annotatePack(listingsByLocale, genAt, "fixture://facet"));
  assert.equal(catalog.schema, "yizuo-agent-materials-plaza/catalog@1");
  const m = catalog.materials[0];
  for (const key of ["canonical", "human", "whenToUse", "provenance"]) assert.ok(m[key], `${key} present`);
  for (const l of ["zh-CN", "en", "es", "fr", "ja"]) assert.ok(m.human[l]?.name, `human.${l}.name present`);
  assert.ok(m.provenance.source && m.provenance.updatedAt);
});

test("ai_readable lint: self-containment, entity naming, term uniqueness, cold-read, table", () => {
  const materials = annotatePack(listingsByLocale, genAt, "fixture://facet");
  const pages = [...buildMaterialPages(materials, "https://x", genAt), buildInfrastructurePage(genAt, "https://x")];
  assert.deepEqual(lintAiReadable(pages), [], "well-formed pages pass G3");

  const bad = structuredClone(pages);
  bad[0].content += "\nSee the previous section for details.\n";
  assert.ok(lintAiReadable(bad).some((v) => v.includes("selfContained")), "cross-section reference red");

  const bad2 = structuredClone(pages);
  bad2[0].content = bad2[0].content.replace(/## What this is/, "## Overview");
  assert.ok(lintAiReadable(bad2).some((v) => v.includes("cold-read")), "missing cold-read structure red");

  const bad3 = structuredClone(pages);
  bad3.at(-1).content = bad3.at(-1).content.replace(/\| Action \|/, "| 行为 |");
  assert.ok(lintAiReadable(bad3).some((v) => v.includes("table")), "infrastructure page without the table red");
});

test("llms.txt: every line's link resolves to a generated artifact name and carries a summary", () => {
  const materials = annotatePack(listingsByLocale, genAt, "fixture://facet");
  const catalog = buildCatalog(materials);
  const txt = buildLlmsTxt(catalog, "https://x", genAt);
  for (const m of materials) {
    assert.ok(txt.includes(`materials/${m.slug}.md`), `llms.txt links ${m.slug}`);
  }
  assert.ok(txt.includes("canonical brief"), "index describes the annotation shape");
  assert.ok(txt.includes(`As of: ${genAt}`), "index carries the as-of date");
});

test("count reconciliation gate: filtered count != marketplace.json count red, zero artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-export-"));
  const fixture = path.join(dir, "fixture.json");
  fs.writeFileSync(
    fixture,
    JSON.stringify({ listingsByLocale, marketplaceCount: 99 }), // truth says 2, authority says 99
  );
  await assert.rejects(
    () => runExport({ fixture, outDir: path.join(dir, "gen") }),
    (err) => err.message.includes("G1 count reconciliation failed") && err.message.includes("99"),
  );
  assert.equal(fs.existsSync(path.join(dir, "gen", "catalog.json")), false, "zero artifacts on red");
});

test("full export on green fixture writes all six artifact kinds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaza-export-"));
  const fixture = path.join(dir, "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify({ listingsByLocale, marketplaceCount: 2 }));
  const r = await runExport({ fixture, outDir: path.join(dir, "gen") });
  assert.equal(r.count, 2);
  for (const f of ["snapshot.json", "catalog.json", "llms.txt", "llms-full.txt", "infrastructure.md", "counts.json"]) {
    assert.ok(fs.existsSync(path.join(dir, "gen", f)), `${f} written`);
  }
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "pack-alpha-suite.md")));
  assert.ok(fs.existsSync(path.join(dir, "gen", "materials", "pack-beta-facade.md")));
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "gen", "catalog.json"), "utf8"));
  assert.equal(cat.count, 2);
  assert.equal(cat.categoryEnumVersion, 1);
});
