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
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Isolate task storage: TASK_STORAGE_DIR is frozen at module load from
// CRON_STORAGE_PATH, so the env must be set AFTER the static imports above
// but BEFORE the dynamic engine import below — otherwise the suite reads
// (and rewrites!) the developer machine's real cron store.
process.env.CRON_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
const {
  initTaskEngine,
  insertTask,
  getRecord,
  enqueueExecution,
  queueHealth,
  QUEUE_MAX_OLDEST_QUEUED_MS,
} = await import(path.join(here, "../task-engine.js"));

const neverTurn = () => new Promise(() => {});

// Every test needs a CLEAN store, and a plain re-init does not give one: the
// whole file shares one temp dir, `state` is part of the persisted record, and
// loadTasks keeps `queued` (re-queueing it for repair). So a record an earlier
// test left queued is RELOADED here — and since several tests assert a global
// count (`queued === 0`), that residue decides the result. This is exactly how
// the file failed in CI (1 !== 0 at the last test) while passing locally: the
// enqueue path saves with `void saveTasks()`, so which state is on disk when
// the next test starts depends on how fast the chained write lands.
//
// Order matters: init FIRST (any write still in flight then recomputes its
// snapshot from the fresh, empty map and settles before init returns — the
// await covers the write chain), then wipe the store, then init again so the
// load sees nothing.
async function freshEngine() {
  const init = () => initTaskEngine({ broadcast: () => {}, runTurn: neverTurn, isBusy: () => false });
  await init();
  fs.rmSync(process.env.CRON_STORAGE_PATH, { recursive: true, force: true });
  await init();
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

test("a record left queued on disk does not leak into a fresh engine", async () => {
  // Pins the isolation contract freshEngine() now owns. Without the wipe, this
  // is the CI failure reproduced locally: loadTasks keeps the persisted
  // `queued` state and the projection counts it.
  fs.writeFileSync(
    path.join(process.env.CRON_STORAGE_PATH, "jobs.json"),
    JSON.stringify([
      {
        id: "stale",
        name: "stale",
        trigger: "manual",
        prompt: "p",
        targetType: "persona",
        state: "queued",
        queuedAt: Date.now() - 1000,
        history: [],
      },
    ]),
  );
  await freshEngine();
  const h = queueHealth();
  assert.equal(h.queued, 0, "a stale queued record must not survive a fresh engine");
  assert.equal(h.running, 0);
  assert.equal(h.degraded, false);
});
