// ── Task engine ───────────────────────────────────────────────────────────────
//
// The unified in-cell task engine (add-task-engine; ADR 0006): one task
// concept for all unattended agent work. A task carries a target (the persona
// that executes it), a prompt, a dedicated session, and a trigger; scheduling
// is one trigger kind and lives in cron.js — this module owns task records,
// the execution lifecycle (queued → running → done | failed | interrupted),
// the serialized execution queue, restart repair, and the task event surface.
//
// Execution runs on execution slots (ADR 0005); the primary slot is the only
// one today and is the cron-runner turn flow, injected as `runTurn`. Worker
// slots (change ③) will add executors without touching the task model here.

import fs from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";
import { atomicWriteJson, readJsonOr, createWriteChain } from "./lib/persistence.js";

const TASK_STORAGE_DIR = storeDir("cron-store", process.env.CRON_STORAGE_PATH);
const JOBS_FILE = path.join(TASK_STORAGE_DIR, "jobs.json");

// Same file, same ids as the pre-engine cron store — records gain fields,
// nothing moves (design D1: one store, extended in place).
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 100;
// a2a targets (market Agent Services) are supported when the cell's catalog
// holds online a2a entries — executed as remote turns (add-agent-delegation-a2a).
const SUPPORTED_TARGET_TYPES = ["persona", "a2a", "cluster", "tool"];
const SUPPORTED_TRIGGERS = ["schedule", "manual"];

let tasks = new Map(); // id -> task record (loaded from disk + live schedule
// handle on .job owned by cron.js)
let broadcastFn = null;
let runTurnFn = null;
// Readiness gate: routes are mounted before initTaskEngine runs (it waits on
// the boot Promise.all), so a task created-and-run on a COLD cell could reach
// the chain with no turn executor ("turnFn is not a function", prod 2026-10-21)
// and an insert could land in the pre-init map that init then replaces.
let initialized = false;
let isBusyFn = null;
// Worker-pool occupancy provider (unify-wanxing-management-plane): injected by
// the server layer so the stats snapshot can speak for slots this module does
// not own. Read lazily at snapshot time — the pool attaches after init.
let workerStatsFn = null;
// The scheduling front-end refreshes nextRun; the delegation aggregator arms
// summary injections. Multiple subscribers, order-independent, each guarded.
const onFinishedHooks = new Set();
// The scheduling front-end's last chance to shape a prompt before the turn
// runs (fix-fleet-context-injection-seam). Injected once by initTaskEngine and
// awaited in runExecutionTurn — the ONE point every enqueue path converges on,
// which is why the seam lives here rather than at the enqueue sites that used
// to arm prompt overrides (two of which had already been missed: manual
// run-now, and the boot-time repair queue). The engine knows nothing about
// fleets; it only offers a seam.
let beforeTurnFn = null;
let executionQueue = Promise.resolve();
const repairQueue = []; // ids persisted as queued at load → re-enqueue after init

// ── Persistence ─────────────────────────────────────────────────────────────

// Serialized + atomic persistence: mutations rewrite the whole tasks file, so
// overlapping saves are queued (no lost update) and each write goes through a
// unique temp file (no interleaved-write corruption).
const writeChain = createWriteChain();
function saveTasks() {
  return writeChain.mutate(async () => {
    // Serialize only the task data (excluding the live node-schedule handle).
    // Computed inside the queued task so a later save always sees the latest
    // in-memory state.
    const serializable = [...tasks.values()].map((t) => ({
      id: t.id,
      trigger: t.trigger ?? "schedule",
      type: t.type,
      cron: t.cron,
      when: t.when,
      prompt: t.prompt,
      preset: t.preset ?? null,
      targetType: t.targetType ?? "persona",
      // Cluster binding (agent-cluster-platform): persisted alongside the ref
      // in `preset` — without these a cell restart reloaded cluster tasks with
      // their policy/subset/label gone (prod 2026-10-21: list showed null,
      // re-runs silently fell back to all-members/sequential).
      ...(t.targetType === "cluster"
        ? {
            clusterId: t.clusterId ?? null,
            clusterName: t.clusterName ?? null,
            agentCount: t.agentCount ?? null,
            executionPolicy: t.executionPolicy ?? null,
            targetAgents: t.targetAgents ?? null,
          }
        : {}),
      sessionId: t.sessionId ?? null,
      sessionTitle: t.sessionTitle ?? null,
      tz: t.tz ?? null,
      status: t.status,
      state: t.state ?? null,
      error: t.error ?? null,
      initiator: t.initiator ?? null,
      initiatorPreset: t.initiatorPreset ?? null,
      origin: t.origin ?? null,
      // Owning front-end tag (agent-fleet-core: { fleetId, memberId }). An
      // opaque passthrough on every surface — the engine never interprets it;
      // the fleet reconcile layer locates its materialized tasks by it.
      sourceTag: t.sourceTag ?? null,
      aggregated: t.aggregated ?? false,
      paused: t.paused,
      createdAt: t.createdAt,
      lastRun: t.lastRun,
      nextRun: t.nextRun,
      missed: t.missed ?? 0,
      history: t.history,
    }));
    await atomicWriteJson(JOBS_FILE, serializable);
  });
}

// Derive the execution state a legacy record (pre-engine, no `state` field)
// implies from its history, so the UI can offer re-run on old failures.
function deriveLegacyState(record) {
  const last = Array.isArray(record.history) ? record.history[record.history.length - 1] : null;
  if (!last) return null;
  if (last.success === true) return "done";
  if (last.success === false) return "failed";
  return null;
}

// Load-time backfill + repair. Backfill: legacy records gain trigger/target
// fields and a stable session id. Repair: `running` becomes `interrupted`
// (never re-executed), `queued` is collected for re-enqueue after the
// scheduling front-end initializes.
function loadTasks() {
  repairQueue.length = 0;
  const saved = readJsonOr(JOBS_FILE, [], { label: "task-engine" });
  if (!Array.isArray(saved)) return false;
  let dirty = false;
  for (const data of saved) {
    const t = { missed: 0, state: null, error: null, ...data };
    if (!t.trigger) {
      t.trigger = "schedule";
      dirty = true;
    }
    if (!t.targetType) {
      t.targetType = "persona";
      dirty = true;
    }
    if (!t.sessionId) {
      // Backfill: mint the dedicated session id legacy records never had, so
      // the binding is stable across restarts from the first reload on.
      t.sessionId = `cron-${t.id}`;
      dirty = true;
    }
    if (!t.state) {
      // Legacy record: status was never persisted mid-run (no save between
      // "running" and completion), so a stray one is treated as interrupted;
      // otherwise the last history outcome decides.
      if (t.status === "running") {
        t.state = "interrupted";
        t.error = "cell restarted during execution";
      } else {
        t.state = deriveLegacyState(t);
      }
      dirty = true;
    } else if (t.state === "running") {
      t.state = "interrupted";
      t.error = "cell restarted during execution";
      dirty = true;
    }
    if (t.state === "queued") {
      repairQueue.push(t.id);
    }
    tasks.set(t.id, { ...t, job: null });
  }
  console.log(`[task-engine] Loaded ${tasks.size} task(s) from storage`);
  return dirty;
}

// ── Initialization ──────────────────────────────────────────────────────────

async function initTaskEngine({ broadcast, runTurn, isBusy, onFinished, workerStats, beforeTurn }) {
  broadcastFn = broadcast;
  runTurnFn = runTurn;
  isBusyFn = isBusy;
  workerStatsFn = typeof workerStats === "function" ? workerStats : null;
  beforeTurnFn = typeof beforeTurn === "function" ? beforeTurn : null;
  onFinishedHooks.clear();
  if (onFinished) onFinishedHooks.add(onFinished);
  tasks = new Map();

  await fs.promises.mkdir(TASK_STORAGE_DIR, { recursive: true });
  // Load-time mutations (backfill, repair) must reach disk before boot
  // completes, or the next restart re-repairs the same records.
  if (loadTasks()) await saveTasks();
  initialized = true;
}

// After the scheduling front-end has initialized (timers armed, expiry
// marked), re-enqueue executions that were persisted as queued at load.
// These bypass enqueueExecution's already-queued guard — their `queued` state
// IS the persisted flag, no live execution is chained — and go straight onto
// the queue; runQueuedExecution re-checks every guard before running.
function drainRepairQueue() {
  for (const id of repairQueue.splice(0)) {
    const t = tasks.get(id);
    if (!t || scheduleSideBlocked(t)) {
      if (t) {
        t.state = null;
        releaseCatchUpMarker(t);
        void saveTasks();
      }
      continue;
    }
    chainExecution(id);
  }
}

// ── Task records ────────────────────────────────────────────────────────────

function getRecord(id) {
  return tasks.get(id) ?? null;
}

function allRecords() {
  return [...tasks.values()];
}

function isInitialized() {
  return initialized;
}

function insertTask(record) {
  if (!initialized) throw new Error("task engine is still starting — retry in a moment");
  if (!record?.id) throw new Error("task id is required");
  if (!record.prompt || typeof record.prompt !== "string") throw new Error("prompt is required");
  const trigger = record.trigger ?? "schedule";
  if (!SUPPORTED_TRIGGERS.includes(trigger)) {
    throw new Error(`unsupported trigger: ${trigger}`);
  }
  const type = record.targetType ?? "persona";
  if (!SUPPORTED_TARGET_TYPES.includes(type)) {
    throw new Error(`unsupported target type: ${type}`);
  }
  // A persona task MAY carry a null ref — legacy semantics: it runs under
  // whatever preset is live when it fires (cron-module's original behavior).
  tasks.set(record.id, { trigger, targetType: type, state: null, error: null, missed: 0, history: [], ...record, job: null });
  return tasks.get(record.id);
}

// Manual trigger (delegation front-end, or the MC bridge): create and
// immediately enqueue — no schedule is attached, so no schedule-side
// lifecycle ever applies. `origin` tags the creating front-end (e.g.
// { mc: <consoleTaskId> }) and persists with the record.
function createManualTask({ prompt, persona, agent, tool, sessionTitle, initiator, initiatorPreset, origin, executionPolicy = null }) {
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // Exactly one target flavor: a cell persona, a market a2a agent, or a tool
  // post's server::tool target (add-tool-posts). The delegation front-end
  // validates the ref against its universe beforehand.
  const targetCount = [persona, agent, tool].filter(Boolean).length;
  if (targetCount > 1) throw new Error("a task targets a persona OR a market agent OR a tool, not several");
  insertTask({
    id,
    trigger: "manual",
    type: "manual",
    cron: null,
    when: null,
    prompt,
    preset: persona ?? agent ?? tool ?? null,
    targetType: agent ? "a2a" : tool ? "tool" : "persona",
    sessionId: `task-${id}`,
    sessionTitle: sessionTitle || null,
    tz: null,
    status: "manual",
    paused: false,
    // Per-hop timeout budget (agent-fleet-orchestration handoff edges); null
    // = the deployment's default turn timeout.
    executionPolicy: executionPolicy && Number.isFinite(executionPolicy.timeoutMinutes) && executionPolicy.timeoutMinutes > 0
      ? { timeoutMinutes: executionPolicy.timeoutMinutes }
      : null,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    // The conversation session that delegated this task — the aggregator's
    // fan-out bookkeeping key (persisted; restart-safe). initiatorPreset is
    // the persona the conversation ran under (the aggregator restores it).
    initiator: initiator ?? null,
    initiatorPreset: initiatorPreset ?? null,
    // Creating front-end tag (the MC bridge's idempotency key); persisted,
    // never exposed on the wire.
    origin: origin ?? null,
  });
  const enq = enqueueExecution(id);
  if (!enq.ok) throw new Error(enq.error);
  return getTask(id);
}

function deleteRecord(id) {
  return tasks.delete(id);
}

function clientShape(t) {
  return {
    id: t.id,
    trigger: t.trigger ?? "schedule",
    type: t.type,
    cron: t.cron,
    when: t.when,
    prompt: t.prompt,
    target: { type: t.targetType ?? "persona", ref: t.preset ?? null },
    preset: t.preset ?? null,
    // Cluster binding (agent-cluster-platform): present only on cluster tasks
    // — the human label/count ride the record so list views and the cron MCP
    // can describe the target without re-reading clusters.db.
    clusterId: t.clusterId ?? null,
    clusterName: t.clusterName ?? null,
    agentCount: t.agentCount ?? null,
    executionPolicy: t.executionPolicy ?? null,
    targetAgents: t.targetAgents ?? null,
    sessionId: t.sessionId ?? null,
    sessionTitle: t.sessionTitle ?? null,
    tz: t.tz ?? null,
    status: t.status,
    state: t.state ?? null,
    error: t.error ?? null,
    // Delegation bookkeeping (manual trigger): the session that delegated this
    // task and whether its outcome has already been summarized into one.
    initiator: t.initiator ?? null,
    aggregated: t.aggregated ?? false,
    // Owning front-end tag (agent-fleet-core) — passthrough, see saveTasks.
    sourceTag: t.sourceTag ?? null,
    paused: t.paused,
    createdAt: t.createdAt,
    lastRun: t.lastRun,
    nextRun: t.nextRun,
    // Downtime accounting (P2, 2026-10-26): the counter alone stayed in logs
    // nobody reads — the reason and timestamp ride the task so cockpit and
    // post cards can say "skipped N rounds: platform was down".
    missed: t.missed ?? 0,
    lastMissedAt: t.lastMissedAt ?? null,
    lastMissedReason: t.lastMissedReason ?? null,
    catchUpPending: t.catchUpPending === true,
    history: t.history.slice(-20), // Last 20 executions
  };
}

function listTasks() {
  return allRecords().map(clientShape);
}

function getTask(id) {
  const t = tasks.get(id);
  return t ? clientShape(t) : null;
}

// The RAW record — origin/executionPolicy ride turns internally (the wire
// view strips them by design). Consumers: the loopback bridges and tests
// that need to assert evidence (agent-fleet-orchestration dispatch/handoff).
function getTaskRecord(id) {
  return tasks.get(id) ?? null;
}

// ── Execution lifecycle ─────────────────────────────────────────────────────

function scheduleSideBlocked(t) {
  return Boolean(t.paused || t.status === "expired" || t.status === "completed");
}

// An execution attempt ended WITHOUT running (schedule-side blocked at one of
// the re-check points). Release the make-up marker (fix-fleet-context-
// injection-seam): the flag now drives the 【补跑】 prompt prefix in the seam,
// so if it outlived the fire it marked, the NEXT normal fire would wear a
// false make-up label. Dropped = not a make-up round.
function releaseCatchUpMarker(t) {
  if (t && t.catchUpPending === true) {
    t.catchUpPending = false;
    void saveTasks();
  }
}

// Enqueue one execution of a task (schedule fire, run-now, re-run, or repair).
// Guards: schedule-side states that must not run are rejected; an execution
// already queued or running is a no-op returning the current state (re-run
// must not double-queue).
function enqueueExecution(id) {
  if (!initialized) return { ok: false, error: "task engine is still starting — retry in a moment" };
  const t = tasks.get(id);
  if (!t) return { ok: false, error: "task not found" };
  if (scheduleSideBlocked(t)) {
    // Rejected without ever enqueuing: the make-up marker must not survive to
    // label the next normal fire (fix-fleet-context-injection-seam).
    releaseCatchUpMarker(t);
    return { ok: false, error: `task is ${t.paused ? "paused" : t.status}` };
  }
  if (t.state === "queued" || t.state === "running") {
    return { ok: true, already: true, state: t.state };
  }
  t.state = "queued";
  void saveTasks();
  broadcastStatus(id);
  dispatch(id);
  return { ok: true, state: "queued" };
}

// Slot dispatch (ADR 0005): the worker pool, when active, claims executions
// it can run on a persona-bound worker; everything else runs on the primary
// slot's serial chain. The dispatcher returns true when it CLAIMED the
// execution (including queueing it for a future slot).
let slotDispatcherFn = null;
function setSlotDispatcher(fn) {
  slotDispatcherFn = typeof fn === "function" ? fn : null;
}
function dispatch(id) {
  if (slotDispatcherFn) {
    let claimed = false;
    try {
      claimed = slotDispatcherFn(tasks.get(id), { runOnPrimary: () => chainExecution(id) }) === true;
    } catch {
      claimed = false;
    }
    if (claimed) return;
  }
  chainExecution(id);
}

// Chain one execution onto the serialized queue (no guards — callers either
// passed them or want the run-time re-check to decide).
function chainExecution(id) {
  executionQueue = executionQueue.then(() => runQueuedExecution(id));
}

// Hand an execution back to the primary slot's serial chain (the worker
// pool's spawn-failure fallback).
function runOnPrimary(id) {
  chainExecution(id);
}

// Chain an arbitrary turn-shaped job onto the same serialized queue (the
// delegation aggregator's summary injection rides this so it never overlaps a
// task execution or a runtime mutation).
function chainTurn(fn) {
  executionQueue = executionQueue.then(fn);
}

async function runQueuedExecution(id) {
  const t = tasks.get(id);
  // The schedule front-end may have paused/removed/completed the task between
  // enqueue and turn — reset the lifecycle and skip (pre-engine behavior: a
  // paused job's due firing silently did not run).
  if (!t || scheduleSideBlocked(t)) {
    if (t) {
      t.state = null;
      releaseCatchUpMarker(t);
      void saveTasks();
    }
    return;
  }
  await runExecutionTurn(t, runTurnFn);
}

// The shared execution body — primary slot and worker slots run the SAME
// lifecycle transitions; only the turn executor differs (the primary's
// switchPreset flow vs a worker's pinned-persona prompt).
async function runExecutionTurn(t, turnFn) {
  const startTime = new Date().toISOString();
  t.lastRun = startTime;
  t.state = "running";
  // Persist BEFORE the turn: a crash mid-execution reloads as `interrupted`
  // instead of silently reverting to idle (the pre-engine gap).
  void saveTasks();
  if (broadcastFn) broadcastFn({ type: "cron_fired", id: t.id, prompt: t.prompt, startTime, state: "running" });
  broadcastStatus(t.id);

  // The pre-turn seam (fix-fleet-context-injection-seam): the scheduling
  // front-end may compose this fire's prompt here — the only point every
  // enqueue path converges on, so no path can miss it. A seam failure is that
  // fire's failure, never a silent un-shaped prompt and never a broken engine:
  // it settles through the same finishExecution the turn itself uses.
  if (beforeTurnFn) {
    try {
      await beforeTurnFn(t);
    } catch (err) {
      finishExecution(t, startTime, { ok: false, error: err?.message || String(err) });
      return;
    }
  }

  // Fleet patrol context (agent-fleet-report-lane): the seam above may have
  // armed a transient, per-fire prompt. It rides the turn only — never
  // serialized, cleared on finish — so the stored prompt stays the reusable
  // template.
  const effective = t.promptOverride != null ? { ...t, prompt: t.promptOverride } : t;

  try {
    const result = await turnFn(effective, { turnTimeoutMs: TURN_TIMEOUT_MS });
    finishExecution(t, startTime, result);
  } catch (err) {
    finishExecution(t, startTime, { ok: false, error: err?.message || String(err), interrupted: err?.interrupted === true });
  }
}

// Arm the transient per-fire prompt override (agent-fleet-report-lane). The
// scheduling front-end calls this synchronously before enqueueing a fire whose
// {{fleetContext}} it rendered. Cleared in finishExecution; never persisted
// (saveTasks' whitelist drops it by design).
function setPromptOverride(id, prompt) {
  const t = tasks.get(id);
  if (!t) return false;
  t.promptOverride = prompt;
  return true;
}

// Worker entry point: a pool-owned execution claims the same guards and the
// same lifecycle, running its turn on the pool's executor.
async function beginExecution(id, turnFn) {
  const t = tasks.get(id);
  if (!t || scheduleSideBlocked(t)) {
    if (t) {
      t.state = null;
      releaseCatchUpMarker(t);
      void saveTasks();
    }
    return false;
  }
  await runExecutionTurn(t, turnFn);
  return true;
}

function finishExecution(t, startTime, result) {
  const interrupted = result?.interrupted === true;
  // fix-fleet-turn-attribution D4: a platform-skipped round (lane breaker
  // open) is its own state — NOT failed (it would poison the re-run surface
  // and the failure counts for work the platform chose not to start).
  const skipped = result?.skipped === true;
  const ok = result?.ok !== false && !interrupted && !skipped;
  t.state = skipped ? "skipped" : interrupted ? "interrupted" : ok ? "done" : "failed";
  t.error = ok ? null : result?.error || (interrupted ? "execution was interrupted" : "execution failed");
  // The per-fire fleet-context override is spent with this execution.
  t.promptOverride = null;
  // A catch-up run is spent too — the marker must not outlive the make-up (P2).
  const wasCatchUp = t.catchUpPending === true;
  t.catchUpPending = false;

  t.history.push({
    time: startTime,
    duration: Date.now() - new Date(startTime).getTime(),
    state: t.state,
    success: ok,
    ...(wasCatchUp ? { catchUp: true } : {}),
    ...(t.error ? { error: t.error } : {}),
    // The collected assistant text (remote a2a turns and cluster digests
    // return it). The report lane reads the last a2a turn's text to build the
    // derived execution summary (agent-fleet-report-lane D4).
    ...(result?.text ? { text: String(result.text).slice(0, 2000) } : {}),
    // Token spend when the runtime reports usage on the finish chunk
    // (absent on some providers — the card omits the line, never blocks).
    ...(result?.usage ? { tokens: result.usage } : {}),
    // Per-member model attribution (agent-cluster-platform 3.15): a cluster
    // fan-out reports the model each member actually ran under. The lane is
    // the deployment's single provider — this records WHAT model id served
    // each member, not a fictional provider layer.
    ...(result?.models ? { models: result.models } : {}),
  });
  if (t.history.length > HISTORY_LIMIT) {
    t.history = t.history.slice(-HISTORY_LIMIT);
  }

  // Subscribers (scheduling front-end refreshes nextRun; the delegation
  // aggregator arms summary injections) — each guarded, none may lose the
  // outcome.
  for (const hook of onFinishedHooks) {
    try {
      hook(t);
    } catch { /* a subscriber failure must not lose the outcome */ }
  }

  void saveTasks();
  if (broadcastFn) {
    broadcastFn({
      type: "cron_completed",
      id: t.id,
      success: ok,
      state: t.state,
      ...(t.error ? { error: t.error } : {}),
      completedAt: new Date().toISOString(),
    });
  }
  broadcastStatus(t.id);
}

// Register a fire that failed BEFORE execution could start. Now UNUSED by the
// fleet lane — the pre-turn seam (fix-fleet-context-injection-seam) settles a
// render failure through finishExecution instead, so the failure lands on the
// same lifecycle path as any other failed run. Kept as a general engine
// primitive: enqueue-side callers that need to reject a fire without running
// anything still have a shape for it.
function recordFailedFire(id, message) {
  const t = tasks.get(id);
  if (!t) return false;
  const now = new Date().toISOString();
  t.lastRun = now;
  t.state = "failed";
  t.error = message;
  t.promptOverride = null;
  t.history.push({ time: now, duration: 0, state: "failed", success: false, error: message });
  for (const hook of onFinishedHooks) {
    try {
      hook(t);
    } catch { /* a subscriber failure must not lose the outcome */ }
  }
  void saveTasks();
  broadcastStatus(id);
  return true;
}

// Run or re-run a task immediately (bypasses the schedule). Enqueues only —
// the WS ack (cron_run_started) must not wait out the whole turn; completion
// arrives as the cron_completed broadcast.
function runTaskNow(id) {
  const r = enqueueExecution(id);
  return r;
}

// Await the serialized queue (tests, graceful drain).
function idle() {
  return executionQueue.then(() => {});
}

// Register an on-finished subscriber (the delegation aggregator mounts after
// engine init, which clears subscribers).
function addOnFinished(fn) {
  onFinishedHooks.add(fn);
}

// ── Broadcasting ────────────────────────────────────────────────────────────

function broadcastStatus(id) {
  const task = getTask(id);
  if (task && broadcastFn) {
    broadcastFn({ type: "cron_status", job: task });
  }
}

// Passthrough for the scheduling front-end's own events (e.g. cron_removed).
function broadcastEvent(event) {
  broadcastFn?.(event);
}

function getRecentActivity() {
  const activities = [];
  for (const t of tasks.values()) {
    for (const h of t.history.slice(-5)) {
      activities.push({
        type: "cron_execution",
        jobId: t.id,
        prompt: t.prompt,
        time: h.time,
        success: h.success,
      });
    }
  }
  return activities.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 50);
}

function getDashboardState() {
  return {
    jobs: listTasks(),
    activeTasks: [],
    recentActivity: getRecentActivity(),
    agentStatus: {
      isBusy: isBusyFn ? isBusyFn() : false,
    },
  };
}

// Fleet telemetry snapshot (unify-wanxing-management-plane): pure counts over
// the live store for the gateway's read-only relay to the fleet board. Counts
// and booleans only — prompts and other user content never take this path —
// and sampling has no side effects: it derives, it never mutates or queues.
function stats({ now = Date.now(), windowMs = 3_600_000 } = {}) {
  const executions = { running: 0, queued: 0 };
  const recent = { done: 0, failed: 0, interrupted: 0 };
  for (const t of tasks.values()) {
    if (t.state === "running") executions.running += 1;
    else if (t.state === "queued") executions.queued += 1;
    for (const h of Array.isArray(t.history) ? t.history : []) {
      const ts = Date.parse(h.time || h.completedAt || "");
      if (!Number.isFinite(ts) || ts < now - windowMs) continue;
      const state = h.state || (h.success === true ? "done" : h.success === false ? "failed" : null);
      if (state && Object.hasOwn(recent, state)) recent[state] += 1;
    }
  }
  let workers = { cap: 0, busy: 0, idle: 0 };
  if (workerStatsFn) {
    try {
      const w = workerStatsFn();
      if (w && typeof w === "object") {
        workers = {
          cap: Number(w.cap) || 0,
          busy: Number(w.busy) || 0,
          idle: Number(w.idle) || 0,
        };
      }
    } catch { /* a broken provider reads as an empty pool, never fails the snapshot */ }
  }
  return {
    jobs: tasks.size,
    executions,
    workers,
    recent,
    agentBusy: isBusyFn ? isBusyFn() : false,
  };
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

// Timer cancellation is the scheduling front-end's (cron.js owns the
// node-schedule handles); the engine's queue is allowed to settle naturally.
function shutdown() {}

export {
  initTaskEngine,
  drainRepairQueue,
  loadTasks,
  saveTasks,
  getRecord,
  allRecords,
  insertTask,
  isInitialized,
  createManualTask,
  deleteRecord,
  clientShape,
  listTasks,
  getTask,
  getTaskRecord,
  enqueueExecution,
  runTaskNow,
  setPromptOverride,
  recordFailedFire,
  idle,
  chainTurn,
  addOnFinished,
  setSlotDispatcher,
  beginExecution,
  runOnPrimary,
  broadcastStatus,
  broadcastEvent,
  getDashboardState,
  stats,
  shutdown,
  SUPPORTED_TARGET_TYPES,
};
