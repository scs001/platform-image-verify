// Run ledger (agent-fleet-runs, add-fleet-cockpit-v2).
//
// The execution instance behind the cockpit's live canvas and replay
// timeline. One ledger per cell, held on ctx as `fleetTurnLedger`:
//
//   begin(job)  — at the turn-seam's START: resolves the post (same rule as
//                 the outcome recorder), mints the turn id and — for a root
//                 turn — the run id; a downstream turn (dispatch / handoff /
//                 fanout) inherits its run from the chain the igniting side
//                 stamped on the task. Opens / re-opens the run header,
//                 registers the in-flight turn (by turn id, by session ids,
//                 by post) and broadcasts fleet_turn_started.
//   end(…)      — at the seam's END: writes the outcome row through
//                 recordTurnEvent (one shaping, one attribution), unregisters,
//                 broadcasts fleet_turn_ended.
//   settle(run) — after the seam has queued its handoffs: closes the header
//                 iff nothing of that run is still open or queued. The header
//                 is a projection recomputed from the rows (SUM), so a late
//                 downstream turn can re-open and re-close it idempotently.
//   tap(…)      — the collector's hook: fleet turns never cross
//                 handleDshEvent, so their runtime events reach the trace
//                 store from here, keyed by the ledger's turn id.
//
// Why ids at START (design D2): a dispatch_post call happens MID-turn and
// must stamp the upstream turn id on the task it creates; the outcome row
// does not exist yet. Everything degrades open — a ledger failure is a warn,
// never a failed turn (the seam wraps every call).

import { randomUUID } from "node:crypto";
import { buildTurnRequest } from "./turn-request.js";
import { resolveTurnPost, recordTurnEvent } from "./fleet-events.js";

export function mintId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// FLEET_TRACE_TAP=0 turns the collector tap off (a cell that would rather not
// double its trace.db); default on.
export function traceTapEnabled() {
  return process.env.FLEET_TRACE_TAP !== "0";
}

// Wire shape of the three fleet events — fleet-domain fields only: ids,
// outcome, timing. Never a credential, never a session body. parentMemberId
// resolves the chain's parent turn to its POST so the canvas can light the
// igniting edge (dispatch mid-turn reads the open registry; handoff reads the
// ended parent's row).
function turnWire(handle, extra = {}) {
  return {
    fleetId: handle.fleetId,
    memberId: handle.memberId,
    runId: handle.runId,
    turnId: handle.turnId,
    parentTurnId: handle.parentTurnId,
    parentMemberId: handle.parentMemberId,
    edgeKind: handle.edgeKind,
    source: handle.source,
    sessionId: handle.sessionId,
    startedAt: handle.startedAt,
    ...extra,
  };
}

export function createFleetTurnLedger({
  db,
  broadcast = () => {},
  engineRecords = () => [],
  trace = null,
  rosterPresetId = (id) => id,
  now = Date.now,
} = {}) {
  const open = new Map(); // turnId → handle
  const bySession = new Map(); // sessionId → turnId
  const byMember = new Map(); // memberId → turnId[] (oldest first)

  function emit(type, payload) {
    try {
      broadcast({ type, ...payload });
    } catch (e) {
      console.warn(`[fleet-runs] broadcast ${type} failed: ${e?.message || e}`);
    }
  }

  function register(handle) {
    open.set(handle.turnId, handle);
    for (const s of handle.sessionIds) bySession.set(s, handle.turnId);
    byMember.set(handle.memberId, [...(byMember.get(handle.memberId) ?? []), handle.turnId]);
  }

  function unregister(handle) {
    open.delete(handle.turnId);
    for (const s of handle.sessionIds) {
      if (bySession.get(s) === handle.turnId) bySession.delete(s);
    }
    const stack = (byMember.get(handle.memberId) ?? []).filter((t) => t !== handle.turnId);
    if (stack.length) byMember.set(handle.memberId, stack);
    else byMember.delete(handle.memberId);
  }

  // `sessionIds`: every id this turn's runtime events may arrive under — the
  // stable mirror session and, for fleet rounds, the rotated child id.
  function begin(job, { startedAt = now(), sessionIds = [] } = {}) {
    const request = buildTurnRequest(job);
    const post = resolveTurnPost(db, request, rosterPresetId);
    if (!post?.fleetId || !post?.memberId) return null;

    const chain = request.chain;
    const runId = chain?.runId ?? mintId("run");
    const turnId = mintId("turn");
    if (!chain) {
      db.insertRun({ runId, fleetId: post.fleetId, rootSource: request.source, rootMemberId: post.memberId, startedAt });
    } else {
      const header = db.getRun(runId);
      if (!header) {
        // The root's header is gone (pruned, or the chain crossed a cell
        // restart that lost it): keep the chain honest under its own id
        // rather than inventing a new run.
        db.insertRun({ runId, fleetId: post.fleetId, rootSource: request.source, rootMemberId: post.memberId, startedAt });
      } else if (header.status !== "open") {
        db.reopenRun(runId);
      }
    }

    const mirror = job?.sessionId ?? null;
    // The chain's parent post, for edge lighting on the canvas. Dispatch
    // happens while the parent turn is still open (registry hit); a handoff
    // fires after it ended (row hit). Neither found (pruned / cross-restart)
    // → null, and the client lights only the node.
    const parentMemberId = chain?.parentTurnId
      ? open.get(chain.parentTurnId)?.memberId ?? db.getTurnEvent(chain.parentTurnId)?.memberId ?? null
      : null;
    const handle = {
      turnId,
      runId,
      fleetId: post.fleetId,
      memberId: post.memberId,
      source: request.source,
      parentTurnId: chain?.parentTurnId ?? null,
      parentMemberId,
      edgeKind: chain?.edgeKind ?? null,
      startedAt,
      sessionId: mirror,
      sessionIds: [...new Set([mirror, ...sessionIds].filter(Boolean))],
      traceTurnId: trace && traceTapEnabled() ? turnId : null,
    };
    register(handle);
    if (handle.traceTurnId) {
      try {
        trace.bindTurn?.(turnId);
      } catch { /* best-effort */ }
    }
    emit("fleet_run_updated", { run: db.getRun(runId) });
    emit("fleet_turn_started", turnWire(handle));
    return handle;
  }

  function end(job, handle, outcome, meta = {}) {
    if (!handle) return null;
    let event = null;
    try {
      event = recordTurnEvent(db, job, outcome, { ...meta, rosterPresetId, ledgerTurn: handle });
    } finally {
      unregister(handle);
    }
    emit(
      "fleet_turn_ended",
      turnWire(handle, {
        endedAt: event?.endedAt ?? meta.endedAt ?? now(),
        status: event?.status ?? null,
        errorKind: event?.errorKind ?? null,
        model: event?.model ?? null,
        usage: event?.usage ?? null,
      }),
    );
    return event;
  }

  // Close the header when the run is quiescent: no in-flight turn and no
  // queued/running engine task carries this run. `excludeTaskId` is the task
  // whose turn just ended — the engine flips its state to done only AFTER the
  // turn function returns, so from inside the seam it still reads `running`.
  // Returns the header, or null while something is still pending.
  function settle(runId, { excludeTaskId = null } = {}) {
    if (!runId) return null;
    for (const h of open.values()) {
      if (h.runId === runId) return null;
    }
    for (const t of engineRecords()) {
      if (t?.origin?.fleet?.chain?.runId !== runId) continue;
      if (t.id === excludeTaskId) continue;
      if (t.state === "queued" || t.state === "running") return null;
    }
    if (!db.getRun(runId)) return null;
    const run = db.finalizeRun(runId);
    emit("fleet_run_updated", { run });
    return run;
  }

  // The chain a downstream task should carry when `handle`'s turn ignites it.
  function chainFor(handle, edgeKind) {
    if (!handle?.runId || !handle?.turnId) return null;
    return { runId: handle.runId, parentTurnId: handle.turnId, edgeKind };
  }

  function lookupBySession(sessionId) {
    const id = bySession.get(sessionId);
    return id ? open.get(id) ?? null : null;
  }

  // The post's newest in-flight turn (a mid-turn dispatch is attributed to a
  // post, not a session — see routes/fleets.js dispatch).
  function lookupByMember(memberId) {
    const stack = byMember.get(memberId);
    if (!stack?.length) return null;
    return open.get(stack[stack.length - 1]) ?? null;
  }

  // Collector hook (design D4). `sessionId` is the collector key (rotated child
  // id for fleet rounds); the rows land under the stable mirror session.
  function tap(notif, sessionId, mirrorSessionId = sessionId) {
    const handle = lookupBySession(sessionId);
    if (!handle?.traceTurnId) return false;
    try {
      trace.record(notif, { sessionId: mirrorSessionId, turnId: handle.traceTurnId });
      return true;
    } catch (e) {
      console.warn(`[fleet-runs] trace tap failed: ${e?.message || e}`);
      return false;
    }
  }

  function openTurns() {
    return [...open.values()];
  }

  return { begin, end, settle, chainFor, lookupBySession, lookupByMember, tap, openTurns, tapEnabled: traceTapEnabled };
}
