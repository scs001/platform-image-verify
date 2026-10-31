#!/usr/bin/env node
// ── Agent Studio source-contract tests (add-agent-studio 2.x/3.x/5.x) ────────
//
// Pins the studio's structural contract by source assertion (repo convention:
// node --test + source reads; behavior rides e2e/walkthrough):
//   1. compose-time validation rides the EXISTING publish-gate dry-run
//      endpoint — no client-side validator, no lib import in web code
//   2. emit re-validates before writing (defense in depth, per spec)
//   3. the right pane renders through the SHARED AgentSpecSheet; the team tab
//      through the read-only FleetGraph (no edge authoring affordances)
//   4. MCP references come from the catalog picker only — no free-form
//      registryName text entry anywhere in the page
//   5. the working document is client state (no studio store import)
//   6. route + entry point wired (App.tsx /studio, AgentsPage link)
//   7. i18n: studio.* chrome keys exist in all five locales
//
//   node --test scripts/test-agent-studio.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const page = read("web/src/pages/AgentStudioPage.tsx");
const app = read("web/src/App.tsx");
const agentsPage = read("web/src/pages/AgentsPage.tsx");

test("compose-time validation is the existing publish-gate dry-run, never a client validator", () => {
  assert.match(page, /\/api\/packs\/validate/, "the studio calls POST /api/packs/validate");
  assert.ok(!page.includes("lib/pack-manifest"), "no lib import in web code");
  assert.ok(!/validatePackManifest/.test(page), "no validator re-implementation");
  assert.match(page, /debounce|setTimeout/, "validation is debounced");
});

test("emit re-validates before writing", () => {
  for (const [fn, write] of [["emitPreset", "createCustomPreset"], ["emitDraft", "createPackDraft"]]) {
    const start = page.indexOf(`const ${fn} = async`);
    const end = page.indexOf("};", start);
    const body = page.slice(start, end);
    assert.match(body, /\/api\/packs\/validate/, `${fn}: pre-emit validation call present`);
    assert.ok(body.indexOf("/api/packs/validate") < body.indexOf(write), `${fn}: validate runs before the write`);
  }
});

test("presentation is the shared sheet; the team graph is read-only", () => {
  assert.match(page, /<AgentSpecSheet/, "right pane consumes the shared spec sheet");
  assert.match(page, /<FleetGraph/, "team tab renders FleetGraph");
  assert.match(page, /readOnlyHint/, "the read-only hint is present");
  // No edge-authoring affordances: the page never calls an edge-add handler
  // and FleetGraph receives plain data props.
  assert.ok(!/onAddEdge|onEdgesChange|addEdge\(/.test(page), "no graph edge authoring");
});

test("MCP references are picker-only (no free-form registryName entry)", () => {
  assert.match(page, /studio-mcp-add/, "the picker select exists");
  // Every mcpServers mutation derives its registryName from the catalog
  // (select onChange) — no text Input bound to registryName.
  assert.ok(!/registryName[:=]\s*[a-z]*\.target\.value/.test(page), "no input binds registryName from typed text");
});

test("the working document is client state — no second store", () => {
  assert.match(page, /useState<StudioDoc>\(emptyDoc\)/, "document lives in component state");
  assert.ok(!/useChatStore|zustand/.test(page), "no store import for the working document");
});

test("route and entry point are wired", () => {
  assert.match(app, /path="\/studio"/, "App.tsx mounts /studio");
  assert.match(app, /AgentStudioPage = lazy/, "lazy-loaded like the other work surfaces");
  assert.match(agentsPage, /agents-studio-link/, "AgentsPage carries the entry link");
});

test("i18n: studio chrome keys exist in all five locales", () => {
  for (const loc of ["zh-CN", "en", "ja", "fr", "es"]) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    const s = d.studio;
    assert.ok(s, `${loc}: studio block present`);
    for (const k of ["title", "roster", "canvas", "agent", "doc", "skill", "mcp", "team", "validate", "emit", "remove"]) {
      assert.ok(s[k] !== undefined, `${loc}: studio.${k} present`);
    }
    assert.ok(typeof d.agentsPage?.studio === "string" && d.agentsPage.studio.length > 0, `${loc}: agentsPage.studio present`);
  }
});
