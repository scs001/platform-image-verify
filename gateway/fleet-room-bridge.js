// ── Fleet ↔ Zhiyu room bridge (add-zhiyu-team-memory 刀B) ───────────────────
//
// A room SUBSCRIBES to one of its principal's fleets; three fact classes flow
// in as kind=system event rows (report digest / decision opened / health
// transition), each carrying a cockpit deep link. PULL-based: on each tick the
// bridge samples the OWNER'S OWN cell (/api/fleets/overview over the same
// forged-identity channel the projection lane uses — no new uplink fields,
// no push channel into cells), diffs against its per-subscription cursor, and
// appends the rows. Rate control merges dense windows into one
// count+sample line; circuit-open drops count silently toward the next line's
// "N dropped" note (spec: 熔断期丢弃不补发、恢复后标注丢失量).
//
// This module is a pure diff+append worker; storage rides the zhiyu store's
// subscription table (zy_fleet_subs) and messageAppend. Summon (一键召唤:
// batch-invite the fleet's serving members + subscribe) is a route here too —
// it lists serving members from the same overview sample and creates the
// invites through the store's inviteCreate, so the handshake/policy machinery
// is the existing one.

import express from "express";
import { randomUUID } from "node:crypto";

const RATE_WINDOW_MS = 60 * 60 * 1000; // dense-window merge window (1h,防洪同款)
const MAX_PER_WINDOW = 10; // beyond this, merge into one count+sample line
const MAX_SUBS_PER_ROOM = 5;
const DROPS_NOTE_MIN = 1;

function systemRow(store, roomId, content, meta) {
  return store.messageAppend({
    roomId,
    kind: "system",
    fromAgent: 0,
    visibility: "shared",
    content,
    meta,
    provenance: "fleet-room-bridge",
  });
}

function diffOverview(prev, next) {
  const out = { reports: [], decisions: [], health: [] };
  if (!next) return out;
  const prevBy = new Map((prev?.fleets ?? []).map((f) => [f.id, f]));
  for (const f of next.fleets ?? []) {
    const before = prevBy.get(f.id);
    // Decisions: count grew → the notification carries the NEWEST top item
    // (the overview's top list is severity-ordered; the growth's face is its
    // head). First sight baselines silently — no retroactive dump.
    const dCount = f.openDecisions?.count ?? 0;
    const dPrev = before?.openDecisions?.count ?? 0;
    if (before && dCount > dPrev) {
      const top = f.openDecisions?.top?.[0] ?? null;
      out.decisions.push({ fleetId: f.id, fleetName: f.name, question: top?.question ?? "", severity: top?.severity ?? "normal", memberTitle: top?.memberTitle ?? null });
    }
    // Health: per-member status transitions (missing/vacant/failing entering
    // or leaving the abnormal set — the cockpit's own semantics, re-read).
    const abnormalNow = (f.counts?.missing ?? 0) + (f.counts?.vacant ?? 0) + (f.counts?.failing ?? 0);
    const abnormalPrev = (before?.counts?.missing ?? 0) + (before?.counts?.vacant ?? 0) + (before?.counts?.failing ?? 0);
    if (abnormalNow !== abnormalPrev) {
      out.health.push({ fleetId: f.id, fleetName: f.name, to: abnormalNow > abnormalPrev ? "abnormal" : "recovered", abnormal: abnormalNow });
    }
    // Reports: latest stream entry newer than the previous sample's newest.
    // First sight of a fleet (no `before`) BASELINES silently — the room
    // joins the story from now, no history dump (spec: 订阅基线).
    const stream = f.stream ?? [];
    const newest = stream[0];
    if (!before) {
      f._bridgeLastReportAt = newest?.at ?? 0;
    } else {
      const prevAt = before?._bridgeLastReportAt ?? 0;
      if (newest?.at && newest.at > prevAt) {
        out.reports.push({ fleetId: f.id, fleetName: f.name, memberTitle: newest.title, at: newest.at, summary: newest.summarySnip ?? "", metrics: newest.metrics ?? {} });
        f._bridgeLastReportAt = newest.at;
      }
    }
  }
  return out;
}

export function registerFleetRoomBridge(app, {
  store, // the zhiyu store (subscription table + messageAppend)
  resolveUser,
  rejectUnauthenticated,
  // The pull channel: (ownerEmail) => { fleets } — the wired default samples
  // the owner's own cell over the forged-identity channel; tests inject.
  sampleFleets,
  cockpitBase = "",
}) {
  // ── subscription management (owner- or authorized-member-gated) ──────────

  const requireMember = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };

  const authzFor = (roomId, email) => {
    const room = store.roomGet(roomId);
    if (!room) return { ok: false, status: 404 };
    if (room.ownerEmail === email) return { ok: true, room };
    const members = store.membersOf(roomId) ?? [];
    const me = members.find((m) => m.kind === "user" && m.ref === email && m.presence !== "removed");
    // An active user member may subscribe their OWN fleet into the room (the
    // spec: 订阅一支订阅者自己拥有的团队); only the owner lists/unlists all.
    return me ? { ok: true, room, member: me } : { ok: false, status: 404 };
  };

  app.get("/api/zhiyu/rooms/:id/fleet-subscriptions", (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    res.json({ subscriptions: store.fleetSubsOf(req.params.id) });
  });

  app.post("/api/zhiyu/rooms/:id/fleet-subscriptions", express.json({ limit: "4kb" }), async (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    const fleetId = String(req.body?.fleetId ?? "").trim();
    const fleetName = String(req.body?.fleetName ?? "").trim().slice(0, 120);
    if (!fleetId) return res.status(400).json({ error: "fleetId is required" });
    // OWNERSHIP: the subscriber must own the fleet — verified against the
    // live sample (the cell answers /overview for its owner only). A fleet
    // the caller does not own is indistinguishable from a nonexistent one
    // (probing teaches nothing).
    const overview = await sampleFleets(user.email);
    const fleet = (overview?.fleets ?? []).find((f) => f.id === fleetId);
    if (!fleet) return res.status(404).json({ error: "not found" });
    if (store.fleetSubsOf(req.params.id).length >= MAX_SUBS_PER_ROOM) {
      return res.status(409).json({ error: `a room subscribes at most ${MAX_SUBS_PER_ROOM} fleets` });
    }
    const sub = store.fleetSubAdd({ roomId: req.params.id, fleetId, fleetName: fleetName || fleet.name, ownerEmail: user.email });
    systemRow(store, req.params.id, `已订阅团队「${sub.fleetName}」——报数与关键动态将流入本空间（可在订阅区解除）。`, { fleetId, bridge: "subscribed" });
    res.status(201).json({ subscription: sub });
  });

  app.delete("/api/zhiyu/rooms/:id/fleet-subscriptions/:subId", (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    const removed = store.fleetSubRemove(req.params.id, req.params.subId);
    if (!removed) return res.status(404).json({ error: "not found" });
    systemRow(store, req.params.id, `已解除对团队「${removed.fleetName}」的订阅——流入停止，已流入的记录保留。`, { fleetId: removed.fleetId, bridge: "unsubscribed" });
    res.json({ ok: true });
  });

  // ── 一键召唤 (spec: batch-invite serving members + subscribe) ─────────────
  // Serves a PLAN first (what CAN be summoned vs what is persona-only), then
  // executes on confirm — the preview is what makes "如实呈现" honest.
  app.post("/api/zhiyu/rooms/:id/fleet-summon", express.json({ limit: "8kb" }), async (req, res) => {
    const user = requireMember(req, res);
    if (!user) return;
    const authz = authzFor(req.params.id, user.email);
    if (!authz.ok) return res.status(authz.status).json({ error: "not found" });
    const fleetId = String(req.body?.fleetId ?? "").trim();
    const overview = await sampleFleets(user.email);
    const fleet = (overview?.fleets ?? []).find((f) => f.id === fleetId);
    if (!fleet) return res.status(404).json({ error: "not found" });

    // Serving members come from the cell's serving face — the same source the
    // catalog reads; persona posts (no serving contract) are named honestly
    // as cockpit-only (spec: SHALL NOT 假装其在空间可对话).
    let serving = [];
    try {
      serving = (await sampleFleets(user.email, "/api/fleets/overview"))?.servingMembers?.(fleetId) ?? [];
    } catch { /* serving face absent → empty, honestly */ }
    const plan = {
      fleetId,
      fleetName: fleet.name,
      summonable: serving,
      cockpitOnly: (fleet.stream ?? []).map((s) => s.title),
    };
    if (req.body?.dryRun) return res.json({ plan });

    const results = [];
    for (const member of plan.summonable) {
      try {
        const inv = store.inviteCreate({
          id: randomUUID(),
          roomId: req.params.id,
          kind: "agent",
          ref: member.ref,
          display: member.title ?? member.ref,
          onBehalfOf: user.email,
          historyGrant: "join_from",
          invitedBy: user.email,
          state: "pending",
          createdAt: Date.now(),
        });
        results.push({ ref: member.ref, ok: true, inviteId: inv.id ?? inv.inviteId ?? null });
      } catch (err) {
        results.push({ ref: member.ref, ok: false, error: err.message });
      }
    }
    // Summon carries the subscription with it (spec: 召唤=邀请+订阅两层效果).
    if (!store.fleetSubsOf(req.params.id).some((s) => s.fleetId === fleetId)) {
      store.fleetSubAdd({ roomId: req.params.id, fleetId, fleetName: fleet.name, ownerEmail: user.email });
    }
    res.json({ plan, results });
  });

  // ── the pull tick: diff → rate-merge → append event rows ─────────────────
  let lastSample = null;
  let circuitOpen = false;
  let droppedWhileOpen = 0;
  const perWindow = new Map(); // subKey -> count in this window
  let windowStarted = 0;

  async function tick() {
    try {
      const subs = store.fleetSubsAll();
      if (subs.length === 0) {
        lastSample = null;
        return;
      }
      // One sample per OWNER (subscriptions are owner-scoped by construction).
      const byOwner = new Map();
      for (const sub of subs) {
        if (!byOwner.has(sub.ownerEmail)) byOwner.set(sub.ownerEmail, []);
        byOwner.get(sub.ownerEmail).push(sub);
      }
      const samples = new Map();
      for (const [ownerEmail] of byOwner) {
        samples.set(ownerEmail, await sampleFleets(ownerEmail));
      }
      // Diff per owner, then append only for subscriptions of that owner.
      for (const [ownerEmail, ownerSubs] of byOwner) {
        const next = samples.get(ownerEmail);
        const diff = diffOverview(lastSample, next);
        for (const sub of ownerSubs) {
          const items = [
            ...diff.reports.filter((r) => r.fleetId === sub.fleetId).map((r) => ({ kind: "report", ...r })),
            ...diff.decisions.filter((r) => r.fleetId === sub.fleetId).map((r) => ({ kind: "decision", ...r })),
            ...diff.health.filter((r) => r.fleetId === sub.fleetId).map((r) => ({ kind: "health", ...r })),
          ];
          if (items.length === 0) continue;
          if (circuitOpen) {
            droppedWhileOpen += items.length;
            continue;
          }
          // Dense-window merge (防洪同款): beyond MAX_PER_WINDOW in the
          // window, collapse into one count+sample line.
          const key = `${sub.roomId}|${sub.fleetId}`;
          if (Date.now() - windowStarted > RATE_WINDOW_MS) {
            windowStarted = Date.now();
            perWindow.clear();
          }
          const count = (perWindow.get(key) ?? 0) + items.length;
          if (count > MAX_PER_WINDOW) {
            const merged = perWindow.get(`${key}|merged`);
            if (!merged) {
              perWindow.set(`${key}|merged`, true);
              systemRow(store, sub.roomId, `「${sub.fleetName}」动态密集（近 1 小时 ${count} 条）——已合并呈现；最新：${items[items.length - 1].kind === "report" ? items[items.length - 1].summary || "(无摘要)" : items[items.length - 1].question || items[items.length - 1].to}`, { fleetId: sub.fleetId, bridge: "merged", count });
            }
            perWindow.set(key, count);
            continue;
          }
          perWindow.set(key, count);
          for (const item of items) {
            const drops = droppedWhileOpen > 0 ? `（此前熔断期丢弃 ${droppedWhileOpen} 条）` : "";
            if (droppedWhileOpen >= DROPS_NOTE_MIN) droppedWhileOpen = 0;
            if (item.kind === "report") {
              systemRow(store, sub.roomId, `「${sub.fleetName}」${item.memberTitle} 报数：${item.summary || "(无摘要)"}${drops}`, { fleetId: sub.fleetId, bridge: "report", at: item.at, deepLink: `${cockpitBase}/fleets/${sub.fleetId}` });
            } else if (item.kind === "decision") {
              systemRow(store, sub.roomId, `「${sub.fleetName}」等你拍板：${item.question}${item.memberTitle ? `（${item.memberTitle}）` : ""}｜严重度 ${item.severity}${drops}`, { fleetId: sub.fleetId, bridge: "decision", severity: item.severity, deepLink: `${cockpitBase}/fleets/${sub.fleetId}` });
            } else {
              systemRow(store, sub.roomId, `「${sub.fleetName}」健康状态${item.to === "abnormal" ? `异常（${item.abnormal} 岗）` : "恢复"}${drops}`, { fleetId: sub.fleetId, bridge: "health", to: item.to, deepLink: `${cockpitBase}/fleets/${sub.fleetId}` });
            }
          }
        }
        // Baseline for the next diff.
        lastSample = next;
      }
    } catch {
      // The bridge failing must only mute the bridge — rooms and fleets run on
      // (spec: 桥故障只哑桥). A failure streak opens the circuit; the next
      // successful line carries the dropped count.
      droppedWhileOpen += 1;
      if (droppedWhileOpen >= 3) circuitOpen = true;
      return;
    }
    circuitOpen = false;
  }

  return { tick, diffOverview };
}
