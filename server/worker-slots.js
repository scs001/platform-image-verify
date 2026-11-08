// ── Worker pool ──────────────────────────────────────────────────────────────
//
// The task-worker slots (spec: worker-pool; ADR 0005): on-demand DshBridge
// instances, each pinned to ONE persona for its life, executing task-engine
// dispatches in parallel while the primary runtime serves the conversation.
//
// Design D1: a worker is the primary's bridge construction with a different
// agentPreset and a worker-local event pump — same composed profile (home,
// patches, credentials, HMR), no parallel bootstrap path. Outputs isolate by
// session id (every task runs in its own dedicated session).
//
// The engine's slot dispatcher (setSlotDispatcher) hands due executions here
// when the pool is active (TASK_WORKER_MAX > 0); at cap 0 the pool never
// registers and the engine's serial primary chain is exactly today's
// behavior. Tasks that find no slot (cap reached) queue FIFO until a worker
// frees; spawn failures fall back to the primary chain.

import { DshBridge } from "../dsh-bridge.js";
import * as engine from "../task-engine.js";
import * as chatHistory from "../chat-history.js";
import { collectTurn } from "./cron-runner.js";

const REAP_SCAN_MS = 60_000;
const IDLE_REAP_MS = 5 * 60_000;

// DshBridge's lifecycle end is the async shutdown() (the SDK's EOF→SIGTERM→
// SIGKILL ladder); test fakes expose a sync close(). Calling close?.() on a
// real bridge was a silent no-op that leaked the worker's dsh child.
function stopBridge(bridge) {
  try {
    if (typeof bridge?.shutdown === "function") {
      bridge.shutdown()?.catch?.(() => {});
    } else {
      bridge?.close?.();
    }
  } catch { /* best-effort */ }
}

function readCap() {
  const raw = process.env.TASK_WORKER_MAX;
  const n = Number(raw);
  if (raw === undefined || raw === "") return 0;
  if (!Number.isInteger(n) || n < 0) {
    console.warn(`[worker-pool] TASK_WORKER_MAX=${raw} is invalid; falling back to 0 (serial mode)`);
    return 0;
  }
  return n;
}

// attachWorkerPool(ctx, opts): inert unless cap > 0. ctx.workerSpawnParams
// carries the primary bridge's construction inputs (stashed in server.js).
// opts.spawnBridge/opts.idleReapMs exist for tests (fake bridges, fast reap).
export function attachWorkerPool(ctx, { spawnBridge = null, idleReapMs = IDLE_REAP_MS } = {}) {
  const cap = readCap();
  if (cap <= 0) {
    ctx.workerPool = null;
    return { cap: 0, drain: async () => {}, shutdown: () => {} };
  }
  console.log(`[worker-pool] active, TASK_WORKER_MAX=${cap}`);

  const workers = new Set(); // { id, persona, bridge, busy, collectors, activeTurns, lastUsedAt, inFlight, humanPriority }
  const waiting = []; // task ids FIFO, pool-owned queue
  let workerSeq = 0;
  // The human-priority extra slot (add-turn-mandate-lane): ONE worker may
  // exist beyond cap, spawned only for a humanPriority task and reserved for
  // human wakes while it lives — normal tasks never claim it, and a second
  // human wake queues while it is busy (the extra slot is one).
  let humanExtraOut = false;
  let reapTimer = null;

  const emitPoolState = () => {
    ctx.broadcast?.({
      type: "worker_pool",
      workers: [...workers].map((w) => ({ persona: w.persona, state: w.busy ? "busy" : "idle" })),
    });
  };

  // ── Worker-local event pump (design D3): collector routing ONLY — no web
  // broadcast, no trace, no agent-change translation. A bridge exit aborts
  // this worker's in-flight collector (interrupted, not failed).
  function pumpFor(worker) {
    return (notif) => {
      const { method } = notif || {};
      if (method === "bridge.exit" || method === "_bridge_crash") {
        const abort = worker.activeTurns.get(worker.currentSession);
        if (abort) abort("the worker runtime restarted mid-turn");
        return;
      }
      const collector = worker.collectors.get(worker.currentSession);
      collector?.(notif);
    };
  }

  async function spawnWorker(persona) {
    const construct = spawnBridge || ((params) => new DshBridge(params));
    // Per-member MCP patch (add-member-knowledge-profile): a worker is pinned
    // to ONE persona for its life, so the member's deployment identity can be
    // baked into a PRIVATE mcp patch (its own fd-memory row carrying the
    // member's deployment token, and the library row stamped with the
    // member's bound collections). The shared patch keeps serving the chat
    // lane byte-identically — this composition is additive and per-worker.
    // Fail-open: any compose failure falls back to the shared patch (the
    // persona runs with the owner-lane mount, exactly today's behavior).
    let memberPatchPath = null;
    try {
      memberPatchPath = (await ctx.composeMemberMcpPatch?.(persona)) ?? null;
    } catch (e) {
      console.warn(`[worker-pool] member patch compose failed for ${persona}; falling back to shared: ${e?.message || e}`);
    }
    const worker = {
      id: `worker-${++workerSeq}`,
      persona,
      busy: false,
      currentSession: null,
      collectors: new Map(),
      activeTurns: new Map(),
      lastUsedAt: Date.now(),
      inFlight: null,
      humanPriority: false,
    };
    worker.bridge = construct({
      ...ctx.workerSpawnParams,
      // The member's private mcp patch when one composed (per-member memory
      // token + library collections); null keeps the shared patch unchanged.
      ...(memberPatchPath ? { mcpPatchPath: memberPatchPath } : {}),
      agentPreset: persona,
      onEvent: pumpFor(worker),
    });
    await worker.bridge.start();
    workers.add(worker);
    console.log(`[worker-pool] spawned ${worker.id} for persona ${persona}`);
    emitPoolState();
    return worker;
  }

  // One task turn on a worker: the cron-runner contract minus the preset
  // switch (the worker IS its persona) and minus the primary bridge.
  async function runOnWorker(worker, task, { turnTimeoutMs }) {
    const sessionId = task.sessionId;
    worker.currentFleet = task.sourceTag?.fleetId ?? null;
    worker.currentSession = sessionId;
    worker.lastUsedAt = Date.now();
    chatHistory.recordMessage(sessionId, "user", task.prompt);
    if (task.sessionTitle) {
      try {
        chatHistory.setTitle(sessionId, task.sessionTitle);
      } catch { /* sanitize failure leaves the prompt-derived title */ }
    }
    const collected = collectTurn(ctx, sessionId, turnTimeoutMs, worker.activeTurns, worker.collectors);
    let result;
    try {
      await worker.bridge.prompt(sessionId, [{ type: "text", text: task.prompt }]);
      result = await collected;
    } catch (e) {
      // prompt 抛错时 collectTurn 的 promise 还挂着：它内部挂着 turnTimeout 定时器
      // （默认 10 分钟），而这里原先只 delete 掉 abort/collector 两个表项，没有让它结算
      // ——于是十分钟后它以**未处理拒绝**的形式炸出来（实测 2026-11-08：一条
      // "prompt 抛错"的用例让整个测试文件以 "promise pending while event loop resolved" 失败）。
      // 正确做法是先主动结算（interrupted 语义），再清表；真正的错误照旧返回给引擎。
      const abortTurn = worker.activeTurns.get(sessionId);
      worker.collectors.delete(sessionId);
      worker.activeTurns.delete(sessionId);
      try {
        abortTurn?.(`worker prompt failed: ${e?.message || String(e)}`);
        collected.catch(() => {}); // 结算后的拒绝由此吞掉；调用方拿的是下面的返回值
      } catch { /* 结算失败不能掩盖原始错误 */ }
      return { ok: false, error: e?.message || String(e), interrupted: e?.interrupted === true };
    } finally {
      worker.currentSession = null;
    }
    if (result.error) return { ok: false, error: result.error };
    return { ok: true, usage: result.usage ?? null };
  }

  // Run one queued task id on a worker slot, then service the wait queue.
  async function runTaskOn(worker, id) {
    // Turn metering (add-turn-metering D3): the slot claimant is the only
    // authority on "this ran on a worker" — mark before the execution reads it.
    engine.markExecutionCarrier?.(id, "worker", worker.id);
    worker.busy = true;
    emitPoolState();
    try {
      await engine.beginExecution(id, (task, opts) => runOnWorker(worker, task, opts));
    } finally {
      worker.busy = false;
      worker.currentFleet = null;
      worker.lastUsedAt = Date.now();
      emitPoolState();
      scheduleNext();
    }
  }

  // Assign waiting tasks to idle workers (persona affinity), spawning while
  // under cap. `spawning` counts in-flight spawn()s SYNCHRONOUSLY — the cap
  // check must hold before the async spawn lands the worker in the set, or
  // two simultaneous due tasks both see room for themselves.
  let spawning = 0;
  // Fleet admission gate (add-fleet-carrier): per-fleet in-flight ceiling —
  // the fleet dimension of "agents decide, platform caps". Queued, never
  // failed or preempted; a slot release lets the FIFO proceed. Remote turns
  // are NOT counted (runner-side budget governs those).
  // The spawn→runTaskOn gap is async — a fleet's second task could slip past
  // the gate while the first worker is still materializing. pendingFleets
  // bridges it: incremented SYNCHRONOUSLY at claim time, decremented once the
  // worker records its currentFleet.
  const pendingFleets = new Map();
  function fleetInFlight(fleetId) {
    if (!fleetId) return 0;
    return [...workers].filter((w) => w.busy && w.currentFleet === fleetId).length + (pendingFleets.get(fleetId) ?? 0);
  }
  function scheduleNext() {
    const fleetCap = (() => {
      const n = Number(process.env.FLEET_MAX_INFLIGHT);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
    })();
    while (waiting.length) {
      const idx = waiting.findIndex((id) => {
        const t = engine.getRecord(id);
        if (!t || t.paused || t.status === "expired" || t.status === "completed") return false;
        const persona = t.preset;
        if (!persona) return false;
        const fleetId = t.sourceTag?.fleetId ?? null;
        if (fleetId && fleetInFlight(fleetId) >= fleetCap) return false; // admission gate: stay queued
        const human = t.humanPriority === true;
        // Idle match: a human wake may take the idle human-priority worker
        // (the extra slot); normal tasks never do — it stays reserved.
        if ([...workers].some((w) => !w.busy && w.persona === persona && (!w.humanPriority || human))) return true;
        // Spawn room: within cap as before; the ONE extra slot beyond cap
        // exists only for a human wake while none is outstanding.
        if (workers.size + spawning < cap) return true;
        return human && !humanExtraOut;
      });
      if (idx === -1) return;
      const id = waiting.splice(idx, 1)[0];
      const task = engine.getRecord(id);
      if (!task) continue;
      const persona = task.preset;
      const human = task.humanPriority === true;
      const idle = [...workers].find((w) => !w.busy && w.persona === persona && (!w.humanPriority || human));
      if (idle) {
        const idleFleetId = task.sourceTag?.fleetId ?? null;
        if (idleFleetId) pendingFleets.set(idleFleetId, (pendingFleets.get(idleFleetId) ?? 0) + 1);
        const p = runTaskOn(idle, id);
        if (idleFleetId) {
          const left = (pendingFleets.get(idleFleetId) ?? 1) - 1;
          if (left <= 0) pendingFleets.delete(idleFleetId);
          else pendingFleets.set(idleFleetId, left);
        }
        void p;
        continue;
      }
      // The extra slot: computed BEFORE the spawning increment — at/beyond
      // cap, only a human wake with no extra outstanding may spawn. The
      // claim books SYNCHRONOUSLY here (the spawn→run gap is async — the
      // same class of race pendingFleets bridges); the .then only pins the
      // worker's flag once it exists.
      const beyondCap = workers.size + spawning >= cap;
      if (beyondCap) humanExtraOut = true;
      spawning++;
      const spawnFleetId = task.sourceTag?.fleetId ?? null;
      if (spawnFleetId) pendingFleets.set(spawnFleetId, (pendingFleets.get(spawnFleetId) ?? 0) + 1);
      spawnWorker(persona)
        .then((w) => {
          spawning--;
          if (beyondCap) w.humanPriority = true;
          const p = runTaskOn(w, id);
          if (spawnFleetId) {
            const left = (pendingFleets.get(spawnFleetId) ?? 1) - 1;
            if (left <= 0) pendingFleets.delete(spawnFleetId);
            else pendingFleets.set(spawnFleetId, left);
          }
          return p;
        })
        .catch((err) => {
          spawning--;
          if (beyondCap) humanExtraOut = false; // the extra spawn never landed
          console.error(`[worker-pool] spawn for ${persona} failed: ${err.message}; task ${id} falls back to the primary slot`);
          engine.runOnPrimary(id);
        });
    }
  }

  // The engine's slot dispatcher: claim persona-targeted executions whenever
  // the pool can serve them now or soon; anything else goes to the primary.
  function dispatcher(task) {
    if (!task) return false;
    if (task.trigger !== "manual" && task.trigger !== "schedule") return false;
    // Carrier gate (add-fleet-carrier): the CONFIGURED placement decides
    // claim eligibility — cell tasks stay on the primary chain, runner tasks
    // route through the remote executor; only worker/auto tasks are claimed.
    // auto = today's behavior (claim when the pool is active).
    const carrier = task.carrier ?? "auto";
    if (carrier === "cell" || carrier === "runner") return false;
    // a2a targets are remote turns (add-agent-delegation-a2a) — no persona to
    // pin; they ride the primary chain's remote executor.
    if (task.targetType === "a2a") return false;
    // Cluster targets (agent-cluster-platform): `preset` carries the cluster
    // id, not a persona — a worker pinned to it would boot a broken child.
    // The primary chain's cluster executor fans members out itself.
    if (task.targetType === "cluster") return false;
    // Null-ref (legacy live-preset) tasks have no persona to pin a worker to.
    if (!task.preset) return false;
    waiting.push(task.id);
    scheduleNext();
    return true;
  }

  reapTimer = setInterval(() => {
    let changed = false;
    for (const w of [...workers]) {
      if (w.busy) continue;
      if (Date.now() - w.lastUsedAt > idleReapMs) {
        workers.delete(w);
        if (w.humanPriority) humanExtraOut = false; // the extra slot frees with its worker
        changed = true;
        stopBridge(w.bridge);
        console.log(`[worker-pool] reaped ${w.id} (persona ${w.persona}, idle)`);
      }
    }
    if (changed) {
      emitPoolState();
      // Freed capacity re-opens the waiting queue — a reap must dispatch, or
      // queued tasks starve until the next turn's finally.
      scheduleNext();
    }
  }, Math.min(REAP_SCAN_MS, Math.max(200, idleReapMs)));
  reapTimer.unref?.();

  engine.setSlotDispatcher(dispatcher);

  return {
    cap,
    // Read-only occupancy for the fleet stats snapshot — counts only, never
    // personas (the WS broadcast carries those for the UI; telemetry does not).
    poolStats: () => {
      const busy = [...workers].filter((w) => w.busy).length;
      return { cap, busy, idle: workers.size - busy };
    },
    drain: async () => {
      // Aggregator gate (design D4): wait out every in-flight worker turn.
      while ([...workers].some((w) => w.busy)) {
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    shutdown: () => {
      if (reapTimer) clearInterval(reapTimer);
      for (const w of workers) stopBridge(w.bridge);
      workers.clear();
    },
  };
}
