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
    // Simulate a backlog: the fire first asked for a slot long before it got
    // one (both clocks aged — this case is about the bound, not about which
    // clock is authoritative; the restart case below covers that).
    engine.enqueueExecution("stale");
    const stale = engine.getRecord("stale");
    stale.firstQueuedAt = Date.now() - 60_000;
    stale.queuedAt = Date.now() - 60_000;
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
    engine.getRecord("manual-old").firstQueuedAt = Date.now() - 60_000;
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
    engine.getRecord("old-but-allowed").firstQueuedAt = Date.now() - 60_000;
    const ran = await waitFor(() => started.includes("old-but-allowed"));
    assert.equal(ran, true, "0 disables the staleness policy");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
  }
});

// A restart re-stamps `queuedAt` (the WAIT clock) so the probe never cries
// "waiting 12 hours". The staleness decision must therefore key off the FIRST
// queue timestamp, or every restart refreshes the whole backlog to "brand new"
// and the policy can never fire (live 2026-11-08: 16-18 fires re-stamped on
// each boot while a `run now` waited behind them).
test("a re-stamped wait clock does not refresh the staleness age", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("rebooted-old");
    // Enqueue, then simulate what a restart does: keep the first-queue anchor,
    // but refresh the wait clock to "now".
    engine.enqueueExecution("rebooted-old");
    const rec = engine.getRecord("rebooted-old");
    rec.firstQueuedAt = Date.now() - 120_000;
    rec.queuedAt = Date.now();

    addScheduledTask("after-restart");
    engine.enqueueExecution("after-restart");

    const settled = await waitFor(() => engine.getRecord("rebooted-old").state === "skipped");
    assert.equal(settled, true, "the anchor, not the refreshed wait clock, decides staleness");
    assert.equal(started.includes("rebooted-old"), false);
    assert.equal(await waitFor(() => started.includes("after-restart")), true);
  } finally { delete process.env.QUEUE_MAX_AGE_MS; }
});

// The anchor must survive a process restart, and `saveTasks` persists by
// WHITELIST — a field it does not name is dropped even though `loadTasks`
// spreads whatever it finds. Without this the policy looked correct in-process
// and could never fire in production: every boot handed the whole backlog a
// fresh anchor (live 2026-11-08: 18 queued, all stamped inside one second).
test("the first-queue anchor is persisted, so a restart cannot refresh it", async () => {
  // Hold the serial slot so the task under test stays QUEUED (leaving the queue
  // for a real run clears the anchor by design — that is not what this tests).
  let release;
  const gate = new Promise((r) => { release = r; });
  await boot((task) => (task.id === "blocker" ? gate : Promise.resolve({ ok: true })));
  addScheduledTask("blocker");
  engine.enqueueExecution("blocker");
  addScheduledTask("persisted-anchor");
  engine.enqueueExecution("persisted-anchor");
  const rec = engine.getRecord("persisted-anchor");
  assert.equal(rec.state, "queued", "the task must still be waiting behind the blocker");
  const anchoredAt = Date.now() - 90_000;
  rec.firstQueuedAt = anchoredAt;
  await engine.saveTasks();

  const saved = JSON.parse(fs.readFileSync(path.join(process.env.CRON_STORAGE_PATH, "jobs.json"), "utf8"));
  const row = saved.find((r) => r.id === "persisted-anchor");
  assert.ok(row, "the task must be on disk");
  assert.equal(row.firstQueuedAt, anchoredAt, "saveTasks must whitelist the anchor");
  release({ ok: true });
  await engine.idle();
});

// The staleness age may only drop a fire NOBODY asked for. `run now` on a
// cadence task keeps trigger="schedule", so keying the policy on the trigger
// alone dropped the operator's own ignition once it waited past the bound —
// the very "run-now lost" symptom this change set out to kill (live
// 2026-11-08: a fleet scout run-now was dropped as "waited 28min > 10min").
test("a run-now on a cadence task is never aged out, however long it waits", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("human-ignition");
    engine.runTaskNow("human-ignition");
    const rec = engine.getRecord("human-ignition");
    assert.equal(rec.queuedBy, "human", "run-now must mark the residence as human");
    rec.firstQueuedAt = Date.now() - 300_000;
    const ran = await waitFor(() => started.includes("human-ignition"));
    assert.equal(ran, true, "a human ignition must run regardless of queue age");
  } finally { delete process.env.QUEUE_MAX_AGE_MS; }
});

// The dequeue-time check only ever sees the fire that WINS the slot. With human
// wakes and manual turns arriving continuously, an over-age cadence fire parked
// behind them never reaches the front — so it was never dropped, and it held
// `queueHealth().degraded` true the whole time (live 2026-11-09:
// job_1793413192186_g51s7b, cadence, 80 minutes queued, /api/ready 503 on an
// otherwise healthy cell). The sweep looks at the queue itself, not the slot.
test("the sweep drops an over-age cadence fire that never reaches the front", async () => {
  // Hold the slot with a blocker so nothing dequeues during the test.
  let release;
  const gate = new Promise((r) => { release = r; });
  await boot((task) => (task.id === "blocker" ? gate : Promise.resolve({ ok: true })));
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("blocker");
    engine.enqueueExecution("blocker");
    addScheduledTask("parked-old");
    engine.enqueueExecution("parked-old");
    const rec = engine.getRecord("parked-old");
    assert.equal(rec.state, "queued");
    rec.firstQueuedAt = Date.now() - 660_000; // 11 min parked behind the blocker
    assert.equal(engine.queueHealth().degraded, true, "an over-age queued fire degrades the probe");

    const dropped = engine.sweepStaleQueuedFires();
    assert.ok(dropped >= 1, "the parked cadence fire is swept");
    assert.equal(engine.getRecord("parked-old").state, "skipped");
    assert.match(engine.getRecord("parked-old").error ?? "", /queue staleness/);
    // Scope to THIS task: the suite shares one engine, so other cases' leftovers
    // may legitimately keep the aggregate probe degraded.
    const after = engine.queueHealth();
    assert.equal(after.queued < 1 || engine.getRecord("parked-old").state !== "queued", true,
      "the swept fire no longer occupies a queue slot");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
    release({ ok: true });
    await engine.idle();
  }
});

test("the sweep never touches a human ignition nor a running turn", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await boot((task) => (task.id === "runner" ? gate : Promise.resolve({ ok: true })));
  process.env.QUEUE_MAX_AGE_MS = "50";
  try {
    addScheduledTask("runner");
    engine.enqueueExecution("runner");           // becomes the running turn
    // Dispatch is a promise chain: wait for the turn to actually start, else the
    // sweep would legitimately see it as queued and drop it.
    assert.equal(await waitFor(() => engine.getRecord("runner").state === "running"), true);
    addScheduledTask("human-old");
    engine.runTaskNow("human-old");              // queued, human
    const human = engine.getRecord("human-old");
    human.firstQueuedAt = Date.now() - 600_000;
    const runner = engine.getRecord("runner");
    if (Number.isFinite(runner.firstQueuedAt)) runner.firstQueuedAt = Date.now() - 600_000;

    // Other tests' leftovers may also be swept here — assert on THIS pair, which
    // is the actual contract: a human ignition and a running turn are untouchable.
    engine.sweepStaleQueuedFires();
    assert.equal(engine.getRecord("human-old").state, "queued", "a human ignition is never swept");
    assert.equal(engine.getRecord("human-old").queuedBy, "human");
    assert.notEqual(engine.getRecord("runner").state, "skipped", "a running turn is never swept");
  } finally {
    delete process.env.QUEUE_MAX_AGE_MS;
    release({ ok: true });
    await engine.idle();
  }
});

// ── Orphaned queued executions (fix-orphaned-queued-executions) ────────────
//
// A task can carry state="queued" while holding NO pending execution. Then
// `drainExecutions` has nothing to pick, the cell stops with running=0, no error
// is raised anywhere, and every later enqueue is absorbed by the "already
// queued" branch — so it never heals. Live 2026-11-09: queue.queued=4,
// queue.running=0, fairness pending=0 for ~20 minutes while a `run now` kept
// answering {ok:true, already:true}.

test("a queued-but-off-chain task is re-dispatched instead of being absorbed", async () => {
  const started = [];
  await boot((task) => { started.push(task.id); return Promise.resolve({ ok: true }); });
  try {
    addScheduledTask("orphan");
    engine.enqueueExecution("orphan");
    await waitFor(() => started.includes("orphan"));
    // Reproduce the orphan: state says queued, but nothing pending holds it.
    const rec = engine.getRecord("orphan");
    rec.state = "queued";
    assert.equal(engine.queueHealth().orphaned >= 1, true, "the probe must count it");
    assert.equal(engine.queueHealth().degraded, true, "an orphan degrades the probe");

    const ranBefore = started.filter((x) => x === "orphan").length;
    const r = engine.runTaskNow("orphan");
    assert.equal(r.ok, true);
    assert.equal(r.requeued, true, "the orphan must be re-chained, not absorbed");
    assert.equal(await waitFor(() => started.filter((x) => x === "orphan").length > ranBefore), true,
      "the re-dispatched execution must actually run");
  } finally { await engine.idle(); }
});
