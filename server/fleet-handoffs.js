// Handoff + fanout ignition seam (agent-fleet-orchestration D4, add-fleet-fanout D2).
//
// Extracted from server.js's ctx wiring so the REAL function is importable by
// tests — the pre-extraction fanout tests mirrored the logic in their own
// stubs and self-consistently missed the `if (!edges.length) return null`
// early return that made every fanout-only source dead (挂账取证班 2026-10-31
// 真缺陷: the fanout loop sat after the early return, so a member whose only
// outgoing edges are fanouts never ignited them; fanout fleets that also
// handed off were the only working shape). The early return is gone — the
// handoff loop no-ops on an empty list and the fanout loop always runs.
//
// Upstream completion — ok or failed, both honestly relayed — creates one
// manual turn per declared outgoing edge, depth read from the chain position
// in origin.fleet. Over-bound hops create nothing but leave an honest event
// row. Cluster posts have no manual lane: skipped, their next
// cadence/delegation turn carries the work.

import { outgoingHandoffs, outgoingFanouts, constraintsOf } from "./fleet-orchestration.js";
import { derivedLaneCarrier } from "./fleet-events.js";

export function igniteFleetEdges({ db, engine, job, out, rosterPresetId = (id) => id, chainFor = () => null }) {
  const withChain = (fleet, edgeKind) => {
    const chain = chainFor(edgeKind);
    return chain ? { ...fleet, chain } : fleet;
  };
  let fleetId = null;
  let memberId = null;
  let chainDepth = 0;
  if (job?.origin?.fleet?.fleetId) {
    fleetId = job.origin.fleet.fleetId;
    memberId = job.origin.fleet.memberId ?? null;
    chainDepth = Number.isFinite(job.origin.fleet.depth) ? job.origin.fleet.depth : 0;
  } else if (job?.sourceTag?.fleetId) {
    fleetId = job.sourceTag.fleetId;
    memberId = job.sourceTag.memberId ?? null;
  }
  if (!fleetId || !memberId) return null;
  const fleet = db.getFleet(fleetId);
  if (!fleet?.orchestration) return null;
  const edges = outgoingHandoffs(fleet.orchestration, memberId);
  // No early return here (see header): fanout-only sources must reach the
  // fanout loop below.
  const constraints = constraintsOf(fleet.orchestration);
  const nextDepth = chainDepth + 1;
  const now = Date.now();
  const dispatched = [];
  for (const e of edges) {
    const target = db.getMember(e.to);
    if (!target || target.fleetId !== fleetId) continue;
    if (target.targetKind === "cluster") continue;
    if (nextDepth > constraints.maxChainDepth) {
      db.appendTurnEvent({
        fleetId,
        memberId: target.id,
        source: "manual",
        status: "failed",
        errorKind: "other",
        error: `handoff depth bound reached (${nextDepth} > ${constraints.maxChainDepth}) — chain stopped before this hop`,
        startedAt: now,
        endedAt: now,
        sessionId: null,
        // Derived-lane marking (add-turn-metering挂账): the turn never
        // dispatched — the row carries the lane it BELONGS to.
        metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
      });
      continue;
    }
    // Tool hops are deterministic: the edge carries their JSON args (edge.
    // args); prose summaries are not executable arguments and fail honestly.
    if (target.targetKind === "tool") {
      const argsOk = e.args != null && typeof e.args === "object" && !Array.isArray(e.args);
      if (!argsOk) {
        db.appendTurnEvent({
          fleetId,
          memberId: target.id,
          source: "manual",
          status: "failed",
          errorKind: "runtime_not_ready",
          error: "handoff to a tool post needs the edge's `args` (JSON object) — upstream prose is not executable",
          startedAt: now,
          endedAt: now,
          sessionId: null,
          // Tool targets carry no lane (consistent with executed tool turns).
          metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
        });
        continue;
      }
      const task = engine.createManualTask({
        prompt: JSON.stringify(e.args),
        tool: target.targetId,
        sessionTitle: `接棒 · ${target.title}`,
        origin: { fleet: withChain({ fleetId, memberId: target.id, depth: nextDepth }, "handoff") },
        executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
      });
      dispatched.push({ to: target.id, taskId: task.id });
      continue;
    }
    const summary = out?.ok === true
      ? String(out.text ?? "").slice(0, 2000) || "(upstream produced no text)"
      : `上游回合失败:${String(out?.error ?? "unknown").slice(0, 500)}——如实转述,不自动重试`;
    const task = engine.createManualTask({
      prompt:
        `【舰队接棒】上游岗位回合结束,依声明边接棒(链位 ${nextDepth}/${constraints.maxChainDepth})。\n` +
        `上游结果:\n${summary}`,
      ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: rosterPresetId(target.targetId) }),
      sessionTitle: `接棒 · ${target.title}`,
      origin: { fleet: withChain({ fleetId, memberId: target.id, depth: nextDepth }, "handoff") },
      executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
    });
    dispatched.push({ to: target.id, taskId: task.id });
  }

  // Fanout edges (add-fleet-fanout D2): one parallel wave per edge — a
  // manual turn per target, same honest relay as handoff, depth rides the
  // chain. Aggregation rides the delegation aggregator VERBATIM: no-judge
  // waves carry the upstream session as initiator (the group's outcomes
  // inject into the upstream post's next turn); judge waves carry the
  // synthetic fleet-scoped initiator + the judge's roster preset, so the
  // aggregator switches to the judge persona and runs the ruling turn on
  // group completion. Wave counter is provenance only (single wave per
  // upstream turn; further debate rounds are the judge's own dispatch_post
  // calls, depth is the hard bound).
  const fanouts = outgoingFanouts(fleet.orchestration, memberId);
  for (const e of fanouts) {
    const agg = e.aggregate ?? { kind: "all" };
    const judge = agg.kind === "judge" ? db.getMember(agg.judge) : null;
    if (agg.kind === "judge" && (!judge || judge.fleetId !== fleetId || judge.targetKind !== "persona")) continue;
    const summary = out?.ok === true
      ? String(out.text ?? "").slice(0, 2000) || "(upstream produced no text)"
      : `上游回合失败:${String(out?.error ?? "unknown").slice(0, 500)}——如实转述,不自动重试`;
    const rounds = Number.isInteger(e.rounds) ? e.rounds : 1;
    for (const t of e.targets ?? []) {
      const target = db.getMember(t);
      if (!target || target.fleetId !== fleetId) continue;
      if (target.targetKind === "cluster" || target.targetKind === "tool") continue;
      if (nextDepth > constraints.maxChainDepth) {
        db.appendTurnEvent({
          fleetId,
          memberId: target.id,
          source: "manual",
          status: "failed",
          errorKind: "other",
          error: `fanout depth bound reached (${nextDepth} > ${constraints.maxChainDepth}) — wave stopped before this hop`,
          startedAt: now,
          endedAt: now,
          sessionId: null,
          // Derived-lane marking (add-turn-metering挂账): the turn never
          // dispatched — the row carries the lane it BELONGS to.
          metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
        });
        continue;
      }
      const task = engine.createManualTask({
        prompt:
          `【舰队并行扇出】上游岗位「${db.getMember(memberId)?.title ?? memberId}」回合结束,你与同波同伴并行接令(轮次 1/${rounds})。\n` +
          `上游结果:\n${summary}`,
        ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: rosterPresetId(target.targetId) }),
        sessionTitle: `扇出 · ${target.title}`,
        origin: { fleet: withChain({ fleetId, memberId: target.id, depth: nextDepth, wave: 1 }, "fanout") },
        ...(judge
          ? { initiator: `fleet:${fleetId}:${judge.id}`, initiatorPreset: rosterPresetId(judge.targetId) }
          : { initiator: job.sessionId ?? null }),
        executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
      });
      dispatched.push({ to: target.id, taskId: task.id, wave: true, judge: judge?.id ?? null });
    }
  }
  return dispatched.length ? dispatched : null;
}
