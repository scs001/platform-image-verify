// Unit tests for the worker pool (add-worker-pool) with fake bridges:
// persona-affinity spawn, parallel execution, FIFO queueing at cap, idle
// reap with cold restart, spawn-failure fallback to the primary chain, and
// pool-state broadcasts. The engine runs REAL (task-engine.js) against a
// temp store; only the bridge is fake.
//
// Run: node --test scripts/test-worker-pool.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worker-pool-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.TASK_WORKER_MAX = "2";

const engine = await import("../task-engine.js");
const { attachWorkerPool } = await import("../server/worker-slots.js");

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// A fake bridge whose turns complete only when the test releases them.
class FakeBridge {
  static byPersona = new Map();
  constructor(params) {
    this.params = params;
    this.persona = params.agentPreset;
    this.closed = false;
    this.prompts = [];
    FakeBridge.byPersona.set(this.persona, this);
  }
  async start() {
    this.ready = true;
  }
  isReady() {
    return this.ready && !this.closed;
  }
  async prompt(sessionId, blocks) {
    this.prompts.push({ sessionId, blocks });
    this.emit({ method: "session.event", params: { event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "stub reply" }] } } } } });
    await new Promise((resolve, reject) => {
      this.release = resolve;
      // E21 acceptance: let a test reject the in-flight prompt AFTER it has
      // started, which is the shape that used to leave the turn unaccounted
      // (prompt throws, the collector promise is still hanging).
      this.failPrompt = reject;
    });
    this.emit({ method: "session.status", params: { status: "idle" } });
  }
  // Reject the prompt currently awaiting release (no-op if none is in flight).
  failWith(err) {
    this.failPrompt?.(err);
  }
  emit(notif) {
    this.params.onEvent(notif);
  }
  close() {
    this.closed = true;
  }
}

function makeCtx(events) {
  return {
    broadcast: (e) => events.push(e),
    sessionCollectors: new Map(),
    workerSpawnParams: { provider: "finddata", model: "stub" },
  };
}

async function bootEngine(runTurn) {
  fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async (t, o) => (runTurn ? runTurn(t, o) : { ok: true }),
    isBusy: () => false,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// Deterministic teardown: any bridge still mid-turn gets released so no
// collector timer outlives the test file.
const releaseAll = () => {
  for (const bridge of FakeBridge.byPersona.values()) {
    bridge.release?.();
  }
};

test("two personas execute in parallel; primary never runs them", async () => {
  await bootEngine();
  const events = [];
  const ctx = makeCtx(events);
  attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
  const b = engine.createManualTask({ prompt: "B", persona: "minimal", initiator: "s1" });

  // Both running simultaneously (parallel claim — the serial chain would not).
  await settle();
  await settle();
  assert.equal(engine.getTask(a.id).state, "running");
  assert.equal(engine.getTask(b.id).state, "running");
  assert.equal(FakeBridge.byPersona.get("code").prompts.length, 1);
  assert.equal(FakeBridge.byPersona.get("minimal").prompts.length, 1);

  FakeBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  assert.equal(engine.getTask(b.id).state, "running"); // still going
  FakeBridge.byPersona.get("minimal").release();
  await settle();
  assert.equal(engine.getTask(b.id).state, "done");
  assert.ok(events.some((e) => e.type === "worker_pool"));
  releaseAll();
  engine.setSlotDispatcher(null);
});

test("cap 1 queues the second persona task until the slot frees", async () => {
  await bootEngine();
  process.env.TASK_WORKER_MAX = "1";
  const ctx = makeCtx([]);
  attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
  const b = engine.createManualTask({ prompt: "B", persona: "code", initiator: "s1" });
  await settle();
  assert.equal(engine.getTask(a.id).state, "running");
  // Same persona, single slot: the second waits (worker reuse, no second spawn).
  assert.equal(engine.getTask(b.id).state, "queued");

  FakeBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  await settle();
  assert.equal(engine.getTask(b.id).state, "running");
  FakeBridge.byPersona.get("code").release();
  await settle();
  assert.equal(engine.getTask(b.id).state, "done");
  releaseAll();
  engine.setSlotDispatcher(null);
  process.env.TASK_WORKER_MAX = "2";
});

test("idle reap shuts a worker; a later task cold-starts", async () => {
  await bootEngine();
  const ctx = makeCtx([]);
  const pool = attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p), idleReapMs: 60 });

  const a = engine.createManualTask({ prompt: "A", persona: "cordis", initiator: "s1" });
  await settle();
  FakeBridge.byPersona.get("cordis").release();
  await settle();
  assert.equal(engine.getTask(a.id).state, "done");
  const first = FakeBridge.byPersona.get("cordis");

  await new Promise((r) => setTimeout(r, 250)); // > reap scan + idle window
  assert.equal(first.closed, true);

  const b = engine.createManualTask({ prompt: "B", persona: "cordis", initiator: "s1" });
  await settle();
  const second = FakeBridge.byPersona.get("cordis");
  assert.notEqual(second, first);
  assert.equal(engine.getTask(b.id).state, "running");
  second.release();
  await settle();
  assert.equal(engine.getTask(b.id).state, "done");
  pool.shutdown();
  engine.setSlotDispatcher(null);
});

test("spawn failure falls back to the primary chain", async () => {
  let primaryRuns = 0;
  await bootEngine(async () => {
    primaryRuns++;
    return { ok: true };
  });
  const ctx = makeCtx([]);
  attachWorkerPool(ctx, {
    spawnBridge: () => ({
      async start() {
        throw new Error("no budget");
      },
      close() {},
    }),
  });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
  await settle();
  await settle();
  assert.equal(primaryRuns, 1);
  assert.equal(engine.getTask(a.id).state, "done");
  engine.setSlotDispatcher(null);
});

// ── Human-priority extra slot (add-turn-mandate-lane) ────────────────────────
// Semantics under test: ONE worker may exist beyond cap; it is spawned only
// for a humanPriority task; while it exists a second human wake queues (the
// extra slot is singular) and normal tasks never claim it — not even idle.
// The reservation pins run with the DEFAULT reap window (no reap can fire
// mid-test); the reap-frees-slot behavior gets its own test with a short
// window. Tests that end with queued leftovers document it: a detached pool
// never drains them, and no later test asserts global task counts.

const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};

test("a human wake uses the extra slot at full cap; the slot is singular and human-only", async () => {
  await bootEngine();
  process.env.TASK_WORKER_MAX = "1";
  try {
    const ctx = makeCtx([]);
    const pool = attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

    const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
    assert.ok(await waitFor(() => engine.getTask(a.id).state === "running"), "cap slot fills");

    // A human wake at full cap: spawns the ONE extra worker beyond cap.
    const h = engine.createManualTask({ prompt: "H", persona: "minimal", initiator: "s1", humanPriority: true });
    assert.ok(await waitFor(() => engine.getTask(h.id).state === "running"), "the human wake runs on the extra slot");

    // A normal task queues: within-cap is full, the extra slot is not for it.
    const b = engine.createManualTask({ prompt: "B", persona: "minimal", initiator: "s1" });
    // A second human wake queues too — the extra slot is singular.
    const h2 = engine.createManualTask({ prompt: "H2", persona: "cordis", initiator: "s1", humanPriority: true });
    await settle();
    assert.equal(engine.getTask(b.id).state, "queued", "a normal task never takes the extra slot");
    assert.equal(engine.getTask(h2.id).state, "queued", "the extra slot is singular");

    FakeBridge.byPersona.get("minimal").release(); // h done; the extra goes idle
    assert.ok(await waitFor(() => engine.getTask(h.id).state === "done"));
    await settle();
    assert.equal(engine.getTask(b.id).state, "queued", "an idle extra worker stays reserved for humans");
    assert.equal(engine.getTask(h2.id).state, "queued", "a second human wake queues while the extra worker exists");

    FakeBridge.byPersona.get("code").release(); // a done — a within-cap slot frees
    assert.ok(await waitFor(() => engine.getTask(a.id).state === "done"));
    await settle();
    // Still queued: the freed within-cap worker is persona code (no affinity
    // for b/h2), and spawning beyond cap stays blocked for a normal task and
    // for a second human wake while the extra worker exists.
    assert.equal(engine.getTask(b.id).state, "queued", "no within-cap room, no spawn for a normal task");
    assert.equal(engine.getTask(h2.id).state, "queued", "no second extra while the first lives");
    pool.shutdown();
  } finally {
    releaseAll();
    engine.setSlotDispatcher(null);
    process.env.TASK_WORKER_MAX = "2";
  }
});

test("reaping the idle extra frees the slot for the next human wake", async () => {
  await bootEngine();
  process.env.TASK_WORKER_MAX = "1";
  try {
    const ctx = makeCtx([]);
    attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p), idleReapMs: 60 });

    const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
    assert.ok(await waitFor(() => engine.getTask(a.id).state === "running"));
    const h = engine.createManualTask({ prompt: "H", persona: "minimal", initiator: "s1", humanPriority: true });
    assert.ok(await waitFor(() => engine.getTask(h.id).state === "running"));
    const h2 = engine.createManualTask({ prompt: "H2", persona: "cordis", initiator: "s1", humanPriority: true });
    await settle();
    assert.equal(engine.getTask(h2.id).state, "queued", "queued while the extra worker exists");

    FakeBridge.byPersona.get("minimal").release(); // extra goes idle → reaps (60ms)
    assert.ok(await waitFor(() => engine.getTask(h2.id).state === "running"), "h2 spawns once the extra slot frees");
    FakeBridge.byPersona.get("cordis").release();
    assert.ok(await waitFor(() => engine.getTask(h2.id).state === "done"));
    FakeBridge.byPersona.get("code").release();
    assert.ok(await waitFor(() => engine.getTask(a.id).state === "done"));
  } finally {
    releaseAll();
    engine.setSlotDispatcher(null);
    process.env.TASK_WORKER_MAX = "2";
  }
});

test("a human wake reuses an idle extra worker; a normal task waits it out", async () => {
  await bootEngine();
  process.env.TASK_WORKER_MAX = "1";
  try {
    const ctx = makeCtx([]);
    const pool = attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

    const filler = engine.createManualTask({ prompt: "F", persona: "code", initiator: "s1" });
    assert.ok(await waitFor(() => engine.getTask(filler.id).state === "running"));
    const h = engine.createManualTask({ prompt: "H", persona: "minimal", initiator: "s1", humanPriority: true });
    assert.ok(await waitFor(() => engine.getTask(h.id).state === "running"), "the extra worker serves the human wake");
    FakeBridge.byPersona.get("minimal").release();
    assert.ok(await waitFor(() => engine.getTask(h.id).state === "done"));

    // The idle extra is reserved: a normal same-persona task must not claim it.
    const b = engine.createManualTask({ prompt: "B", persona: "minimal", initiator: "s1" });
    await settle();
    assert.equal(engine.getTask(b.id).state, "queued", "idle extra worker stays reserved for humans");

    // A human wake reuses the idle extra worker immediately.
    const h2 = engine.createManualTask({ prompt: "H2", persona: "minimal", initiator: "s1", humanPriority: true });
    assert.ok(await waitFor(() => engine.getTask(h2.id).state === "running"), "a human wake reuses the idle extra worker");
    FakeBridge.byPersona.get("minimal").release();
    assert.ok(await waitFor(() => engine.getTask(h2.id).state === "done"));
    // Leftover: b stays queued while the extra worker lives (default reap
    // window) — documented, see the file-header note.
    pool.shutdown();
  } finally {
    releaseAll();
    engine.setSlotDispatcher(null);
    process.env.TASK_WORKER_MAX = "2";
  }
});

test("cap 0: humanPriority is inert (the pool never registers)", async () => {
  await bootEngine();
  process.env.TASK_WORKER_MAX = "0";
  try {
    const ctx = makeCtx([]);
    const pool = attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });
    assert.equal(pool.cap, 0);
    assert.equal(ctx.workerPool, null);
    const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1", humanPriority: true });
    assert.ok(await waitFor(() => engine.getTask(a.id).state === "done"), "the primary chain runs it, byte-identical");
  } finally {
    releaseAll();
    engine.setSlotDispatcher(null);
    process.env.TASK_WORKER_MAX = "2";
  }
});

// ── 回合抛错：槽位要还、collector 要结算（2026-11-08 补）─────────────────
//
// 两件事一起钉，因为它们同源：
//   1. 失败回合必须归还槽位，否则后续排队永久卡住（cap>0 时唯一的死锁来源）；
//   2. prompt 抛错时 collectTurn 的 promise 必须被结算——它挂着 turnTimeout 定时器，
//      原先只 delete 表项不结算，十分钟后会以未处理拒绝炸出来（实证见提交信息）。
test("a turn that rejects releases its slot and settles its collector", async () => {
  await bootEngine();
  const events = [];
  const ctx = makeCtx(events);

  // 只有第一条 prompt 抛错；worker 会被复用，第二次必须放行。
  let promptCalls = 0;
  class FlakyBridge extends FakeBridge {
    async prompt(sessionId, blocks) {
      promptCalls += 1;
      if (promptCalls === 1) throw new Error("boom");
      return super.prompt(sessionId, blocks);
    }
  }
  attachWorkerPool(ctx, { spawnBridge: (p) => new FlakyBridge(p) });

  const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
  await settle();
  await settle();
  assert.equal(engine.getTask(a.id).state, "failed", "the first turn must fail on its own error");

  // 槽位归还：第二个任务必须离开队列（不再是 queued）
  const b = engine.createManualTask({ prompt: "B", persona: "code", initiator: "s1" });
  await settle();
  await settle();
  assert.notEqual(engine.getTask(b.id).state, "queued",
    "a failed turn must hand its slot back, otherwise the queue deadlocks");
  assert.ok(promptCalls >= 2, `second task must reach the bridge, got ${promptCalls} calls`);

  // collector 结算：activeTurns/collectors 里不该残留这个会话
  const leftovers = [...(ctx.sessionCollectors?.keys?.() ?? [])];
  assert.equal(leftovers.length, 0, `a settled turn must not leave collectors behind: ${leftovers}`);

  for (let i = 0; i < 10; i += 1) {
    releaseAll();
    await settle();
    if (!["running", "queued"].includes(engine.getTask(b.id).state)) break;
  }
  engine.setSlotDispatcher(null);
});

// ── 池级看门狗：不结算的回合不能永久占槽（2026-11-08 补）────────────────
//
// 为什么必须有：cap>0 时 dispatcher 把任务直接塞进 beginExecution，**不经过串行链**，
// 所以串行链的 `runQueuedExecutionWithWatchdog` 根本看不到它们。没有池级看门狗，
// 一个永不结算的回合会一直占着槽；cap=2 时等于静默腰斩吞吐。
test("a worker turn that never settles is reaped by the pool watchdog", async () => {
  await bootEngine();
  const events = [];
  const ctx = makeCtx(events);

  // 永不返回的 prompt：模拟"回合不结算"（真机上就是拿不到模型、上游不回包）。
  // 收尾时由测试主动放掉——看门狗只结算**台账**，被卡的 prompt 本身仍挂着
  // （这是串行链就有的已知残留，不是本用例的漏洞；不放掉会让文件级以
  // "promise pending while event loop resolved" 失败）。
  let releaseHung = null;
  class HungBridge extends FakeBridge {
    async prompt(sessionId) {
      this.prompts.push({ sessionId, blocks: [] });
      await new Promise((resolve) => {
        releaseHung = () => {
          this.emit({ method: "session.status", params: { status: "idle" } });
          resolve();
        };
      });
    }
  }
  // 显式传 watchdogMs，不经过 env：同文件多用例共享 process.env，靠 env 会被
  // 别的用例的 teardown 抹掉（远端基上实测就红在这）。
  attachWorkerPool(ctx, { spawnBridge: (p) => new HungBridge(p), watchdogMs: 120 });

  try {
    const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
    await settle();
    assert.equal(engine.getTask(a.id).state, "running", "turn should be in flight first");

    // 看门狗到点后必须把它结算掉，而不是让它永远 running
    await new Promise((r) => setTimeout(r, 400));
    const state = engine.getTask(a.id).state;
    assert.notEqual(state, "running", `watchdog must settle a hung turn, still ${state}`);
    assert.match(String(engine.getTask(a.id).error ?? ""), /watchdog/i,
      "the settlement must say it was the watchdog, not a silent stop");

    // 关键的一半：槽位真的被释放了。只结算台账而不 abort 回合时，`await exec`
    // 永不返回、finally 不执行，槽位会被永久占住——而状态断言对此完全无感
    // （第一版实现就漏了这步，此断言是对准它的）。
    const b = engine.createManualTask({ prompt: "B", persona: "code", initiator: "s1" });
    await settle();
    await settle();
    assert.notEqual(engine.getTask(b.id).state, "queued",
      "the slot must be reusable after the watchdog fires, otherwise the pool deadlocks");
    FakeBridge.byPersona.get("code")?.release?.();
  } finally {
    releaseHung?.();
    engine.setSlotDispatcher(null);
    // 让残留的写盘链与定时器落完再结束本用例：saveTasks 是 `void` 链式写，
    // 用例结束即删临时目录会让它 ENOENT（同一竞态在 test-queue-health 里也踩过）。
    for (let i = 0; i < 6; i += 1) {
      releaseAll();
      await settle();
    }
  }
});

// ── E21: a worker turn must leave the SAME accounting row a serial turn does
// (fix-fleet-replay-dispatch-and-turn-accounting 2.1). Live 2026-11-08: a job
// reported state=done success=true with token usage while member_turn_events
// had no row for it at all — worker throughput was invisible to every audit
// surface. These two cases pin the missing call in both directions.
test("a worker turn settles ctx.recordFleetTurnEvent (success path)", async () => {
  await bootEngine();
  const events = [];
  const ctx = makeCtx(events);
  const recorded = [];
  ctx.recordFleetTurnEvent = (job, outcome, meta) => {
    recorded.push({ jobId: job?.id, ok: outcome?.ok, startedAt: meta?.startedAt, endedAt: meta?.endedAt });
    return null;
  };
  attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

  try {
    const a = engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
    await settle();
    await settle();
    assert.equal(recorded.length, 0, "no row before the turn settles");
    FakeBridge.byPersona.get("code").release();
    await settle();
    await settle();
    assert.equal(engine.getTask(a.id).state, "done");
    assert.equal(recorded.length, 1, "a worker turn MUST leave exactly one turn row");
    assert.equal(recorded[0].jobId, a.id);
    assert.equal(recorded[0].ok, true);
    assert.ok(Number.isFinite(recorded[0].startedAt) && recorded[0].endedAt >= recorded[0].startedAt,
      "the row must carry a real time window (queue_wait_ms/turn duration derive from it)");
  } finally {
    releaseAll();
    engine.setSlotDispatcher(null);
    for (let i = 0; i < 6; i += 1) { releaseAll(); await settle(); }
  }
});

test("a worker turn records exactly once even when the bridge throws", async () => {
  await bootEngine();
  const events = [];
  const ctx = makeCtx(events);
  const recorded = [];
  ctx.recordFleetTurnEvent = (job, outcome, meta) => {
    recorded.push({ jobId: job?.id, ok: outcome?.ok });
    return null;
  };
  attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });

  try {
    // Side effect only — this case never reads the task handle.
    engine.createManualTask({ prompt: "A", persona: "code", initiator: "s1" });
    await settle();
    await settle();
    // The bridge rejects BEFORE the collector produced an outcome: the failure
    // path settles, and the success path must not settle a second time.
    FakeBridge.byPersona.get("code").failWith(new Error("bridge exploded"));
    await settle();
    await settle();
    assert.equal(recorded.length, 1, "a failed worker turn still leaves ONE row (idempotent settle)");
    assert.equal(recorded[0].ok, false);
  } finally {
    releaseAll();
    engine.setSlotDispatcher(null);
    for (let i = 0; i < 6; i += 1) { releaseAll(); await settle(); }
  }
});

// ── worker session rotation (fix-worker-session-rotation) ───────────────────
//
// The serial chain rotates the child conversation id per round
// (fix-fleet-round-discipline: a stable id accumulated every round's history
// until compaction ate the budget). The pool path kept prompting the MIRROR id,
// which had two measured consequences on 2026-11-09: worker rounds re-read their
// own accumulated conversation, and above one slot the same id was claimed from
// two places at once (`session "…" is already owned by …` — 6 rounds, first seen
// the hour the pool went from 1 to 3).
//
// The mirror id must stay the transcript/sidebar id; only the runtime prompt
// moves to the rotated child.

test("worker turns prompt a ROTATED child session, never the mirror id", async () => {
  await bootEngine();
  process.env.TASK_WORKER_MAX = "1";
  try {
    const ctx = makeCtx([]);
    attachWorkerPool(ctx, { spawnBridge: (p) => new FakeBridge(p) });
    const t = engine.createManualTask({
      prompt: "R", persona: "code", initiator: "s1",
      // createManualTask derives sourceTag from origin.fleet (it does not take a
      // sourceTag argument), which is exactly the shape a fleet dispatch has.
      origin: { fleet: { fleetId: "f_rot", memberId: "m_rot", depth: 1 } },
    });
    await settle();
    await settle();

    const bridge = FakeBridge.byPersona.get("code");
    assert.ok(bridge, "a worker was spawned");
    assert.equal(bridge.prompts.length, 1, "one prompt went out");
    const prompted = bridge.prompts[0].sessionId;
    assert.notEqual(prompted, t.sessionId, "the runtime is NOT prompted on the mirror id");
    assert.match(prompted, /#r\d+/, "it carries the per-round rotation suffix");

    bridge.release();
    await settle();
    await settle();
    assert.equal(engine.getTask(t.id).state, "done");
    releaseAll();
    engine.setSlotDispatcher(null);
  } finally {
    process.env.TASK_WORKER_MAX = "2";
  }
});
