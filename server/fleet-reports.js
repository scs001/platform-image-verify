// Fleet report lane core (agent-fleet-report-lane).
//
// Pure/injectable logic for the status-report tool: payload validation (lenient
// write, strict presentation — undeclared slot keys are kept in the report but
// never reach the card), server-side attribution (preset → post, running
// cluster task → post; the caller can never name a post), flood control
// (window = half the cadence period, 10-minute floor, 3 per window), and the
// read-side views (latest with system-computed trends, timeline pages).
// Storage lives in fleets-db; the HTTP/tool faces live in routes/fleets.js
// and server/fleet-mcp.js.

import { resolveModelChain, resolveAgentEffort } from "./fleet-model.js";

const SUMMARY_MAX = 4000;
const METRIC_VALUE_MAX = 300;
const RESOURCES_MAX = 50;
const BLOCKERS_MAX = 20;
const REPORT_BODY_LIMIT = 8 * 1024; // design D7: one report ≤ 8KB
const FLOOD_WINDOW_FLOOR_MS = 10 * 60 * 1000;
const FLOOD_MAX_PER_WINDOW = 3;

// ── Validation (lenient write, strict presentation) ─────────────────────────

// Returns { ok, report } | { ok: false, error }. `metrics` keeps every
// submitted key verbatim (details must not lose data); slot filtering happens
// only in the card view. Anything structurally unusable is rejected.
export function validateReportPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "report payload must be an object" };
  }
  const { metrics, resources, blockers, summary } = payload;
  if (!summary || typeof summary !== "string" || !summary.trim()) {
    return { ok: false, error: "summary is required" };
  }
  if (summary.length > SUMMARY_MAX) {
    return { ok: false, error: `summary exceeds ${SUMMARY_MAX} characters` };
  }

  const cleanMetrics = {};
  if (metrics !== undefined && metrics !== null) {
    if (typeof metrics !== "object" || Array.isArray(metrics)) {
      return { ok: false, error: "metrics must be an object keyed by slot key" };
    }
    for (const [key, slot] of Object.entries(metrics)) {
      if (typeof key !== "string" || !key.trim()) {
        return { ok: false, error: "metric keys must be non-empty strings" };
      }
      if (!slot || typeof slot !== "object") {
        return { ok: false, error: `metric '${key}' must be { value, delta? }` };
      }
      const value = slot.value;
      if (typeof value !== "string" && typeof value !== "number") {
        return { ok: false, error: `metric '${key}'.value must be a string or number` };
      }
      if (String(value).length > METRIC_VALUE_MAX) {
        return { ok: false, error: `metric '${key}'.value exceeds ${METRIC_VALUE_MAX} characters` };
      }
      cleanMetrics[key] = {
        value,
        ...(slot.delta !== undefined && slot.delta !== null ? { delta: String(slot.delta).slice(0, 300) } : {}),
      };
    }
  }

  let cleanResources = [];
  if (resources !== undefined && resources !== null) {
    if (!Array.isArray(resources) || resources.length > RESOURCES_MAX) {
      return { ok: false, error: `resources must be an array of at most ${RESOURCES_MAX} entries` };
    }
    cleanResources = resources.map((r) => ({
      name: String(r?.name ?? "").slice(0, 200),
      kind: String(r?.kind ?? "").slice(0, 60),
      ...(r?.url ? { url: String(r.url).slice(0, 500) } : {}),
    }));
  }

  let cleanBlockers = [];
  if (blockers !== undefined && blockers !== null) {
    if (!Array.isArray(blockers) || blockers.length > BLOCKERS_MAX) {
      return { ok: false, error: `blockers must be an array of at most ${BLOCKERS_MAX} strings` };
    }
    cleanBlockers = blockers.map((b) => String(b).slice(0, 500));
  }

  const report = { metrics: cleanMetrics, resources: cleanResources, blockers: cleanBlockers, summary };
  if (JSON.stringify(report).length > REPORT_BODY_LIMIT) {
    return { ok: false, error: "report exceeds the 8KB size limit" };
  }
  return { ok: true, report };
}

// ── Attribution ──────────────────────────────────────────────────────────────

// Resolve which post a report belongs to, from the server's own execution
// context — never from caller input (design D3):
//   1. A fleet CLUSTER task currently running: its fan-out rotates member
//      presets, so the live preset would misattribute to a persona post; the
//      running task's sourceTag names the true post.
//   2. Otherwise the live preset: persona posts whose roster preset id (or raw
//      target id) equals it. Exactly one → that post; several → ambiguous
//      rejection (overlapping user-built fleets must not be guessed); none →
//      the caller is not a fleet member.
export function resolveAttribution({ currentPreset, runningTasks = [], personaMembers = [], rosterPresetId = (id) => id }) {
  const runningClusterFleetTasks = runningTasks.filter(
    (t) => t?.state === "running" && t?.sourceTag?.fleetId && t?.targetType === "cluster",
  );
  if (runningClusterFleetTasks.length === 1) {
    const tag = runningClusterFleetTasks[0].sourceTag;
    return { kind: "cluster-task", fleetId: tag.fleetId, memberId: tag.memberId, task: runningClusterFleetTasks[0] };
  }

  if (!currentPreset) {
    return { kind: "none", error: "no agent is running — cannot attribute a report" };
  }
  const hits = personaMembers.filter(
    (m) => m.targetKind === "persona" && (m.targetId === currentPreset || rosterPresetId(m.targetId) === currentPreset),
  );
  if (hits.length === 1) {
    return { kind: "preset", fleetId: hits[0].fleetId, memberId: hits[0].id, member: hits[0] };
  }
  if (hits.length > 1) {
    return {
      kind: "ambiguous",
      error: `this agent holds several posts (${hits.map((m) => m.title).join(", ")}) — reports would be ambiguous`,
    };
  }
  return { kind: "none", error: "this agent is not a member of any fleet — report_status is for fleet posts" };
}

// ── Turn identity ────────────────────────────────────────────────────────────

// The one-line post identity a fleet member's turn carries at the head of its
// prompt (enable-wire-content-fleet D1), so an agent can NAME its own
// production source instead of inventing a string. `turn` (add-fleet-identity-turn)
// completes the deploy/post/round triple external consumers recite as
// source_ref — the caller hands in the round's landed child session id; absent
// turn keeps the line byte-identical (non-turn callers never grow a segment).
// Attribution decides who (resolveAttribution above); this only formats.
// Credential-free by construction — ids and a title, nothing else — and never
// written to the catalog or an AgentCard.
export function renderFleetIdentity({ fleetId, memberId, title, targetKind, targetId, turn }) {
  const base = `【集群岗位身份】fleet=${fleetId}; post=${memberId}; title=${title ?? ""}; target=${targetKind ?? ""}:${targetId ?? ""}`;
  return turn ? `${base}; turn=${turn}` : base;
}

// The post a persona is on duty for → its turn identity line, or null.
// Attribution is the report bridge's own (resolveAttribution): no post or
// several posts (ambiguous) both yield null, so the turn runs unchanged.
// `turn` rides through to renderFleetIdentity verbatim.
export function fleetIdentityFor(db, presetId, { rosterPresetId = (id) => id, turn = null } = {}) {
  if (!presetId) return null;
  const personaMembers = [];
  for (const f of db.listFleets()) {
    // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
    // attribution — the same guard the report/escalate scans carry. Without
    // it a ghost post makes the live post's attribution ambiguous (null):
    // identity prefix lost, post-model normalization silently skipped.
    if (f.state === "archived") continue;
    for (const m of db.listMembers(f.id)) {
      if (m.targetKind === "persona") personaMembers.push(m);
    }
  }
  const attribution = resolveAttribution({ currentPreset: presetId, personaMembers, rosterPresetId });
  if (attribution.kind !== "preset") return null;
  const member = db.getMember(attribution.memberId);
  if (!member) return null;
  return renderFleetIdentity({
    fleetId: member.fleetId,
    memberId: member.id,
    title: member.title,
    targetKind: member.targetKind,
    targetId: member.targetId,
    turn,
  });
}

// The post a persona is on duty for → its resolved model plan, or null
// (add-fleet-post-model D3). Same attribution seam as fleetIdentityFor: the
// turn path hands in its live preset, this finds the on-duty member and
// resolves the chain [member.model, member.fallbackModel, fleet.defaultModel,
// cellDefault] against the current roster. Lookup is per-turn by design — the
// model declaration is NEVER materialized into the task record, so a PATCH
// costs zero reconciliation.
export function fleetModelFor(db, presetId, { rosterPresetId = (id) => id, roster = null, cellDefault = null } = {}) {
  if (!presetId) return null;
  const personaMembers = [];
  for (const f of db.listFleets()) {
    // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
    // attribution — the same guard the report/escalate scans carry. Without
    // it a ghost post makes the live post's attribution ambiguous (null):
    // identity prefix lost, post-model normalization silently skipped.
    if (f.state === "archived") continue;
    for (const m of db.listMembers(f.id)) {
      if (m.targetKind === "persona") personaMembers.push(m);
    }
  }
  const attribution = resolveAttribution({ currentPreset: presetId, personaMembers, rosterPresetId });
  if (attribution.kind !== "preset") return null;
  const member = db.getMember(attribution.memberId);
  if (!member) return null;
  const fleet = db.getFleet(member.fleetId);
  const fleetDefault = fleet?.defaultModel ?? null;
  const plan = resolveModelChain({
    model: member.model,
    fallbackModel: member.fallbackModel,
    fleetDefault,
    cellDefault,
    roster,
  });
  // Config dimensions (add-agent-config-dims): the SAME post the model chain
  // resolved, so effort/budget can never point at a different post than the
  // model does. Judged against the effective model — a level the landed model
  // does not declare falls through with a notice.
  const effort = resolveAgentEffort({
    agentEffort: member.effort ?? null,
    fleetEffort: fleet?.effort ?? null,
    model: plan.effective,
    roster,
  });
  return {
    memberId: member.id,
    fleetDefault,
    ...plan,
    // fix-fleet-model-drift: a declared chain on the post flags whether the
    // turn MUST re-assert its model each round (no session-ledger early
    // return — that ledger can drift away from the child's own selection).
    explicitChain: Boolean(member.model || member.fallbackModel),
    effort: effort.effort,
    effortSource: effort.source,
    effortNotices: effort.notices,
    contextBudget: member.contextBudget ?? fleet?.contextBudget ?? null,
  };
}

// ── Flood control ────────────────────────────────────────────────────────────

export function floodWindowMs(cadence, cronPeriodMs) {
  if (!cadence) return FLOOD_WINDOW_FLOOR_MS;
  const period = cronPeriodMs(cadence.cron, cadence.tz);
  if (!period) return FLOOD_WINDOW_FLOOR_MS;
  return Math.max(Math.floor(period / 2), FLOOD_WINDOW_FLOOR_MS);
}

// Returns { ok: true } | { ok: false, error, windowResetsAt }.
export function checkFlood({ countSince, windowMs, now = Date.now(), oldestInWindowAt = null }) {
  if (countSince < FLOOD_MAX_PER_WINDOW) return { ok: true };
  const windowResetsAt = oldestInWindowAt != null ? oldestInWindowAt + windowMs : now + windowMs;
  return {
    ok: false,
    error: `report limit reached (${FLOOD_MAX_PER_WINDOW} per ${Math.round(windowMs / 60000)} minutes) — next window at ${new Date(windowResetsAt).toISOString()}`,
    windowResetsAt,
  };
}

// ── Trends (system-computed; agent deltas are notes, never arithmetic) ───────

// Compare a slot's current value with the previous report's same-slot value.
// Numeric pairs get direction + numeric delta; string pairs get a changed/
// unchanged direction with no fabricated delta; no predecessor → null (无趋势,
// never faked).
export function computeTrend(currentValue, previousValue) {
  if (previousValue === undefined || previousValue === null) return null;
  const cur = currentValue?.value;
  const prev = typeof previousValue === "object" ? previousValue.value : previousValue;
  if (prev === undefined || prev === null) return null;
  const curNum = typeof cur === "number" ? cur : typeof cur === "string" && cur.trim() !== "" && Number.isFinite(Number(cur)) ? Number(cur) : null;
  const prevNum = typeof prev === "number" ? prev : typeof prev === "string" && prev.trim() !== "" && Number.isFinite(Number(prev)) ? Number(prev) : null;
  if (curNum != null && prevNum != null) {
    const delta = curNum - prevNum;
    return { direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat", deltaValue: delta };
  }
  return { direction: String(cur) === String(prev) ? "flat" : "changed", deltaValue: null };
}

// ── a2a derived execution summaries ─────────────────────────────────────────

// A finished a2a fleet task cannot self-report (the remote agent cannot call
// this cell's tools — physical fact, design D4): its last outcome becomes a
// derived report row, honestly badged. Returns null for anything that is not
// a finished a2a fleet fire.
export function derivedReportFromTask(task, { now = Date.now() } = {}) {
  if (!task?.sourceTag?.fleetId || task.targetType !== "a2a") return null;
  const last = Array.isArray(task.history) ? task.history[task.history.length - 1] : null;
  if (!last || last.time == null) return null;
  const ok = last.success !== false;
  const text = typeof last.text === "string" && last.text.trim() ? last.text.trim() : "";
  const summary = ok
    ? text.slice(0, SUMMARY_MAX) || "回合完成（无文本产出）"
    : `执行失败：${last.error || "未知错误"}`.slice(0, SUMMARY_MAX);
  return {
    id: `r_${now}_${Math.random().toString(36).slice(2, 8)}`,
    fleetId: task.sourceTag.fleetId,
    memberId: task.sourceTag.memberId,
    sessionId: task.sessionId ?? null,
    metrics: {},
    resources: [],
    blockers: ok ? [] : [String(last.error || "回合失败").slice(0, 500)],
    summary,
    source: "derived",
    createdAt: Date.parse(last.time) || now,
  };
}

// ── Read-side views ──────────────────────────────────────────────────────────

// The card-facing latest view: declared slots only (slot key → presentation),
// each carrying the system trend vs the previous report; the full metric set
// stays on the report row for the detail drawer.
export function buildLatestView({ report, previous, kpiSlots }) {
  if (!report) return null;
  const declared = new Map(kpiSlots.map((s) => [s.key, s]));
  const slots = kpiSlots
    .filter((s) => report.metrics[s.key] !== undefined)
    .map((s) => {
      const m = report.metrics[s.key];
      return {
        key: s.key,
        label: s.label,
        unit: s.unit ?? null,
        value: m.value,
        // The agent's self-reported delta is presentation-only annotation.
        note: m.delta ?? null,
        trend: computeTrend(m, previous?.metrics?.[s.key]),
      };
    });
  return {
    id: report.id,
    at: report.createdAt,
    summary: report.summary,
    source: report.source, // self | derived (a2a 执行摘要)
    sessionId: report.sessionId ?? null,
    slots,
    undeclaredKeys: Object.keys(report.metrics).filter((k) => !declared.has(k)),
    metricsAll: report.metrics,
    blockers: report.blockers,
  };
}
