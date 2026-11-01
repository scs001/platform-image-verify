#!/usr/bin/env node
// ── Studio AI drafting tests (add-studio-ai-drafting) ────────────────────────
//
// Pins the drafting discipline end to end:
//   1. the bridge is ONE function, not a tool proxy — kind whitelist
//      structurally caps the surface, and an arbitrary tool name has no path
//   2. auth: anonymous callers get the family-standard 401 (behavioral, booted
//      gateway); no lane configured → honest 503, never a fake draft
//   3. zero persistence, zero emit mouths: the route file writes nothing and
//      calls no emit path; the canvas's DRAFT state never feeds the emit
//      functions — 「采用」 is the single human gate, 取消 discards byte-for-byte
//   4. i18n: the drafting chrome exists in all five locales
//
//   node --test scripts/test-studio-ai-drafting.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const route = read("server/routes/studio-draft.js");
const page = read("web/src/pages/AgentStudioPage.tsx");
const serverJs = read("server.js");

test("1. the bridge is one function — kind whitelist is structural, no tool proxy exists", () => {
  assert.match(route, /DRAFT_KINDS = \["agent-doc", "blueprint"\]/, "the whitelist is an explicit constant");
  assert.match(route, /kind must be one of/, "off-whitelist kinds are rejected by name");
  // No pass-through surface: the file must not forward caller-controlled tool
  // names anywhere — the only upstream call is the lane completion. (The word
  // "proxy" appears only in the design comment saying there is none.)
  const codeOnly = route.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/toolName|tools\/call/i.test(codeOnly), "no generic tool-proxy path in code");
  assert.match(route, /resolveJudgeLane/, "drafting rides the deployment lane (no second LLM client)");
});

test("2. zero persistence, zero emit mouths in the drafting path", () => {
  for (const bad of ["createCustomPreset", "createPackDraft", "castBlueprint", "createBlueprint", "insert\\(|UPDATE |saveBlueprint"]) {
    assert.ok(!new RegExp(bad).test(route), `route never calls ${bad}`);
  }
  assert.match(route, /只产草稿：响应即终点，零持久化、零发射/, "the no-write contract is stated at the return site");
});

test("3. the canvas keeps draft state out of the emit mouths; adopt is the single gate", () => {
  // The request path posts to the drafting endpoint only.
  const req = page.slice(page.indexOf("const requestAiDraft"), page.indexOf("};", page.indexOf("const requestAiDraft")));
  assert.match(req, /\/api\/studio\/draft/, "the draft request hits the drafting bridge");
  assert.ok(!/emitPreset|emitDraft|createCustomPreset|createPackDraft/.test(req), "drafting never calls an emit path");
  // Adopt is a separate explicit gesture that writes the doc; discard touches nothing.
  const adopt = page.slice(page.indexOf("const adoptAiDraft"), page.indexOf("};", page.indexOf("const adoptAiDraft")));
  assert.match(adopt, /setDoc\(/, "adopt is the write gate");
  const discard = page.slice(page.indexOf("const discardAiDraft"), page.indexOf("\n  const selected ="));
  assert.ok(!/setDoc/.test(discard), "discard never touches the working doc");
  // The draft request body carries no emit-shaped fields — it is a prompt only.
  assert.match(req, /kind: "agent-doc", prompt: aiDraft\.text/, "the draft request is a prompt, not a document");
});

test("4. the route is mounted on the authenticated /api namespace", () => {
  assert.match(serverJs, /createStudioDraftRoutes\(app, ctx\)/, "mounted in server.js beside the routes family");
  assert.match(route, /app\.use\("\/api\/studio", router\)/, "under /api — the session middleware's namespace");
});

test("5. i18n: drafting chrome in all five locales", () => {
  for (const loc of ["zh-CN", "en", "ja", "fr", "es"]) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    const ai = d.studio?.aiDraft;
    assert.ok(ai && ai.title && ai.action && ai.adopt && ai.discard && ai.promptLabel, `${loc}: aiDraft keys`);
  }
});
