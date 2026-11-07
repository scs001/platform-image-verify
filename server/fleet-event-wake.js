// Fleet event wake (add-fleet-event-wake; authorization lane woven in by
// add-turn-mandate-lane).
//
// The FIRST bound external signal source: a social-chat bot's inbound message
// (server/bots.js) wakes a fleet post. No bus, no routing table, no wildcard
// subscriptions — one existing signal source, declared event edges, manual
// turns. The bot's own session turn is UNTOUCHED (it answers the chat; the
// post does fleet work asynchronously — the dual-turn is the owner's declared
// choice). One guard: per post per hour, honest refusal rows over the cap.
//
// add-turn-mandate-lane: every wake decision now passes the source's signal
// policy (server/fleet-turn-mandate.js). With NO policy file (the default),
// the gate admits edge hits exactly as before — byte-identical wakes — and
// every task records its immutable mandate; every inbound message gets a
// disposition row. observe shadows new surfaces (would_accept, never wakes);
// auto admits non-edge candidates through a matched rule, which also names
// the route (the rule's `target` post).

import { rosterPresetId } from "../dsh-profile.js";
import { derivedLaneCarrier } from "./fleet-events.js";
import { readSignalPolicy, admitTrigger, buildMandate, recordDisposition } from "./fleet-turn-mandate.js";

const buckets = new Map(); // `${fleetId}:${memberId}` → timestamps[]

function hourlyCap() {
  const n = Number(process.env.FLEET_EVENT_WAKE_HOURLY_CAP);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function take(key) {
  const now = Date.now();
  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < 3_600_000);
  if (stamps.length >= hourlyCap()) {
    buckets.set(key, stamps);
    return false;
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return true;
}

// The wake prompt envelope — ONE builder so edge wakes and rule wakes read
// the same shape (byte-identical for edge wakes, the red line).
function wakePrompt(source, senderName, chatKey, text) {
  return (
    `【事件唤醒】外部信号源 ${source} 收到来自「${senderName ?? "未知发送者"}」的消息(聊天 ${chatKey ?? "-"}):\n` +
    String(text ?? "").slice(0, 4000)
  );
}

// Resolve a rule-named target across non-archived fleets (persona/a2a only —
// the same target domain the edge lane admits).
function findRuleTarget(db, memberId) {
  for (const fleet of db.listFleets()) {
    if (fleet.state === "archived") continue;
    const target = db.getMember(memberId);
    if (target && target.fleetId === fleet.id && (target.targetKind === "persona" || target.targetKind === "a2a")) {
      return { fleet, target };
    }
  }
  return null;
}

function createWakeTask(engine, roster, { fleet, target, source, senderName, chatKey, text, mandate, ruleId = null }) {
  return engine.createManualTask({
    prompt: wakePrompt(source, senderName, chatKey, text),
    ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: roster(target.targetId) }),
    sessionTitle: `事件 · ${target.title}`,
    origin: {
      fleet: { fleetId: fleet.id, memberId: target.id, depth: 0 },
      event: { botId: mandate.trigger.botId, chatKey: chatKey ?? null, ...(ruleId ? { rule: ruleId } : {}) },
      mandate,
    },
  });
}

// Scan the (non-archived) fleets' event edges for `bot:<botId>` and wake each
// bound post. Pure-dependency injection (db/engine/roster) so tests drive it
// without the app; returns the created task list for the log. `meta.addressed`
// is the bots.js mention heuristic (v1: bot name appears in the text) — only
// the non-edge table rows read it.
export function triggerFleetEventWake({ db, engine, roster = rosterPresetId }, botId, { chatKey, senderName, text, addressed = false } = {}) {
  const source = `bot:${botId}`;
  const policy = readSignalPolicy(botId);
  const created = [];
  const now = Date.now();
  let sawEdge = false;
  for (const fleet of db.listFleets()) {
    if (fleet.state === "archived") continue;
    const edges = (fleet.orchestration?.edges ?? []).filter((e) => e?.kind === "event" && e.from === source);
    for (const e of edges) {
      sawEdge = true;
      const target = db.getMember(e.to);
      if (!target || target.fleetId !== fleet.id) continue;
      if (target.targetKind !== "persona" && target.targetKind !== "a2a") continue;
      const gate = admitTrigger({ policy, edgeHit: true, senderName, text });
      if (!gate.admitted) {
        recordDisposition(botId, { fate: "filtered", reason: gate.reason, chatKey: chatKey ?? null, sender: senderName ?? null, post: target.id });
        continue;
      }
      if (!take(`${fleet.id}:${target.id}`)) {
        recordDisposition(botId, { fate: "cap_refused", reason: "hourly_cap", chatKey: chatKey ?? null, sender: senderName ?? null, post: target.id });
        db.appendTurnEvent({
          fleetId: fleet.id,
          memberId: target.id,
          source: "event",
          status: "failed",
          errorKind: "other",
          error: `event wake hourly cap (${hourlyCap()}) reached for bot '${botId}' — message dropped for this post, honestly`,
          startedAt: now,
          endedAt: now,
          sessionId: null,
          // Derived-lane marking (add-turn-metering挂账): the wake was refused —
          // the row carries the lane it BELONGS to.
          metering: { carrier: derivedLaneCarrier({ member: target, fleet, targetKind: target.targetKind }) },
        });
        continue;
      }
      const mandate = buildMandate({
        strength: gate.strength,
        via: gate.via,
        row: gate.row,
        cell: gate.cell,
        policy,
        botId,
        chatKey,
        senderName,
      });
      const task = createWakeTask(engine, roster, { fleet, target, source, senderName, chatKey, text, mandate });
      recordDisposition(botId, {
        fate: "admitted",
        reason: "edge_hit",
        chatKey: chatKey ?? null,
        sender: senderName ?? null,
        post: target.id,
        taskId: task.id,
        strength: gate.strength,
        policyVersion: mandate.policyVersion,
      });
      created.push({ fleetId: fleet.id, memberId: target.id, taskId: task.id });
    }
  }
  if (!sawEdge) {
    if (policy.mode === "off") {
      // The current behavior for an unmatched message: nothing. The
      // disposition row is the new honest record of that nothing.
      recordDisposition(botId, { fate: "filtered", reason: "off_mode", chatKey: chatKey ?? null, sender: senderName ?? null });
    } else {
      // observe/auto assess the non-edge surface. Routing is structural: the
      // matched rule's `target` names the post (admitTrigger guarantees a
      // ruleId on any non-edge admission).
      const gate = admitTrigger({ policy, edgeHit: false, senderName, addressed: addressed === true, text });
      if (gate.wouldAccept) {
        recordDisposition(botId, { fate: "would_accept", reason: gate.reason, ruleId: gate.ruleId ?? null, chatKey: chatKey ?? null, sender: senderName ?? null });
      } else if (gate.admitted) {
        const found = findRuleTarget(db, policy.rules.find((r) => r.id === gate.ruleId)?.target);
        if (!found) {
          recordDisposition(botId, { fate: "filtered", reason: "rule_target_unresolved", ruleId: gate.ruleId ?? null, chatKey: chatKey ?? null, sender: senderName ?? null });
        } else if (!take(`${found.fleet.id}:${found.target.id}`)) {
          recordDisposition(botId, { fate: "cap_refused", reason: "hourly_cap", ruleId: gate.ruleId ?? null, chatKey: chatKey ?? null, sender: senderName ?? null, post: found.target.id });
        } else {
          const mandate = buildMandate({
            strength: gate.strength,
            via: gate.via,
            row: gate.row,
            cell: gate.cell,
            ruleId: gate.ruleId,
            policy,
            botId,
            chatKey,
            senderName,
          });
          const task = createWakeTask(engine, roster, {
            ...found,
            source,
            senderName,
            chatKey,
            text,
            mandate,
            ruleId: gate.ruleId,
          });
          recordDisposition(botId, {
            fate: "admitted",
            reason: "rule_match",
            ruleId: gate.ruleId ?? null,
            chatKey: chatKey ?? null,
            sender: senderName ?? null,
            post: found.target.id,
            taskId: task.id,
            strength: gate.strength,
            policyVersion: mandate.policyVersion,
          });
          created.push({ fleetId: found.fleet.id, memberId: found.target.id, taskId: task.id });
        }
      } else {
        recordDisposition(botId, { fate: "filtered", reason: gate.reason, chatKey: chatKey ?? null, sender: senderName ?? null });
      }
    }
  }
  return created;
}
