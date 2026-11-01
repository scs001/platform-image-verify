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
  // The picker lives in the SHARED editor (one editor, two hosts).
  assert.match(bucketsEditor, /mcp-add/, "the picker select exists in the shared editor");
  for (const host of [page, teamMode]) {
    // Every mcpServers mutation derives its registryName from the catalog
    // (select onChange) — no text Input bound to registryName.
    assert.ok(!/registryName[:=]\s*[a-z]*\.target\.value/.test(host), "no input binds registryName from typed text");
  }
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

// ── fold-blueprint-into-studio ────────────────────────────────────────────────
const teamMode = read("web/src/components/studio/BlueprintTeamMode.tsx");
const bucketsEditor = read("web/src/components/studio/AgentBucketsEditor.tsx");

test("fold: blueprint team mode rides the existing lifecycle endpoints, untouched", () => {
  // Same /api/blueprints pool + lifecycle calls — no second lifecycle, no
  // server changes in this change at all.
  const calls = bpCalls(teamMode);
  for (const fn of ["validateBlueprint", "approveBlueprint", "castBlueprint", "runTrial", "updateBlueprint", "listBlueprints"]) {
    assert.ok(calls.includes(fn), `team mode uses bp.${fn} (existing lifecycle face)`);
  }
  assert.ok(!teamMode.includes("castPackId: "), "no direct pack minting from the studio");
});

function bpCalls(src) {
  return [...src.matchAll(/bp\.(\w+)/g)].map((m) => m[1]);
}

test("fold: three buckets render through the SHARED editor (one editor, two hosts)", () => {
  assert.match(teamMode, /<AgentBucketsEditor/, "blueprint team mode consumes the shared editor");
  assert.match(page, /<AgentBucketsEditor/, "the studio canvas consumes the shared editor");
  assert.ok(!/showSkills=\{true\}/.test(teamMode), "blueprints carry no skills bucket");
});

test("fold: JSON track never bypasses validation (dual-track, save→validate)", () => {
  const save = teamMode.slice(teamMode.indexOf("const saveAndValidate"), teamMode.indexOf("};", teamMode.indexOf("const saveAndValidate")));
  assert.match(save, /updateBlueprint/, "edits land through the blueprint PUT (expectVersion)");
  assert.match(save, /validateBlueprint/, "validation runs the stored content after save");
  assert.match(teamMode, /studio-blueprint-json-apply/, "JSON track applies into the form track");
});

test("fold: old route redirects (two-step retire), pool reachable from team tab", () => {
  assert.match(app, /BlueprintRouteRedirect/);
  assert.match(app, /to="\/studio\?from=blueprint"/, "old /blueprints redirects into the studio team mode");
  assert.match(app, /fromBlueprint|from=blueprint/, "studio honors the source marker");
  assert.match(teamMode, /autoFocusPool/, "pool focus rides the redirect");
  // Step 2 of the two-step retire executed (92f13fbe): the dead component is
  // gone from the tree; only the redirect remains.
  assert.ok(!fs.existsSync(path.join(root, "web/src/pages/BlueprintStudioPage.tsx")), "old component removed");
  assert.ok(!app.includes("pages/BlueprintStudioPage"), "no import of the retired page");
});

test("emit does not mutate the working document (5.3)", () => {
  // emit writes through the API only — the page's working-doc state is never
  // reassigned by the emit paths (no setDoc/resetDoc inside emit* bodies).
  const page = read("web/src/pages/AgentStudioPage.tsx");
  for (const fn of ["emitPreset", "emitDraft"]) {
    const body = page.slice(page.indexOf(`const ${fn}`), page.indexOf("};", page.indexOf(`const ${fn}`)));
    assert.doesNotMatch(body, /setDoc\(|setDocTitle\(|resetDoc/, `${fn}: working doc untouched`);
    assert.match(body, /await .*(createCustomPreset|createPackDraft)/, `${fn}: writes via API`);
  }
});
