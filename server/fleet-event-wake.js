// Fleet event wake (add-fleet-event-wake, agent-fleet-orchestration).
//
// The FIRST bound external signal source: a social-chat bot's inbound message
// (server/bots.js) wakes a fleet post. No bus, no routing table, no wildcard
// subscriptions — one existing signal source, declared event edges, manual
// turns. The bot's own session turn is UNTOUCHED (it answers the chat; the
// post does fleet work asynchronously — the dual-turn is the owner's declared
// choice). One guard: per post per hour, honest refusal rows over the cap.

import { rosterPresetId } from "../dsh-profile.js";

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

// Scan the (non-archived) fleets' event edges for `bot:<botId>` and wake each
// bound post. Pure-dependency injection (db/engine/roster) so tests drive it
// without the app; returns the created task list for the log.
export function triggerFleetEventWake({ db, engine, roster = rosterPresetId }, botId, { chatKey, senderName, text }) {
  const source = `bot:${botId}`;
  const created = [];
  const now = Date.now();
  for (const fleet of db.listFleets()) {
    if (fleet.state === "archived") continue;
    const edges = (fleet.orchestration?.edges ?? []).filter((e) => e?.kind === "event" && e.from === source);
    for (const e of edges) {
      const target = db.getMember(e.to);
      if (!target || target.fleetId !== fleet.id) continue;
      if (target.targetKind !== "persona" && target.targetKind !== "a2a") continue;
      if (!take(`${fleet.id}:${target.id}`)) {
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
        });
        continue;
      }
      const task = engine.createManualTask({
        prompt:
          `【事件唤醒】外部信号源 ${source} 收到来自「${senderName ?? "未知发送者"}」的消息(聊天 ${chatKey ?? "-"}):\n` +
          String(text ?? "").slice(0, 4000),
        ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: roster(target.targetId) }),
        sessionTitle: `事件 · ${target.title}`,
        origin: { fleet: { fleetId: fleet.id, memberId: target.id, depth: 0 }, event: { botId, chatKey: chatKey ?? null } },
      });
      created.push({ fleetId: fleet.id, memberId: target.id, taskId: task.id });
    }
  }
  return created;
}
