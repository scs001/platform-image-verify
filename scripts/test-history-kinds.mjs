#!/usr/bin/env node
// history 条目的显式类型（openspec: harden-fleet-execution-economics 1.4）
//
// 动机：同一天里同一个形状被人（我）误读三次——
//   ① {success:null, missed:1} → 当成失败（89.7% 假失败率）
//   ② {success:null, note} 校准留痕 → 当成失败（38.3% 读成 62.1%）
//   ③ 元数据行的存在导致"每次 checkBudget 都有失败"
// 类型由**写入方**声明，读方按 kind 分流；旧数据按形状回退。
//
//   node --test scripts/test-history-kinds.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "history-kinds-"));
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
const engine = await import("../task-engine.js");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { classifyHistoryEntry, summarizeHistory, HISTORY_KIND } = engine;

// ── 分类：显式 kind 优先 ─────────────────────────────────────────────
test("an explicit kind wins, whatever the shape looks like", () => {
  assert.equal(classifyHistoryEntry({ kind: "missed", success: null }), HISTORY_KIND.MISSED);
  assert.equal(classifyHistoryEntry({ kind: "meta", state: "failed" }), HISTORY_KIND.META);
});

// ── 分类：旧数据按形状回退 ───────────────────────────────────────────
test("legacy shapes classify without a kind field", () => {
  assert.equal(classifyHistoryEntry({ success: true, state: "done" }), HISTORY_KIND.EXECUTION);
  assert.equal(classifyHistoryEntry({ success: false, state: "failed" }), HISTORY_KIND.EXECUTION);
  assert.equal(classifyHistoryEntry({ success: false, state: "skipped" }), HISTORY_KIND.EXECUTION);
  assert.equal(classifyHistoryEntry({ success: null, missed: 3 }), HISTORY_KIND.MISSED);
  assert.equal(classifyHistoryEntry({ success: false, supersededBy: "x" }), HISTORY_KIND.SUPERSEDED);
  assert.equal(classifyHistoryEntry({ success: null, state: "queued" }), HISTORY_KIND.QUEUED_UPGRADE);
});

test("a row with no state is metadata, never a failure", () => {
  // 就是这条把 38.3% 读成 62.1%：{time, missed:0, success:null, note:"…"}
  const auditRow = { time: "2026-11-09T08:06:02Z", missed: 0, success: null, note: "recalibrated 25315 -> 100" };
  assert.equal(classifyHistoryEntry(auditRow), HISTORY_KIND.META);
});

// ── 汇总：分母只含真执行 ─────────────────────────────────────────────
test("the failure-rate denominator excludes missed and metadata rows", () => {
  const entries = [
    { kind: "execution", state: "done", success: true },
    { kind: "execution", state: "failed", success: false },
    { kind: "execution", state: "skipped", success: false },
    { kind: "missed", success: null, missed: 4 },
    { kind: "meta", success: null, note: "recalibrated" },
    { kind: "superseded", success: false, supersededBy: "x" },
    { kind: "queued-upgrade", success: null, state: "queued" },
  ];
  const s = summarizeHistory(entries);
  assert.equal(s.executed, 3, "only done/failed/skipped/interrupted count as executed");
  assert.equal(s.failed, 1);
  assert.equal(s.missed, 1);
  assert.equal(s.meta, 2, "meta + queued-upgrade are both non-executions");
  assert.equal(s.superseded, 1);
  assert.ok(Math.abs(s.failureRate - 1 / 3) < 1e-9, `expected 1/3, got ${s.failureRate}`);
});

test("an empty or absent history has no failure rate rather than zero", () => {
  assert.equal(summarizeHistory([]).failureRate, null, "0 executed must be null, not 0%");
  assert.equal(summarizeHistory(undefined).failureRate, null);
});

// ── 真实写入路径带上 kind ────────────────────────────────────────────
test("the engine stamps kind on the entries it writes", async () => {
  await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });
  const t = engine.insertTask({ id: "k1", name: "k1", prompt: "p", trigger: "manual", preset: "code" });
  engine.recordFailedFire?.(t.id, "boom");
  const rec = engine.getRecord(t.id);
  const last = (rec.history || []).at(-1);
  assert.equal(last?.kind, HISTORY_KIND.EXECUTION, `recordFailedFire must stamp kind, got ${JSON.stringify(last)}`);
});
