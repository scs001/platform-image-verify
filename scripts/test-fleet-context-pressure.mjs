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
  // The report must land BEFORE the idle that settles the turn — the collector
  // is deregistered on settlement, so anything after it is dropped (this is
  // exactly the ordering mistake a real turn cannot make).
  push({ method: "session.event", params: { event: { type: "tool/call", data: { callId: "c9", name: "mcp__fleet__report_status", arguments: "{}" } } } });
  push({ method: "session.event", params: { event: { type: "tool/result", data: { message: { source: { callId: "c9" }, content: [{ type: "text", text: "ok" }] } } } } });
  push({ method: "session.status", params: { status: "idle" } });
  const out = await p;
  assert.equal(out.compactions, 2, "two starts counted; summaries are not");
  assert.equal(out.text, "部分结论");
  assert.equal(out.reported, true, "a completed report_status call is observed as filed");
});

test("timeout attribution names context pressure only past the threshold", () => {
  const tools = [{ name: "bash", at: Date.now() - 1000, result: "ok" }];
  const plain = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 1, hasOutput: false });
  assert.equal(plain.message, "turn timed out", "one compaction is not a storm");
  assert.equal(plain.detail.contextPressure, undefined);
  assert.equal(plain.detail.compactions, 1, "the count still rides for diagnosis");

  const storm = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 3, hasOutput: false, reported: false });
  assert.equal(storm.detail.contextPressure, true);
  assert.match(storm.message, /context pressure \(3 compactions\)/);
  assert.equal(storm.detail.hasOutput, false);
  assert.equal(storm.detail.reported, false, "the report fact rides the attribution");

  const filed = timeoutError(tools, Date.now() - 60_000, Date.now(), { compactions: 3, hasOutput: true, reported: true });
  assert.equal(filed.detail.reported, true);
  assert.equal(shouldSalvageReport(filed.detail, { isFleet: true }), false, "a timeout after filing needs no salvage");
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
  assert.match(prompts[0].text, /不要调用其他工具/, "the follow-up refuses other tools");
  assert.match(prompts[0].text, /不要解释|不要继续分析/, "and refuses prose — one call, then done");
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
  const pressure = { kind: "turn_budget_exceeded", compactions: 3, contextPressure: true, reported: false, hasOutput: false };
  assert.equal(shouldSalvageReport(pressure, { isFleet: true }), true, "the round this lane exists for");
  assert.equal(shouldSalvageReport({ ...pressure, reported: true }, { isFleet: true }), false, "a round that already filed its report needs nothing");
  // The live correction: five pressure-killed rounds HAD text and still filed
  // nothing. Output is not the test — the report is.
  assert.equal(shouldSalvageReport({ ...pressure, hasOutput: true, reported: false }, { isFleet: true }), true, "text without a report still needs the lane");
  assert.equal(shouldSalvageReport(pressure, { isFleet: false }), false, "fleet-only");
  assert.equal(shouldSalvageReport(pressure, { isFleet: true, interrupted: true }), false, "a runtime abort is not the round's fault");
  assert.equal(shouldSalvageReport({ kind: "turn_budget_exceeded", compactions: 1, reported: false }, { isFleet: true }), false, "one compaction is not a storm");
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

// ── the overflow shape (fix-fleet-output-salvage D3) ────────────────────────
const { contextPressureDetail, OVERFLOW_RE, attributeFailureAndSalvage } = await import("../server/cron-runner.js");

test("overflow 也归压力类，且与超时共用判据", () => {
  // The live error the runtime emits when the working set stops fitting.
  const err = 'pi-ai detected context overflow for model "deepseek-v4.1-flash"';
  const d = contextPressureDetail(err, { compactions: 0, reported: false });
  assert.equal(d.contextPressure, true, "an overflow is pressure, not an unknown failure");
  assert.equal(d.kind, "context_overflow");
  assert.equal(d.overflow, true);
  assert.equal(shouldSalvageReport(d, { isFleet: true }), true, "and it earns the salvage lane");
  assert.equal(shouldSalvageReport({ ...d, reported: true }, { isFleet: true }), false, "unless it already reported");

  // Not every failure is pressure.
  assert.equal(contextPressureDetail("502: upstream service temporarily unavailable"), null);
  assert.equal(contextPressureDetail("budget_exhausted: all candidate models over daily budget"), null);
  assert.equal(contextPressureDetail("turn timed out", { compactions: 1 }), null, "one compaction is not a storm");
  assert.equal(contextPressureDetail("turn timed out", { compactions: 3 }).kind, "turn_budget_exceeded");

  assert.ok(OVERFLOW_RE.test(err));
});

test("接线：overflow 失败走收尾补数（与超时同一条组合）", async () => {
  const ctx = makeCtx();
  let wrapUps = 0;
  ctx.dshBridge = {
    prompt: async (sessionId, blocks) => {
      assert.match(blocks[0].text, /report_status/);
      wrapUps += 1;
      const push = ctx.sessionCollectors.get(sessionId);
      push({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "补交" }] } } } } });
      push({ method: "session.status", params: { status: "idle" } });
    },
  };
  const detail = await attributeFailureAndSalvage(ctx, {
    error: 'pi-ai detected context overflow for model "m"',
    childSessionId: "child-ovf",
    mirrorSessionId: "mirror-ovf",
    isFleet: true,
  });
  assert.equal(detail.contextPressure, true);
  assert.equal(detail.kind, "context_overflow");
  assert.equal(wrapUps, 1, "the salvage lane ran on the overflow path");
  assert.deepEqual(detail.wrapUp, { ok: true, chars: 2 });

  // Non-pressure failures are left exactly as they were.
  assert.equal(await attributeFailureAndSalvage(ctx, { error: "502 upstream unavailable", isFleet: true }), null);
  // A fleet round that already reported needs nothing.
  const quiet = await attributeFailureAndSalvage(ctx, {
    error: 'context overflow', reported: true, childSessionId: "child-x", isFleet: true,
  });
  assert.equal(quiet.wrapUp, undefined);
});

test("失败回合留下收尾判据的四项事实（下次不用从外面猜）", () => {
  const { shouldSalvageReport: judge } = { shouldSalvageReport };
  const facts = { isFleet: true, interrupted: false, pressure: true, reported: false };
  assert.equal(judge({ contextPressure: facts.pressure, reported: facts.reported }, { isFleet: facts.isFleet, interrupted: facts.interrupted }), true);
  // And the shape the runner writes is the one a reader can act on.
  assert.deepEqual(Object.keys(facts).sort(), ["interrupted", "isFleet", "pressure", "reported"]);
});
