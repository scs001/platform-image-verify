#!/usr/bin/env node
// ── Queue liveness tests (fix-task-queue-deadlock tasks 1.1) ─────────────────
//
// Pins the projection that makes a stalled serial queue VISIBLE. Motivation
// (2026-11-08 live on the owner cell): 776 tasks, 1 `running` that had been
// going for 6.5 minutes without settling, 22 `queued` with the oldest parked
// since 00:34 — and `/api/ready` still answered `{"ready":true}`. That false
// green turned one stall into hours of misdiagnosis (queue contention →
// MCP count → zombie state → budget exhaustion, each disproved in turn).
//
// `queueHealth` reads the engine's own task map; the tests drive real records
// (insert + direct state stamping) rather than a parallel fake, so the
// projection is pinned against the shapes the engine actually produces.
//
//   node --test scripts/test-queue-health.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  initTaskEngine,
  insertTask,
  getRecord,
  enqueueExecution,
  queueHealth,
  QUEUE_MAX_OLDEST_QUEUED_MS,
} = await import(path.join(here, "../task-engine.js"));

const neverTurn = () => new Promise(() => {});

async function freshEngine() {
  await initTaskEngine({ broadcast: () => {}, runTurn: neverTurn, isBusy: () => false });
}

function addTask(id) {
  insertTask({ id, name: id, prompt: "p", trigger: "manual", targetType: "persona" });
  return id;
}

test("an empty engine reports healthy", async () => {
  await freshEngine();
  const h = queueHealth();
  assert.equal(h.queued, 0);
  assert.equal(h.running, 0);
  assert.equal(h.oldestQueuedMs, null);
  assert.equal(h.oldestRunningMs, null);
  assert.equal(h.overBudget, 0);
  assert.equal(h.degraded, false);
});

test("a backlog inside the threshold stays healthy", async () => {
  await freshEngine();
  enqueueExecution(addTask("fresh"));
  const h = queueHealth();
  assert.equal(h.queued, 1);
  assert.equal(h.degraded, false);
  assert.ok(h.oldestQueuedMs !== null && h.oldestQueuedMs < QUEUE_MAX_OLDEST_QUEUED_MS);
});

test("a queued task stuck past the threshold degrades the probe", async () => {
  await freshEngine();
  const id = addTask("stuck");
  enqueueExecution(id);
  const h = queueHealth({ now: Date.now() + QUEUE_MAX_OLDEST_QUEUED_MS + 60_000 });
  assert.equal(h.queued, 1);
  assert.equal(h.degraded, true);
  assert.ok(h.oldestQueuedMs > QUEUE_MAX_OLDEST_QUEUED_MS);
});

test("a running turn past budget+grace degrades the probe with no backlog", async () => {
  await freshEngine();
  const id = addTask("long-run");
  const rec = getRecord(id);
  rec.state = "running";
  rec.lastRun = new Date(Date.now() - 20 * 60_000).toISOString();

  const h = queueHealth({ budgetOf: () => 5 * 60_000, graceMs: 5 * 60_000 });
  assert.equal(h.queued, 0);
  assert.equal(h.running, 1);
  assert.equal(h.overBudget, 1);
  assert.equal(h.degraded, true);
  assert.ok(h.oldestRunningMs >= 19 * 60_000);
});

test("a running turn inside budget+grace does not degrade", async () => {
  await freshEngine();
  const id = addTask("short-run");
  const rec = getRecord(id);
  rec.state = "running";
  rec.lastRun = new Date(Date.now() - 60_000).toISOString();

  const h = queueHealth({ budgetOf: () => 5 * 60_000, graceMs: 5 * 60_000 });
  assert.equal(h.running, 1);
  assert.equal(h.overBudget, 0);
  assert.equal(h.degraded, false);
});

test("a broken budget resolver never fails the snapshot", async () => {
  await freshEngine();
  const id = addTask("bad-budget");
  const rec = getRecord(id);
  rec.state = "running";
  rec.lastRun = new Date().toISOString();

  const h = queueHealth({
    budgetOf: () => {
      throw new Error("boom");
    },
  });
  assert.equal(h.running, 1);
  assert.equal(h.degraded, false);
});

test("paused and idle tasks are not counted as backlog", async () => {
  await freshEngine();
  addTask("idle");
  const h = queueHealth();
  assert.equal(h.queued, 0);
  assert.equal(h.running, 0);
  assert.equal(h.degraded, false);
});
