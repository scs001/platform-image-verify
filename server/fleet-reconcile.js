// Fleet materialization & on-duty derivation (agent-fleet-core).
//
// The fleet layer OWNS NO SCHEDULER: a member's cadenceSpec materializes as a
// task-engine cron job tagged sourceTag { fleetId, memberId }, and this module
// is the diff engine that keeps (members × cadence) and (tagged tasks) in
// sync after every fleet write. The task engine stays the single execution
// source of truth; reconcile only adds / rewrites-in-place / pauses / removes.
//
// Pure-core style: the engine face (`cronApi`) and target resolution
// (`resolveTarget`) are injectable so tests drive the diff without a live
// catalog. The derived on-duty view is a read-time computation — statuses are
// NEVER stored (design D5).

import cronParser from "cron-parser";

// ── Schedule math ────────────────────────────────────────────────────────────

// Approximate the firing period of a cron expression (ms) from two forward
// occurrences. Null when unparseable — callers fall back to the 6h floor.
export function cronPeriodMs(cron, tz) {
  try {
    const iter = cronParser.parseExpression(cron, { tz: tz || undefined });
    const a = iter.next().toDate();
    const b = iter.next().toDate();
    const ms = b - a;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

const STALE_FLOOR_MS = 6 * 60 * 60 * 1000;

// Tolerance window before a post reads 失联: proportional to the cadence
// (2 × period), never below 6h (design D5).
export function staleWindowMs(cron, tz) {
  const period = cronPeriodMs(cron, tz);
  if (!period) return STALE_FLOOR_MS;
  return Math.max(2 * period, STALE_FLOOR_MS);
}

// ── Materialization spec ─────────────────────────────────────────────────────

// The addJob/updateJob arguments a member's cadence materializes into. Pure —
// target lookups are the route layer's job; here we only map shapes.
export function materializedSpec({ fleet, member, rosterPresetId = (id) => id, clusterName = null }) {
  const base = {
    cron: member.cadence.cron,
    tz: member.cadence.tz || null,
    prompt: member.cadence.promptTemplate,
    sessionTitle: `${fleet.name} · ${member.title}`,
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  };
  if (member.targetKind === "cluster") {
    return { ...base, clusterId: member.targetId, ...(clusterName ? { clusterName } : {}) };
  }
  if (member.targetKind === "a2a") {
    return { ...base, agent: member.targetId };
  }
  if (member.targetKind === "tool") {
    // Tool posts (add-tool-posts): the target is "server::tool" — a
    // deterministic MCP call, prompt is the JSON arguments verbatim.
    return { ...base, tool: member.targetId };
  }
  // persona: catalog agent id → dsh roster preset id (the one mapping point,
  // same as cluster member resolution).
  return { ...base, preset: rosterPresetId(member.targetId) };
}

// Field-level drift between the live task and the desired spec (both addJob
// shapes). Used by reconcile to rewrite in place — the task id (and its bound
// session) never changes on cadence edits or swaps.
export function specDrift(task, spec) {
  const changes = {};
  if ((task.cron ?? null) !== (spec.cron ?? null)) changes.cron = spec.cron;
  if ((task.tz ?? null) !== (spec.tz ?? null)) changes.tz = spec.tz;
  if ((task.prompt ?? null) !== (spec.prompt ?? null)) changes.prompt = spec.prompt;
  if ((task.sessionTitle ?? null) !== (spec.sessionTitle ?? null)) changes.sessionTitle = spec.sessionTitle;

  const desiredTargetType = spec.clusterId ? "cluster" : spec.agent ? "a2a" : spec.tool ? "tool" : "persona";
  const desiredPreset = spec.clusterId ?? spec.agent ?? spec.tool ?? spec.preset ?? null;
  const targetTypeChanged =
    (task.targetType ?? "persona") !== desiredTargetType ||
    (task.preset ?? null) !== desiredPreset;
  if (targetTypeChanged) {
    if (desiredTargetType === "cluster") {
      changes.clusterId = spec.clusterId;
      if (spec.clusterName) changes.clusterName = spec.clusterName;
    } else if (desiredTargetType === "a2a") {
      changes.agent = spec.agent;
    } else if (desiredTargetType === "tool") {
      changes.tool = spec.tool;
    } else {
      changes.preset = spec.preset ?? null;
    }
  } else if (desiredTargetType === "cluster" && spec.clusterName && (task.clusterName ?? null) !== spec.clusterName) {
    changes.clusterName = spec.clusterName;
  }
  return changes;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

// Diff a fleet's members against its sourceTag-tagged tasks and converge:
//   create missing tasks, rewrite drifted ones IN PLACE (id/session stable),
//   sync the paused bit to (fleet paused ∨ member paused ∨ vacant post), and
//   remove orphaned tasks (member gone, or cadence withdrawn → passive post).
// Idempotent by construction: a second pass with no state change touches
// nothing. Returns the actions taken (empty arrays on a no-op pass).
export async function reconcileFleet({
  fleetId,
  db, // fleets-db facade
  cronApi, // { listJobs, addJob, updateJob, pauseJob, resumeJob, removeJob }
  resolveTarget, // (member) => ({ alive: boolean, clusterName?: string })
  rosterPresetId = (id) => id,
}) {
  const fleet = db.getFleet(fleetId);
  if (!fleet) return { skipped: "fleet not found" };

  const members = db.listMembers(fleetId);
  const memberById = new Map(members.map((m) => [m.id, m]));
  const tagged = cronApi.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId);
  const taskByMember = new Map(tagged.map((j) => [j.sourceTag.memberId, j]));

  const out = { created: [], updated: [], paused: [], resumed: [], removed: [] };

  // Orphans first: members deleted, or cadence withdrawn (passive posts
  // materialize nothing — design D10).
  for (const task of tagged) {
    const member = memberById.get(task.sourceTag.memberId);
    if (!member || !member.cadence) {
      await cronApi.removeJob(task.id);
      out.removed.push(task.id);
    }
  }

  for (const member of members) {
    if (!member.cadence) continue;

    const target = resolveTarget(member);
    // Two pause layers + vacancy: a post whose incumbent object no longer
    // exists must stop firing (待补岗 stops new rounds; restaff re-arms).
    const desiredPaused =
      fleet.state !== "active" || member.cadence.enabled === false || !target.alive;

    const spec = materializedSpec({
      fleet,
      member,
      rosterPresetId,
      clusterName: target.clusterName ?? null,
    });
    const existing = taskByMember.get(member.id);

    if (!existing) {
      // Archived fleets never (re)materialize — archive is stop-and-keep.
      if (fleet.state === "archived") continue;
      const created = await cronApi.addJob(spec);
      if (desiredPaused && created?.id) {
        await cronApi.pauseJob(created.id);
        out.paused.push(created.id);
      }
      out.created.push(created?.id ?? null);
      continue;
    }

    const drift = specDrift(existing, spec);
    if (Object.keys(drift).length > 0) {
      await cronApi.updateJob(existing.id, drift);
      out.updated.push(existing.id);
    }
    if (desiredPaused && !existing.paused) {
      await cronApi.pauseJob(existing.id);
      out.paused.push(existing.id);
    } else if (!desiredPaused && existing.paused) {
      await cronApi.resumeJob(existing.id);
      out.resumed.push(existing.id);
    }
  }

  return out;
}

// Reconcile every fleet in the store (catalog-change hook): a catalog refresh
// can kill a post's incumbent (persona uninstalled) or revive one — converge
// all materialized tasks in one pass. Per-fleet errors never stop the loop.
export async function reconcileAllFleets({ db, cronApi, resolveTarget, rosterPresetId = (id) => id }) {
  const results = [];
  for (const fleet of db.listFleets()) {
    try {
      const actions = await reconcileFleet({
        fleetId: fleet.id,
        db,
        cronApi,
        resolveTarget,
        rosterPresetId,
      });
      results.push({ fleetId: fleet.id, ...actions });
    } catch (err) {
      results.push({ fleetId: fleet.id, error: err.message });
    }
  }
  return results;
}

// ── On-duty derivation (read-time, never stored) ─────────────────────────────

// Precedence: vacant (incumbent object gone) → passive (no cadence) → paused
// (either pause layer) → missing (no task / beyond tolerance window) → on_duty.
// The tolerance is DUAL-WINDOW once the report lane exists (agent-fleet-
// report-lane): an execution beyond the window OR a report beyond the window
// (when the post has ever reported) both read 失联 — evidence names which
// window fired. The evidence fields explain WHY a post reads the way it does
// (design D5).
export function deriveMemberStatus({ member, fleet, task, targetAlive, latestReport = null, now = Date.now() }) {
  const evidence = {
    lastRunAt: task?.lastRun ?? null,
    nextRunAt: task?.nextRun ?? null,
    staleWindowMs: member.cadence ? staleWindowMs(member.cadence.cron, member.cadence.tz) : null,
    fleetPaused: fleet?.state === "paused",
    memberPaused: member.cadence ? member.cadence.enabled === false : false,
    latestReportAt: latestReport?.createdAt ?? null,
    hitWindow: null,
  };

  if (targetAlive === false) {
    // Two birth-paths to a vacancy, two honest reasons: the empty-targetId
    // sentinel is minted ONLY by the provisioner's unique-post conflict
    // degradation (the target exists but holds a post elsewhere); any other
    // dead targetRef is the "deleted afterwards" case.
    return {
      status: "vacant",
      reason: member.targetId
        ? "target object no longer exists"
        : "no incumbent assigned — uniqueness conflict at instantiation",
      evidence,
    };
  }
  if (!member.cadence) {
    return { status: "passive", reason: "no cadence — runs only when delegated or replied to", evidence };
  }
  if (fleet?.state !== "active" || member.cadence.enabled === false) {
    return { status: "paused", reason: fleet?.state !== "active" ? "fleet paused" : "member paused", evidence };
  }
  if (!task) {
    return { status: "missing", reason: "no materialized task", evidence };
  }

  const window = evidence.staleWindowMs;
  const lastRunMs = task.lastRun ? Date.parse(task.lastRun) : null;
  const executionStale = (ms) => ms != null && Number.isFinite(ms) && now - ms > window;

  if (lastRunMs != null && Number.isFinite(lastRunMs)) {
    if (executionStale(lastRunMs)) {
      evidence.hitWindow = "execution";
      return { status: "missing", reason: `no execution for over the tolerance window (${Math.round(window / 3_600_000)}h)`, evidence };
    }
  } else {
    // Never ran: on-duty until the first occurrence is due AND the window has
    // passed since materialization (createdAt is ISO from task-engine).
    const createdMs = task.createdAt ? Date.parse(task.createdAt) : null;
    if (createdMs != null && Number.isFinite(createdMs) && now - createdMs > window) {
      evidence.hitWindow = "execution";
      return { status: "missing", reason: "materialized but never executed past the tolerance window", evidence };
    }
    return { status: "on_duty", reason: "awaiting first scheduled run", evidence };
  }

  // Execution is healthy — the report window still applies once the post has
  // ever reported (a patrol that never hears from a reporting post is stale).
  if (evidence.latestReportAt != null && now - evidence.latestReportAt > window) {
    evidence.hitWindow = "report";
    return { status: "missing", reason: `no report for over the tolerance window (${Math.round(window / 3_600_000)}h)`, evidence };
  }
  return { status: "on_duty", reason: "recent execution within tolerance", evidence };
}
