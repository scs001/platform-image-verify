// Unit tests for the two config dimensions beyond the model
// (add-agent-config-dims): effort resolution + context-budget verdict.
//
//   - resolveAgentEffort: declaration order (post → fleet → cell), a level the
//     effective model does not declare falls through with a notice, no
//     declarations → null/silent, unknown model → cannot judge (pass through,
//     never block a turn over a roster hiccup)
//   - effortDeclarations registry: setEffortDeclarations seeds it; an unknown
//     model reads null
//   - context budget: over budget fails as context_budget with both numbers in
//     the summary; no budget → no verdict; no usage → never judged (honest
//     absence, never an invented zero)
//
// Run: node --test scripts/test-agent-config-dims.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveAgentEffort, setEffortDeclarations, effortDeclarationsFor } = await import("../server/fleet-model.js");
const { shapeTurnOutcome, ERROR_KINDS } = await import("../server/fleet-events.js");

test("effort: post declaration wins when the model declares the level", () => {
  setEffortDeclarations({ "m-reasoner": ["low", "medium", "high"] });
  const r = resolveAgentEffort({ agentEffort: "high", fleetEffort: "low", model: "m-reasoner" });
  assert.equal(r.effort, "high");
  assert.equal(r.source, "post");
  assert.deepEqual(r.notices, []);
});

test("effort: fleet default applies when the post declares nothing", () => {
  setEffortDeclarations({ "m-reasoner": ["low", "medium"] });
  const r = resolveAgentEffort({ agentEffort: null, fleetEffort: "medium", model: "m-reasoner" });
  assert.equal(r.effort, "medium");
  assert.equal(r.source, "fleet");
});

test("effort: an unsupported level falls through with a notice, never throws", () => {
  setEffortDeclarations({ "m-reasoner": ["low", "medium"] });
  const r = resolveAgentEffort({ agentEffort: "high", fleetEffort: "low", model: "m-reasoner" });
  assert.equal(r.effort, "low", "falls to the next declaration that IS supported");
  assert.equal(r.source, "fleet");
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /post thinking level 'high' is not supported/);
});

test("effort: nothing declared → null and silent (inherit the global level)", () => {
  setEffortDeclarations({ "m-reasoner": ["high"] });
  const r = resolveAgentEffort({ model: "m-reasoner" });
  assert.equal(r.effort, null);
  assert.equal(r.source, null);
  assert.deepEqual(r.notices, [], "inheritance is normal — no notice");
});

test("effort: unknown model cannot be judged → pass the declaration through", () => {
  setEffortDeclarations({ "m-reasoner": ["high"] });
  const r = resolveAgentEffort({ agentEffort: "high", model: "m-unknown" });
  assert.equal(r.effort, "high", "a roster hiccup must not block the turn");
  assert.deepEqual(r.notices, []);
  assert.equal(effortDeclarationsFor("m-unknown"), null);
});

test("effort: all declarations unsupported → null with one notice each", () => {
  setEffortDeclarations({ "m-reasoner": ["low"] });
  const r = resolveAgentEffort({ agentEffort: "high", fleetEffort: "medium", model: "m-reasoner" });
  assert.equal(r.effort, null);
  assert.equal(r.notices.length, 2);
});

test("context budget: over budget fails as context_budget with both numbers", () => {
  assert.ok(ERROR_KINDS.includes("context_budget"), "the enum carries the new kind");
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 7000, output: 2000 } }, { contextBudget: 8000 });
  assert.equal(shaped.status, "failed");
  assert.equal(shaped.errorKind, "context_budget");
  assert.match(shaped.error, /9000/);
  assert.match(shaped.error, /8000/);
});

test("context budget: within budget keeps the turn ok", () => {
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 100, output: 50 } }, { contextBudget: 8000 });
  assert.equal(shaped.status, "ok");
  assert.equal(shaped.errorKind, null);
});

test("context budget: undeclared means no verdict", () => {
  const shaped = shapeTurnOutcome({ ok: true, usage: { input: 999999, output: 1 } }, {});
  assert.equal(shaped.status, "ok");
});

test("context budget: no reported usage is never judged", () => {
  const shaped = shapeTurnOutcome({ ok: true }, { contextBudget: 100 });
  assert.equal(shaped.status, "ok", "no basis → no verdict, never an invented zero");
});
