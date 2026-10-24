// ── Scheduling front-end ─────────────────────────────────────────────────────
//
// The schedule trigger kind of the task engine (add-task-engine; ADR 0006):
// this module owns WHEN tasks fire — cron/one-shot schedules in an optional
// IANA timezone, missed-occurrence accounting, pause/resume, and expiry. Task
// records, the execution lifecycle, the serialized queue, and the task event
// surface live in task-engine.js; a firing hands the task to the engine's
// enqueueExecution. The public API shape (server.js, server/ws.js,
// server/routes/cron.js) is unchanged from the pre-engine cron module.

import schedule from "node-schedule";
import cronParser from "cron-parser";
import * as engine from "./task-engine.js";

// Missed-occurrence accounting caps iteration at this many gaps per load so a
// task left dead for years cannot spin the parser.
const MAX_MISSED_PER_LOAD = 100;

// ── Initialization ────────────────────────────────────────────────────────────

async function initCron({ broadcast, runJobTurn, isBusy, workerStats, renderFleetContext }) {
  setFleetContextRenderer(renderFleetContext ?? null);
  await engine.initTaskEngine({
    broadcast,
    runTurn: runJobTurn,
    isBusy,
    onFinished: refreshNextRun,
    // Occupancy provider for the fleet stats snapshot — a closure so the
    // worker pool (attached after init) is picked up lazily (unify-wanxing-management-plane).
    workerStats,
  });

  // Scheduling pass over the engine's loaded records: downtime accounting
  // before rescheduling, then arm timers / mark expiry. Afterwards the engine
  // re-enqueues executions that were persisted as queued at load.
  for (const j of engine.allRecords()) {
    if (j.type === "recurring" && j.cron) {
      // Downtime accounting happens before rescheduling: occurrences entirely
      // covered by the downtime window are recorded as missed, never replayed.
      if (countMissedOccurrences(j)) void engine.saveTasks();
      scheduleJob(j);
    } else if (j.type === "once" && !j.paused) {
      const scheduledAt = new Date(j.when);
      if (scheduledAt > new Date()) {
        scheduleJob(j);
      } else {
        // One-shot tasks that passed their scheduled time while down are
        // marked expired; they stay in history only.
        j.status = "expired";
        void engine.saveTasks();
      }
    }
  }
  engine.drainRepairQueue();
}

// ── Cluster task policy validation (agent-cluster-platform) ─────────────────
//
// Shape gate for executionPolicy/targetAgents on cluster tasks. The cluster's
// existence is the route layer's check (it owns clusters.db); this side owns
// the scheduling-neutral field shapes so every entry path (REST, WS, MCP)
// validates identically.
const RESULT_AGGREGATIONS = ["first", "all", "summary"];

function validateClusterPolicy({ executionPolicy, targetAgents }) {
  if (executionPolicy !== undefined) {
    if (typeof executionPolicy !== "object" || executionPolicy === null || Array.isArray(executionPolicy)) {
      return "executionPolicy must be an object";
    }
    const { allowParallel, timeoutMinutes, resultAggregation } = executionPolicy;
    if (allowParallel !== undefined && typeof allowParallel !== "boolean") {
      return "executionPolicy.allowParallel must be a boolean";
    }
    if (
      timeoutMinutes !== undefined &&
      (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 1440)
    ) {
      return "executionPolicy.timeoutMinutes must be a number in (0, 1440]";
    }
    if (resultAggregation !== undefined && !RESULT_AGGREGATIONS.includes(resultAggregation)) {
      return `executionPolicy.resultAggregation must be one of ${RESULT_AGGREGATIONS.join(", ")}`;
    }
  }
  if (targetAgents !== undefined) {
    if (!Array.isArray(targetAgents) || targetAgents.length === 0 || !targetAgents.every((a) => typeof a === "string" && a.trim())) {
      return "targetAgents must be a non-empty array of agent ids";
    }
  }
  return null;
}

// ── Schedule math ────────────────────────────────────────────────────────────
// cron-parser is node-schedule's own expression parser, so occurrence math
// here always agrees with what the timer fires on.
function parseRule(cron, tz) {
  return cronParser.parseExpression(cron, { tz: tz || undefined });
}

function validateCron(cron, tz) {
  if (!cron || typeof cron !== "string") return "cron expression is required";
  try {
    parseRule(cron, tz);
    return null;
  } catch {
    return `invalid cron expression: ${cron}`;
  }
}

// Count occurrences strictly between lastRun and now for a recurring task that
// was NOT running (load-time gap). Increments the missed counter and appends a
// history marker so the UI can show why a task skipped. Returns true when the
// record changed (caller persists).
function countMissedOccurrences(task) {
  const now = new Date();
  const from = task.lastRun ? new Date(task.lastRun) : null;
  if (!from || Number.isNaN(from.getTime())) return false;
  try {
    const iter = parseRule(task.cron, task.tz);
    let missed = 0;
    // prev() yields occurrences strictly before `now`; each one after lastRun
    // was entirely covered by downtime. No warm-up call — the first prev() is
    // itself a countable occurrence.
    let prev = iter.prev();
    while (prev && prev.toDate() > from && missed < MAX_MISSED_PER_LOAD) {
      missed++;
      prev = iter.prev();
    }
    if (missed > 0) {
      task.missed = (task.missed || 0) + missed;
      task.history = task.history || [];
      task.history.push({ time: now.toISOString(), missed, success: null });
      console.log(`[cron] Task ${task.id} missed ${missed} occurrence(s) during downtime`);
      return true;
    }
  } catch (err) {
    console.warn(`[cron] missed-count failed for ${task.id}: ${err.message}`);
  }
  return false;
}

// ── Schedule management ──────────────────────────────────────────────────────

function generateId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// The fleet patrol-context renderer (agent-fleet-report-lane), injected by the
// server layer at init so this module stays fleet-agnostic and testable. Null
// when absent: fleet tasks then fire with their stored (template) prompt —
// the same behavior a deployment without the report lane keeps.
let renderFleetContextFn = null;

// Wire the renderer without a full initCron pass (tests, late mounting).
function setFleetContextRenderer(fn) {
  renderFleetContextFn = typeof fn === "function" ? fn : null;
}

// One trigger of an armed task: the injection seam (agent-fleet-report-lane
// D6). A fleet-tagged task whose prompt carries the {{fleetContext}} placeholder
// gets the context SEGMENT from the renderer and substitutes it into this
// fire's prompt only (a transient engine override — the stored prompt stays
// the reusable template); a render failure or empty segment fails the fire
// explicitly (never a silent empty-context patrol); everything else — non-fleet
// tasks, templates without the placeholder — enqueues byte-for-byte as before.
async function fireTask(id) {
  const task = engine.getRecord(id);
  if (!task) return;
  if (renderFleetContextFn && task.sourceTag?.fleetId && typeof task.prompt === "string" && task.prompt.includes("{{fleetContext}}")) {
    let segment;
    try {
      segment = await renderFleetContextFn(task.sourceTag, task);
    } catch (err) {
      engine.recordFailedFire(id, `fleetContext render failed: ${err?.message || err}`);
      return;
    }
    if (typeof segment !== "string" || !segment.trim()) {
      engine.recordFailedFire(id, "fleetContext renderer returned an empty segment");
      return;
    }
    engine.setPromptOverride(id, task.prompt.replace(/\{\{fleetContext\}\}/g, segment));
  }
  engine.enqueueExecution(id);
}

// Arm the live timer on the engine's shared record (in place — the record IS
// the engine's map entry; copying would detach state transitions from it).
function scheduleJob(task) {
  if (task.paused) return task;
  try {
    // tz, when present, evaluates the cron rule in the task's IANA timezone
    // (verified: node-schedule honors { rule, tz }); absent = cell-local,
    // which is the pre-change behavior legacy tasks keep.
    const spec = task.type === "recurring" && task.cron
      ? (task.tz ? { rule: task.cron, tz: task.tz } : task.cron)
      : new Date(task.when);
    task.job = schedule.scheduleJob(spec, () => {
      void fireTask(task.id);
    });
    if (task.job?.nextInvocation()) {
      task.nextRun = task.job.nextInvocation().toISOString();
    }
  } catch (err) {
    console.error(`[cron] Failed to schedule task ${task.id}:`, err.message);
    task.status = "error";
    task.error = err.message;
  }
  return task;
}

// The engine calls this after each finished execution so recurring tasks show
// the next armed occurrence.
function refreshNextRun(task) {
  if (task.job?.nextInvocation()) {
    task.nextRun = task.job.nextInvocation().toISOString();
  }
}

async function addJob({
  cron,
  when,
  prompt,
  preset,
  agent,
  tool,
  tz,
  sessionTitle,
  clusterId,
  clusterName,
  agentCount,
  executionPolicy,
  targetAgents,
  sourceTag,
}) {
  if (cron) {
    const invalid = validateCron(cron, tz);
    if (invalid) throw new Error(invalid);
  } else if (!when || Number.isNaN(new Date(when).getTime())) {
    throw new Error("a valid cron expression or one-shot time is required");
  }
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");

  // Cluster binding (agent-cluster-platform): a task targets a persona OR a
  // cluster — the cluster ref rides `preset` so target-ref semantics stay
  // uniform, and the human label/count persist beside it for list views.
  const isClusterTask = Boolean(clusterId);
  if (isClusterTask && preset) {
    throw new Error("a task targets a preset OR a cluster, not both");
  }
  // Market a2a target (agent-fleet-core): same dichotomy as the manual
  // trigger's persona/agent pair — a scheduled a2a post fires remote turns.
  if (agent && preset) {
    throw new Error("a task targets a preset OR a market agent, not both");
  }
  if (agent && isClusterTask) {
    throw new Error("a task targets a cluster OR a market agent, not both");
  }
  if (agent !== undefined && typeof agent !== "string") {
    throw new Error("agent must be a market agent id string");
  }
  if (sourceTag !== undefined && sourceTag !== null) {
    if (typeof sourceTag !== "object" || Array.isArray(sourceTag)) {
      throw new Error("sourceTag must be an object");
    }
  }
  if (clusterName !== undefined && typeof clusterName !== "string") {
    throw new Error("clusterName must be a string");
  }
  if (agentCount !== undefined && (!Number.isInteger(agentCount) || agentCount < 1)) {
    throw new Error("agentCount must be a positive integer");
  }
  const policyInvalid = validateClusterPolicy({ executionPolicy, targetAgents });
  if (policyInvalid) throw new Error(policyInvalid);

  const id = generateId();
  const taskData = {
    id,
    trigger: "schedule",
    type: cron ? "recurring" : "once",
    cron,
    when,
    prompt,
    // Binding: the persona the task runs under and the session its output
    // belongs to. sessionId is minted here so the id is stable from creation,
    // but the dsh/SQLite session itself is only created at first execution
    // (a paused or deleted task leaves no orphan session behind).
    preset: isClusterTask ? clusterId : (preset ?? agent ?? tool ?? null),
    // tool posts (add-tool-posts): preset is the "server::tool" target — a
    // deterministic MCP call, no dsh runtime.
    targetType: isClusterTask ? "cluster" : agent ? "a2a" : tool ? "tool" : "persona",
    ...(isClusterTask
      ? {
          clusterId,
          clusterName: clusterName || null,
          agentCount: typeof agentCount === "number" ? agentCount : null,
          executionPolicy: executionPolicy ?? null,
          targetAgents: targetAgents ?? null,
        }
      : {}),
    sessionId: `cron-${id}`,
    sessionTitle: sessionTitle || null,
    tz: tz || null,
    status: "scheduled",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    missed: 0,
    history: [],
    // Owning front-end tag (agent-fleet-core) — opaque passthrough.
    sourceTag: sourceTag ?? null,
  };

  // insertTask validates the target (persona-only today) before anything is
  // scheduled or persisted.
  const record = engine.insertTask(taskData);
  scheduleJob(record);
  await engine.saveTasks();
  engine.broadcastStatus(id);
  // Return the client-facing shape, never the live record: it carries the
  // node-schedule Job handle (a circular object), and the WS reply serializes
  // this value.
  return engine.getTask(id);
}

// In-place update of a schedule task (agent-fleet-core reconcile): cadence
// edits and incumbent swaps REWRITE the existing record — the task id (and
// with it the dedicated session id and execution history) must survive the
// change, so remove-then-add is not an option. Only provided fields apply;
// target rebinding accepts the same target trio as addJob and clears the
// previous binding's residual fields.
async function updateJob(id, changes = {}) {
  const task = engine.getRecord(id);
  if (!task) return null;
  if (task.trigger !== "schedule") {
    throw new Error("only schedule tasks can be updated in place");
  }

  const { cron, when, prompt, tz, sessionTitle, preset, agent, tool, clusterId, clusterName, agentCount, executionPolicy, targetAgents, sourceTag } = changes;

  if (cron !== undefined) {
    if (!cron || typeof cron !== "string") throw new Error("cron must be a non-empty string");
    const invalid = validateCron(cron, tz ?? task.tz);
    if (invalid) throw new Error(invalid);
  }
  if (when !== undefined && when !== null && Number.isNaN(new Date(when).getTime())) {
    throw new Error("when must be a valid time");
  }
  if (prompt !== undefined && (!prompt || typeof prompt !== "string")) {
    throw new Error("prompt must be a non-empty string");
  }
  if (sourceTag !== undefined && sourceTag !== null) {
    if (typeof sourceTag !== "object" || Array.isArray(sourceTag)) {
      throw new Error("sourceTag must be an object");
    }
  }
  const policyInvalid = validateClusterPolicy({ executionPolicy, targetAgents });
  if (policyInvalid) throw new Error(policyInvalid);

  // Target rebinding: at most one flavor among the trio.
  const targets = [preset, agent, tool, clusterId].filter((v) => v !== undefined);
  if (targets.length > 1) {
    throw new Error("a task targets a preset OR a cluster OR a market agent OR a tool, not several");
  }

  if (cron !== undefined) task.cron = cron;
  if (when !== undefined) task.when = when;
  if (prompt !== undefined) task.prompt = prompt;
  if (tz !== undefined) task.tz = tz || null;
  if (sessionTitle !== undefined) task.sessionTitle = sessionTitle || null;
  if (sourceTag !== undefined) task.sourceTag = sourceTag ?? null;
  if (cron !== undefined || when !== undefined) {
    task.type = task.cron ? "recurring" : "once";
  }

  if (targets.length === 1) {
    // Clear the outgoing binding's residual fields before writing the new
    // one — a cluster→persona swap must not leave clusterId riding along
    // (the engine reads clusterId as the binding when present).
    task.clusterId = null;
    task.clusterName = null;
    task.agentCount = null;
    task.executionPolicy = null;
    task.targetAgents = null;
    if (clusterId !== undefined) {
      task.targetType = "cluster";
      task.preset = clusterId;
      task.clusterId = clusterId;
      if (clusterName !== undefined) task.clusterName = clusterName || null;
      if (agentCount !== undefined) task.agentCount = typeof agentCount === "number" ? agentCount : null;
      if (executionPolicy !== undefined) task.executionPolicy = executionPolicy ?? null;
      if (targetAgents !== undefined) task.targetAgents = targetAgents ?? null;
    } else if (agent !== undefined) {
      task.targetType = "a2a";
      task.preset = agent;
    } else if (tool !== undefined) {
      task.targetType = "tool";
      task.preset = tool;
    } else {
      task.targetType = "persona";
      task.preset = preset ?? null;
    }
  } else if (clusterName !== undefined || agentCount !== undefined || executionPolicy !== undefined || targetAgents !== undefined) {
    // Metadata-only touch-up without rebinding (cluster labels/policy).
    if (clusterName !== undefined) task.clusterName = clusterName || null;
    if (agentCount !== undefined) task.agentCount = typeof agentCount === "number" ? agentCount : null;
    if (executionPolicy !== undefined) task.executionPolicy = executionPolicy ?? null;
    if (targetAgents !== undefined) task.targetAgents = targetAgents ?? null;
  }

  // Re-arm the live handle under the new schedule (paused tasks stay parked —
  // the paused bit is owned by the reconcile layer, never flipped here).
  if (task.job) {
    task.job.cancel();
    task.job = null;
  }
  if (!task.paused) {
    if (task.type === "recurring" && task.cron) {
      scheduleJob(task);
    } else if (task.type === "once" && task.when) {
      const scheduledAt = new Date(task.when);
      if (scheduledAt > new Date()) {
        scheduleJob(task);
      } else {
        task.status = "expired";
      }
    }
  }

  await engine.saveTasks();
  engine.broadcastStatus(id);
  return engine.getTask(id);
}

async function removeJob(id) {
  const task = engine.getRecord(id);
  if (!task) return false;
  if (task.job) {
    task.job.cancel();
  }
  engine.deleteRecord(id);
  await engine.saveTasks();
  // Shape kept from the pre-engine module so client stores can drop the row.
  engine.broadcastEvent({ type: "cron_removed", id });
  return true;
}

async function pauseJob(id) {
  const task = engine.getRecord(id);
  if (!task) return false;
  // Manual (delegated) tasks have no schedule-side lifecycle — pause/resume
  // are schedule concepts and SHALL NOT apply (spec: task-engine).
  if (task.trigger === "manual") return false;
  if (task.job) {
    task.job.cancel();
    task.job = null;
  }
  task.paused = true;
  task.status = "paused";
  await engine.saveTasks();
  engine.broadcastStatus(id);
  return true;
}

async function resumeJob(id) {
  const task = engine.getRecord(id);
  if (!task || !task.paused) return false;
  if (task.trigger === "manual") return false;
  task.paused = false;
  task.status = "scheduled";
  // Reschedule
  if (task.type === "recurring" && task.cron) {
    countMissedOccurrences(task);
    scheduleJob(task);
  } else if (task.type === "once" && task.when) {
    const scheduledAt = new Date(task.when);
    if (scheduledAt > new Date()) {
      scheduleJob(task);
    } else {
      task.status = "expired";
    }
  }
  await engine.saveTasks();
  engine.broadcastStatus(id);
  return true;
}

// Run or re-run a task immediately (bypasses the schedule). Returns the
// engine's enqueue result: { ok, already?, state?, error? } — already-queued
// or running executions are a no-op carrying the current state, and re-run of
// a failed/interrupted execution is allowed.
async function runJobNow(id) {
  return engine.runTaskNow(id);
}

function listJobs() {
  return engine.listTasks();
}

// Engine readiness passthrough (agent-fleet-core): the fleet reconcile hook on
// catalog changes must not race the engine's load-time map replacement.
function isEngineInitialized() {
  return engine.isInitialized();
}

function getJob(id) {
  return engine.getTask(id);
}

function getDashboardState() {
  return engine.getDashboardState();
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown() {
  for (const task of engine.allRecords()) {
    if (task.job) {
      task.job.cancel();
    }
  }
  schedule.gracefulShutdown();
}

export {
  initCron,
  addJob,
  updateJob,
  removeJob,
  pauseJob,
  resumeJob,
  listJobs,
  getJob,
  isEngineInitialized,
  fireTask,
  setFleetContextRenderer,
  runJobNow,
  getDashboardState,
  validateCron,
  shutdown,
};
