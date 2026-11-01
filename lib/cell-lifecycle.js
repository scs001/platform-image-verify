// ── Cell lifecycle: the cross-topology vocabulary (add-cell-lifecycle) ─────
//
// ONE source for the lifecycle words every executor shares — the cloud
// gateway's cell registry (chapter 3) and the desktop steward
// (desktop-supervisor's resident form) both derive their state handling from
// this module, so a state name or a policy never forks between topologies.
//
//   states    unbound → starting → running ⇄ suspending → suspended → destroyed
//   policies  always (executor online ⇒ runtime stays up)
//             on_demand (bind on need: traffic or a due schedule, drain when quiet)
//             ephemeral (bounded lifetime, destroyed at expiry — demo cells)
//
// Everything here is pure: no IO, no timers — the executors own those.

import cronParser from "cron-parser";
import fs from "node:fs";
import path from "node:path";

export const CELL_STATES = Object.freeze([
  "unbound",
  "starting",
  "running",
  "suspending",
  "suspended",
  "destroyed",
]);

export const RESIDENCY_POLICIES = Object.freeze(["always", "on_demand", "ephemeral"]);

// Uplink whitelist (spec: presence 与需求清单上行). Content fields are NOT in
// the schema's type space — absence here is the defence, not a discipline.
export const PRESENCE_FIELDS = Object.freeze(["state", "os", "appVersion", "protocolVersion", "at"]);
export const MANIFEST_FIELDS = Object.freeze(["fleetCount", "memberCount", "enabledTaskCount", "labels", "at"]);
export const STEWARD_PROTOCOL_VERSION = 1;

// Transition table: event → state it may fire from → next state. Registry
// truth wins over process reality (spec): executors reconcile TOWARD it.
const TRANSITIONS = {
  register: { from: [null], to: "unbound" },
  bindRequested: { from: ["unbound", "suspended"], to: "starting" },
  up: { from: ["starting"], to: "running" },
  bindFailed: { from: ["starting"], to: "unbound" },
  drainRequested: { from: ["running"], to: "suspending" },
  // `down` is idempotent parking (roll-time every non-destroyed row parks): a
  // row that never started or is already parked stays `suspended`, not an error.
  down: { from: ["suspending", "running", "starting", "unbound", "suspended"], to: "suspended" },
  destroyRequested: { from: ["unbound", "suspended", "running", "starting", "suspending"], to: "destroyed" },
};

// transition(row, event) → { state, actions[] } or { error }. Pure: the
// executor performs the side effects listed in actions, in order.
export function transition(row, event) {
  const t = TRANSITIONS[event.type];
  if (!t) return { error: `unknown lifecycle event: ${event.type}` };
  const from = row?.state ?? null;
  const fromOk = t.from.includes(from) || (t.from.includes(null) && from === null);
  if (!fromOk) return { error: `cannot ${event.type} from ${from ?? "<no row>"}` };

  const nowMs = event.now ?? Date.now();
  const base = {
    ...(row ?? {}),
    state: t.to,
    updatedAt: nowMs,
    ...(t.to === "running" ? { lastBoundAt: nowMs } : {}),
    ...(t.to === "destroyed"
      ? { destroy: { reason: event.reason ?? "operator", at: nowMs } }
      : {}),
  };
  delete base.error;

  const actions = [];
  if (t.to === "starting") actions.push("spawn");
  if (t.to === "suspending") actions.push("drain");
  if (t.to === "suspended") actions.push("unarm-or-keep"); // wake timers live in the registry-derived schedule
  if (t.to === "destroyed") actions.push("stop-all", "invalidate-credentials", "tombstone");

  return { row: base, state: t.to, actions };
}

// Derived: what the duty ring / steward asks — is this registry row due any
// wake right now? Reads only persisted data (nextDueAt carried in workload);
// never probes a process. `always` cells are not the ring's business.
export function wakeDue(row, nowMs = Date.now()) {
  if (!row || row.state !== "suspended") return false;
  if (row.policy !== "on_demand") return false;
  const due = row.workload?.nextDueAt;
  return Number.isFinite(due) && due <= nowMs;
}

// ── Schedule scanning (duty-ring canon) ─────────────────────────────────────
// Pure cron-math over a data root's persisted task records — the cloud ring
// and the desktop steward both decide "due?" from jobs.json and NOTHING else
// (spec: the wake decision never spawns or probes the cell). cron-parser is a
// repo dependency already; the shape read here is the task-engine's
// saveTasks whitelist (cron/tz/type/paused/lastRun/createdAt).

export function readCronJobs(jobsFile) {
  try {
    const rows = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export function cellJobsFile(dataCellRoot) {
  // Gateway layout: <CELL_DATA_ROOT>/<userId>/data/cron-store/jobs.json.
  // Desktop layout: <userData>/data/cron-store/jobs.json (same tail).
  return path.join(dataCellRoot, "data", "cron-store", "jobs.json");
}

// An enabled recurring row has an occurrence between its own lastRun (or
// creation) and now? The cell's catch-up decides which occurrence to make
// up; the ring only has to know the cell must wake.
export function cronJobsDue(jobs, fromMs) {
  for (const j of jobs) {
    if (j?.paused || !j?.cron || j?.type !== "recurring") continue;
    try {
      const anchor = j.lastRun ? Date.parse(j.lastRun) : (j.createdAt ? Date.parse(j.createdAt) : null);
      if (anchor == null || !Number.isFinite(anchor)) continue;
      const iter = cronParser.parseExpression(j.cron, { tz: j.tz || undefined, currentDate: new Date(anchor) });
      const occ = iter.next().toDate().getTime();
      if (occ <= fromMs) return true;
    } catch { /* unparseable schedules are the engine's problem, not the ring's */ }
  }
  return false;
}

// Newest lastRun across enabled rows — the answer to "when did this cell
// last actually work", without booting the cell to ask.
export function cronJobsLatestFireAt(jobs) {
  let latest = null;
  for (const j of jobs) {
    const t = j?.lastRun ? Date.parse(j.lastRun) : null;
    if (Number.isFinite(t) && (latest == null || t > latest)) latest = t;
  }
  return latest;
}
