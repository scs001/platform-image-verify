// Context pressure + report salvage (fix-fleet-turn-budget, explore P0′-1).
//
// Production, 2026-11-08: 143 fleet rounds in one day, 82 ok. Of the 28 that
// died on the turn budget, **22 landed no report at all** — the round burned
// 600s compacting and produced nothing. One trace: 240 events over 535s with
// every 15–49s gap inside compaction/start|summary|end.
//
// Two things are pinned here:
//   1. the failure NAMES its cause (`contextPressure` + the compaction count)
//      instead of a bare "timed out";
//   2. an empty, pressure-killed fleet round gets ONE bounded, tool-free
//      follow-up asking for the report — the round stays failed (it did not
//      finish), but the fleet stops losing the data.
//
// Run: node --test scripts/test-fleet-context-pressure.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-pressure-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");

const { collectTurn, timeoutError, runWrapUpReport, shouldSalvageReport } = await import("../server/cron-runner.js");

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A ctx with no bridge: the collector is driven by hand, exactly as the child
// would drive it.
const makeCtx = () => ({ sessionCollectors: new Map(), taskTurnRegistry: new Map() });

test("collector counts compaction/start and reports it on idle", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  const p = collectTurn(ctx, "s1", 5000, new Map(), collectors, "s1");
  const push = collectors.get("s1");
  assert.ok(push, "collector registered");
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  push({ method: "session.event", params: { event: { type: "compaction/summary" } } });
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "部分结论" }] } } } } });
  push({ method: "session.status", params: { status: "idle" } });
  const out = await p;
  assert.equal(out.compactions, 2, "two starts counted; summaries are not");
  assert.equal(out.text, "部分结论");
});

test("timeout attribution names context pressure only past the threshold", () => {
  const tools = [{ name: "bash", at: Date.now() - 1000, result: "ok" }];
  const plain = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 1, hasOutput: false });
  assert.equal(plain.message, "turn timed out", "one compaction is not a storm");
  assert.equal(plain.detail.contextPressure, undefined);
  assert.equal(plain.detail.compactions, 1, "the count still rides for diagnosis");

  const storm = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 3, hasOutput: false });
  assert.equal(storm.detail.contextPressure, true);
  assert.match(storm.message, /context pressure \(3 compactions\)/);
  assert.equal(storm.detail.hasOutput, false);
});

test("wrap-up asks the same session for the report, tool-free and bounded", async () => {
  const ctx = makeCtx();
  const prompts = [];
  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      prompts.push({ sessionId, text: blocks[0].text });
      const push = ctx.sessionCollectors.get(sessionId);
      push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "已交报数" }] } } } } });
      push({ method: "session.status", params: { status: "idle" } });
    },
  };
  const out = await runWrapUpReport(ctx, { childSessionId: "child-1", mirrorSessionId: "mirror-1" });
  assert.equal(prompts.length, 1, "exactly one follow-up");
  assert.equal(prompts[0].sessionId, "child-1", "same child session — it still has the work in context");
  assert.match(prompts[0].text, /report_status/);
  assert.match(prompts[0].text, /不要调用任何其他工具/, "the follow-up refuses tools");
  assert.equal(out.text, "已交报数");
});

test("wrap-up never becomes the outcome: a failing follow-up returns null", async () => {
  const ctx = makeCtx();
  ctx.dshBridge = { prompt: async () => { throw new Error("runtime gone"); } };
  // Bounded: the follow-up must not wait out its full ceiling after the
  // prompt already threw (a 90s wait in a unit test is not a test).
  assert.equal(await runWrapUpReport(ctx, { childSessionId: "child-2", timeoutMs: 100 }), null);
});

test("判据：压力 + 空产出 + 舰队任务，三者同时成立才补收尾", () => {
  const pressure = { kind: "turn_budget_exceeded", compactions: 3, contextPressure: true, hasOutput: false };
  assert.equal(shouldSalvageReport(pressure, { isFleet: true }), true, "the round this lane exists for");
  assert.equal(shouldSalvageReport({ ...pressure, hasOutput: true }, { isFleet: true }), false, "a round that said something is not empty");
  assert.equal(shouldSalvageReport(pressure, { isFleet: false }), false, "fleet-only");
  assert.equal(shouldSalvageReport(pressure, { isFleet: true, interrupted: true }), false, "a runtime abort is not the round's fault");
  assert.equal(shouldSalvageReport({ kind: "turn_budget_exceeded", compactions: 1, hasOutput: false }, { isFleet: true }), false, "one compaction is not a storm");
  assert.equal(shouldSalvageReport(null, { isFleet: true }), false);
});

test("端到端（缝级）：真超时产生 pressure 归因，随后收尾把报数补回来", async () => {
  const ctx = makeCtx();
  const collectors = new Map();
  // A real collector that times out after two compactions and no output.
  const p = collectTurn(ctx, "child-e2e", 120, new Map(), collectors, "mirror-e2e");
  const push = collectors.get("child-e2e");
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  push({ method: "session.event", params: { event: { type: "compaction/start" } } });
  const err = await p.then(() => null, (e) => e);
  assert.ok(err, "the turn timed out");
  assert.equal(err.detail.contextPressure, true);
  assert.equal(err.detail.hasOutput, false);
  assert.equal(shouldSalvageReport(err.detail, { isFleet: true }), true, "the seam reaches the salvage branch");

  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      assert.match(blocks[0].text, /report_status/);
      const c = ctx.sessionCollectors.get(sessionId);
      c({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交：本周 3 篇" }] } } } } });
      c({ method: "session.status", params: { status: "idle" } });
    },
  };
  const salvaged = await runWrapUpReport(ctx, { childSessionId: "child-e2e", mirrorSessionId: "mirror-e2e" });
  assert.equal(salvaged.text, "补交：本周 3 篇");
});
