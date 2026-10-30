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
    onFinished: (task) => {
      // Interval + finite-run lifecycle first (it may retire the task), then
      // the generic next-run refresh for every kind.
      onIntervalFinished(task);
      refreshNextRun(task);
    },
    // Occupancy provider for the fleet stats snapshot — a closure so the
    // worker pool (attached after init) is picked up lazily (unify-wanxing-management-plane).
    workerStats,
  });

  // Scheduling pass over the engine's loaded records: downtime accounting
  // before rescheduling, then arm timers / mark expiry. Afterwards the engine
  // re-enqueues executions that were persisted as queued at load.
  const catchUp = []; // tasks whose downtime gap still deserves one make-up run
  for (const j of engine.allRecords()) {
    if (j.type === "recurring" && j.cron) {
      // Downtime accounting happens before rescheduling: occurrences entirely
      // covered by the downtime window are recorded as missed. A DELIVERY task
      // inside its tolerance window then gets ONE catch-up run (P2, 2026-10-26:
      // an unattended fleet silently lost a patrol when a restart covered its
      // trigger — a counter in a log nobody reads is not a delivery guarantee).
      // Outside the window the gap is past saving: record and move on.
      const missed = countMissedOccurrences(j);
      if (missed > 0) {
        void engine.saveTasks();
        if (!j.paused && withinToleranceWindow(j)) catchUp.push(j.id);
      }
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
  // Catch-up runs are enqueued on the same serial chain as scheduled fires, so
  // they queue behind (never interleave with) whatever boot is already doing.
  // The marker rides the task record for the duration of that run: prompt
  // prefix + cockpit/report evidence show this was a make-up, never a normal
  // patrol (a caught-up round must not read as "the 09:00 patrol happened").
  for (const id of catchUp) {
    const t = engine.getRecord(id);
    if (!t) continue;
    t.catchUpPending = true;
    const base = t.promptOverride ?? t.prompt;
    if (typeof base === "string") {
      engine.setPromptOverride(
        id,
        `【补跑】上一轮因平台停机被跳过，本次为补跑（正常节奏不受影响）。\n\n${base}`,
      );
    }
    console.log(`[cron] Task ${id} catch-up run enqueued (downtime gap, still inside the tolerance window)`);
    void fireTask(id);
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

// ── Interval rules (add-cron-automation-parity, design S2) ───────────────────
// An every-N interval is stored as the RULE, never coerced into a cron
// approximation: five-field cron cannot express "every 40 days". Occurrences
// are anchor + k × step, where the anchor is the acceptance time on the SERVER
// clock (a client-computed wall time would silently roll a year forward once
// it lands in the past). Day/week units honour the job's timezone for the
// optional time-of-day phase; minute/hour units are pure durations.
const INTERVAL_UNITS = new Set(["minute", "hour", "day", "week"]);
const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

function validateInterval(interval) {
  if (!interval || typeof interval !== "object") return "interval must be an object";
  const { number, unit } = interval;
  if (!Number.isInteger(number) || number < 1 || number > 200) return "interval.number must be an integer 1–200";
  if (!INTERVAL_UNITS.has(unit)) return "interval.unit must be one of minute|hour|day|week";
  return null;
}

// Next occurrence after `from`, anchored at `anchorIso`. Occurrences are
// anchor + k × step with k ≥ 1 — the anchor is the moment the rule STARTED,
// never an occurrence itself (firing at the anchor would mean an interval task
// ran the instant it was created).
function nextIntervalOccurrence(task, from = Date.now()) {
  const anchor = new Date(task.anchor || task.createdAt).getTime();
  const step = task.interval.number * UNIT_MS[task.interval.unit];
  if (from < anchor) return anchor + step;
  const k = Math.floor((from - anchor) / step) + 1;
  return anchor + k * step;
}

// Tolerance window for a downtime gap (P2 catch-up): the same shape the fleet
// presence derivation uses — 2 × cadence period, floored at 6h — computed here
// so cron.js stays free of the fleet layer. A gap older than this is past
// saving: the post would read `missing` anyway and a late patrol would only
// mislead. Unparseable rules fall back to the floor (never suppress a catch-up
// on a rule the scheduler itself accepted).
const CATCH_UP_FLOOR_MS = 6 * 60 * 60 * 1000;
function withinToleranceWindow(task, now = Date.now()) {
  if (process.env.PLATFORM_CRON_CATCHUP === "0") return false; // kill switch
  try {
    const iter = cronParser.parseExpression(task.cron, { tz: task.tz || undefined });
    const a = iter.next().toDate();
    const b = iter.next().toDate();
    const period = b - a;
    const window = Number.isFinite(period) && period > 0
      ? Math.max(2 * period, CATCH_UP_FLOOR_MS)
      : CATCH_UP_FLOOR_MS;
    const lastMs = task.lastRun ? Date.parse(task.lastRun) : null;
    // A task that never ran has no "missed round" to make up — it is simply
    // starting (its first occurrence is still ahead).
    if (lastMs == null || !Number.isFinite(lastMs)) return false;
    return now - lastMs <= window;
  } catch {
    return true;
  }
}

// Count occurrences strictly between lastRun and now for a recurring task that
// was NOT running (load-time gap). Increments the missed counter and appends a
// history marker so the UI can show why a task skipped. Returns the number of
// occurrences recorded as missed (0 when the record did not change) — the
// caller persists, and the boot pass uses it to decide on a catch-up run
// (2026-10-26 P2: a downtime-covered trigger silently lost one delivery).
function countMissedOccurrences(task) {
  const now = new Date();
  const from = task.lastRun ? new Date(task.lastRun) : null;
  if (!from || Number.isNaN(from.getTime())) return 0;
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
      // Stamp the reason on the record so every surface that shows a task can
      // say WHY it skipped, not just that a counter moved (P2 visibility).
      task.lastMissedAt = now.toISOString();
      task.lastMissedReason = "downtime";
      task.history = task.history || [];
      task.history.push({ time: now.toISOString(), missed, success: null });
      console.log(`[cron] Task ${task.id} missed ${missed} occurrence(s) during downtime`);
      return missed;
    }
  } catch (err) {
    console.warn(`[cron] missed-count failed for ${task.id}: ${err.message}`);
  }
  return 0;
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

// 舰队巡逻上下文注入（唯一入口）：把本轮算出的 segment 写成本次执行的临时
// promptOverride（存着的 prompt 仍是可复用模板）。返回 { ok } 或 { ok:false, error }
// —— 空段/渲染失败必须**显式失败这一次开火**，绝不静默地让巡逻在没有上下文的
// 情况下跑一轮。
//
// 抽成函数是因为它有两个调用者：定时/补跑的 fireTask，以及手动触发
// （runJobNow → engine.runTaskNow）。此前手动路径直接 enqueueExecution，**完全
// 绕过这里**——于是 `{{fleetContext}}` 从不被展开，手动触发的舰队回合拿到的
// 是一份没有巡视上下文的裸模板（2026-10-29 真机取证：CEO 一轮 prompt 只有
// 249 字符，正常轮是 2880；这既让手动走查失真，也让被手动触发的会话看起来
// 「没上下文」而四处去翻文件）。
async function applyFleetContext(id, task) {
  if (!renderFleetContextFn || !task?.sourceTag?.fleetId) return { ok: true };
  if (typeof task.prompt !== "string" || !task.prompt.includes("{{fleetContext}}")) return { ok: true };
  let segment;
  try {
    segment = await renderFleetContextFn(task.sourceTag, task);
  } catch (err) {
    return { ok: false, error: `fleetContext render failed: ${err?.message || err}` };
  }
  if (typeof segment !== "string" || !segment.trim()) {
    return { ok: false, error: "fleetContext renderer returned an empty segment" };
  }
  engine.setPromptOverride(id, task.prompt.replace(/\{\{fleetContext\}\}/g, segment));
  return { ok: true };
}

// One trigger of an armed task: the injection seam (agent-fleet-report-lane
// D6). A fleet-tagged task whose prompt carries the {{fleetContext}} placeholder
// gets the context SEGMENT from the renderer and substitutes it into this
// fire's prompt only; a render failure or empty segment fails the fire
// explicitly (never a silent empty-context patrol); everything else — non-fleet
// tasks, templates without the placeholder — enqueues byte-for-byte as before.
async function fireTask(id) {
  const task = engine.getRecord(id);
  if (!task) return;
  const ctx = await applyFleetContext(id, task);
  if (!ctx.ok) {
    engine.recordFailedFire(id, ctx.error);
    return;
  }
  engine.enqueueExecution(id);
}

// Arm the live timer on the engine's shared record (in place — the record IS
// the engine's map entry; copying would detach state transitions from it).
function scheduleJob(task) {
  if (task.paused) return task;
  // A capped task that already ran out never re-arms (spec: 跑满即 completed).
  if (task.maxRuns != null && (task.runs ?? 0) >= task.maxRuns) {
    task.status = "completed";
    return task;
  }
  try {
    // Interval tasks arm ONE occurrence at a time (a Date), because an every-N
    // rule can exceed what a five-field cron can express; the next Date is
    // recomputed from the rule on every finish (refreshNextRun).
    const spec =
      task.interval
        ? new Date(nextIntervalOccurrence(task))
        : task.type === "recurring" && task.cron
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

// Interval + finite-run lifecycle (add-cron-automation-parity, design S2/S4):
// after each completed execution count it, retire at the cap, otherwise re-arm
// the next rule occurrence. Cron/once tasks keep their node-schedule arming and
// simply refresh nextRun (their handles repeat by themselves).
function onIntervalFinished(task) {
  if (!task || !task.interval) return;
  task.runs = (task.runs ?? 0) + 1;
  if (task.maxRuns != null && task.runs >= task.maxRuns) {
    task.status = "completed";
    if (task.job) {
      try {
        task.job.cancel();
      } catch {
        /* already gone */
      }
      task.job = null;
    }
    task.nextRun = null;
    return;
  }
  if (!task.paused && task.status !== "expired") scheduleJob(task);
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
  projectId,
  // add-cron-automation-parity: the two new schedule forms + the finite cap.
  delayMinutes,
  interval,
  maxRuns,
}) {
  // ── Schedule-form validation (exactly one form) ──────────────────────────
  // A relative one-shot is resolved HERE, from the server's own clock — a
  // client-computed wall time could land in the past and silently roll a year
  // forward (design S3). The stored task keeps the resolved absolute `when`.
  if (delayMinutes !== undefined) {
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 525600) {
      throw new Error("delayMinutes must be an integer between 1 and 525600");
    }
    if (cron || when || interval) throw new Error("delayMinutes is exclusive with cron/when/interval");
    when = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  }
  if (interval !== undefined) {
    const bad = validateInterval(interval);
    if (bad) throw new Error(bad);
    if (cron || when) throw new Error("interval is exclusive with cron/when");
  }
  if (maxRuns !== undefined) {
    if (!Number.isInteger(maxRuns) || maxRuns < 1) throw new Error("maxRuns must be a positive integer");
    // A cap only means something on a repeating form.
    if (!cron && !interval) throw new Error("maxRuns requires a recurring form (cron or interval)");
  }

  if (cron) {
    const invalid = validateCron(cron, tz);
    if (invalid) throw new Error(invalid);
  } else if (interval) {
    // validated above
  } else if (!when || Number.isNaN(new Date(when).getTime())) {
    throw new Error("a valid cron expression, interval, delay, or one-shot time is required");
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
    type: cron || interval ? "recurring" : "once",
    cron,
    when,
    // Schedule-form extras (add-cron-automation-parity): the interval rule is
    // the truth (never a coerced cron), the anchor is when the rule started,
    // and maxRuns/runs are the finite-run counter pair. All absent on legacy
    // cron/once records → same semantics as before.
    ...(interval ? { interval: { number: interval.number, unit: interval.unit }, anchor: new Date().toISOString() } : {}),
    ...(maxRuns != null ? { maxRuns, runs: 0 } : {}),
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
    // Project attribution (add-web-project-container) — opaque passthrough to
    // the read surfaces; NULL = the 默认项目 bucket. The engine never reads it.
    projectId: projectId ?? null,
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

  const { cron, when, prompt, tz, sessionTitle, preset, agent, tool, clusterId, clusterName, agentCount, executionPolicy, targetAgents, sourceTag, delayMinutes, interval, maxRuns } = changes;

  if (cron !== undefined) {
    if (!cron || typeof cron !== "string") throw new Error("cron must be a non-empty string");
    const invalid = validateCron(cron, tz ?? task.tz);
    if (invalid) throw new Error(invalid);
  }
  // add-cron-automation-parity: schedule-form changes. A relative one-shot is
  // resolved on the SERVER clock (same discipline as create), and an interval
  // rule is validated here; the three forms stay mutually exclusive.
  if (delayMinutes !== undefined) {
    if (!Number.isInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > 525600) {
      throw new Error("delayMinutes must be an integer between 1 and 525600");
    }
    if (cron !== undefined || interval !== undefined) throw new Error("delayMinutes is exclusive with cron/interval");
  }
  if (interval !== undefined) {
    const bad = validateInterval(interval);
    if (bad) throw new Error(bad);
    if (cron !== undefined) throw new Error("interval is exclusive with cron");
  }
  if (maxRuns !== undefined && (!Number.isInteger(maxRuns) || maxRuns < 1)) {
    throw new Error("maxRuns must be a positive integer");
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
  if (delayMinutes !== undefined) {
    // Resolve NOW, on the server clock — the stored task keeps the absolute
    // time so a restart never re-anchors it (design S3).
    task.when = new Date(Date.now() + delayMinutes * 60_000).toISOString();
    task.cron = null;
    task.interval = null;
    task.anchor = null;
  }
  if (interval !== undefined) {
    // A rule change re-anchors from now and clears the cron form/step counter.
    task.interval = { number: interval.number, unit: interval.unit };
    task.anchor = new Date().toISOString();
    task.cron = null;
    task.when = null;
    task.runs = 0;
  }
  if (maxRuns !== undefined) {
    task.maxRuns = maxRuns;
    // Lowering the cap below what already ran retires the task immediately
    // (spec: 改 cap 低于已跑数则即刻 completed).
    if ((task.runs ?? 0) >= maxRuns) task.status = "completed";
  }
  if (prompt !== undefined) task.prompt = prompt;
  if (tz !== undefined) task.tz = tz || null;
  if (sessionTitle !== undefined) task.sessionTitle = sessionTitle || null;
  if (sourceTag !== undefined) task.sourceTag = sourceTag ?? null;
  if (cron !== undefined || when !== undefined) {
    task.type = task.cron || task.interval ? "recurring" : "once";
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
//
// 舰队任务的上下文注入与定时开火**同一条路**（applyFleetContext）。手动触发
// 曾经直接 enqueueExecution，`{{fleetContext}}` 从未被展开——走查看到的舰队
// 回合是裸模板，和人手点「立即执行」后代理四处翻文件是同一件事的两面。
async function runJobNow(id) {
  const task = engine.getRecord(id);
  if (!task) return engine.runTaskNow(id);
  const ctx = await applyFleetContext(id, task);
  if (!ctx.ok) return { ok: false, error: ctx.error };
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
  // Downtime catch-up decision (P2, 2026-10-26) — exported so the window and
  // the kill switch are pinned by a test rather than only exercised at boot.
  withinToleranceWindow,
  shutdown,
};
