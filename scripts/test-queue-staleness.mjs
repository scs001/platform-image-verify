#!/usr/bin/env node
// ── Queue staleness tests (fix-cell-turn-throughput 2.2) ─────────────────────
//
// The serial chain (`executionQueue.then(...)`) means one turn that never
// settles stops every queued execution behind it. Live 2026-11-08: a turn sat
// in `running` 3.5 minutes with 24 tasks queued and nothing moved, because
// `finishExecution` can only be called by the turn itself.
//
// This file owns ONLY the staleness policy: a separate process, because the
// serial chain is module state — a never-settling turn left by one test would
// otherwise queue every later test behind it.
//
//   node --test scripts/test-queue-staleness.mjs

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
const engine = await import(path.join(here, "../task-engine.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(runTurn) {
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn,
    isBusy: () => false,
    resolveTurnBudget: () => 50, // tiny budget so grace math stays in ms scale
  });
}

function addTask(id) {
  engine.insertTask({ id, name: id, prompt: "p", trigger: "manual", targetType: "persona" });
  return id;
}

async function waitFor(predicate, { timeoutMs = 4000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ── 2.2 Queue staleness ─────────────────────────────────────────────────────
//
// One serial slot + a catch-up burst ⇒ an hours-long backlog. A scheduled fire
// that reaches the front hours late would patrol a slot that already passed and
// hold every newer fire behind it (live 2026-11-08: 18 queued, oldest 3.5h,
// while a `run now` waited 180s and saw nothing). Above the staleness bound a
// scheduled fire is dropped as `skipped` without spending budget; manual fires
// are never aged out.

function addScheduledTask(id) {
  engine.insertTask({ id, name: id, prompt: "p", trigger: "schedule", targetType: "persona" });
  return id;
}

test("a scheduled fire that waited past the staleness bound is dropped as skipped", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("stale");
    // Simulate a backlog: the fire was enqueued long before the slot freed.
    engine.getRecord("stale").queuedAt = Date.now() - 60_000;
    engine.enqueueExecution("stale");
    // enqueueExecution re-stamps queuedAt, so re-age it after enqueue.
    engine.getRecord("stale").queuedAt = Date.now() - 60_000;
    // Force the chain to observe the aged stamp: enqueue a follower that will
    // be dequeued after it.
    addScheduledTask("fresh");
    engine.enqueueExecution("fresh");

    const settled = await waitFor(() => engine.getRecord("stale").state === "skipped");
    assert.equal(settled, true, "a stale scheduled fire must settle instead of running");
    assert.match(engine.getRecord("stale").error ?? "", /queue staleness/, "the cause must name staleness");
    assert.equal(started.includes("stale"), false, "a dropped fire must not spend a turn");

    const freshRan = await waitFor(() => started.includes("fresh"));
    assert.equal(freshRan, true, "the newer fire must get the slot");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});

test("a manual run is never aged out (a human asked for that round)", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addTask("manual-old");
    engine.enqueueExecution("manual-old");
    engine.getRecord("manual-old").queuedAt = Date.now() - 60_000;
    const ran = await waitFor(() => started.includes("manual-old"));
    assert.equal(ran, true, "manual fires must run regardless of queue age");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});

test("QUEUE_MAX_AGE_MS=0 restores the pre-policy behaviour", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "0";
  try {
    addScheduledTask("old-but-allowed");
    engine.enqueueExecution("old-but-allowed");
    engine.getRecord("old-but-allowed").queuedAt = Date.now() - 60_000;
    const ran = await waitFor(() => started.includes("old-but-allowed"));
    assert.equal(ran, true, "0 disables the staleness policy");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});
