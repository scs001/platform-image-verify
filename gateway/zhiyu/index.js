// ── Zhiyu room kernel wiring (add-zhiyu-room) ────────────────────────────────
//
// 萬星·智语 phase 1: multi-human × multi-agent rooms, mounted on the gateway
// process because a room is a cross-user object and cells are per-user
// processes (design D-A). The module owns the whole /api/zhiyu prefix: every
// room route goes through resolveUser membership auth, and anything the
// prefix does not name answers 404 here instead of falling through to the
// cell proxy — room objects must not leak into (or out of) the 1:1 cell stack.
//
// Access model (design D-D): a room is visible to its owner, to active user
// members, and to the principal of an active facade member (the owner a
// facade rides for — they follow their own 值守分身). Everyone else gets the
// 404 same-as-nonexistent shape.

import path from "node:path";
import express from "express";
import { EventEmitter } from "node:events";
import { createZhiyuStore } from "./store.js";
import { createRoomRouter } from "./room-router.js";

export function registerZhiyuRoutes(app, {
  dataRoot,
  resolveUser,
  rejectUnauthenticated,
  env = process.env,
  // Injection seams for tests.
  store: storeOpt = null,
  cellExport = null, // (user, sessionId, window) → cell hatch export payload
  callAgent = null, // (member, { text, contextId, onDelta }) → { text } — the live agent lane
  settleTurn = null, // (member, { usageId, minutes }) → void — per-deployment billing (group 7)
  onHumanMessage = null, // round-router override hook (whole-sale test seam)
  notify = null, // notification lanes hook (task group 8)
  onRoomEnded = null, // minutes generation hook (task group 8)
  ssePollMs = 1000,
  sweepMs = 30_000,
  startTimers = true,
}) {
  const store = storeOpt ?? createZhiyuStore({ file: path.join(dataRoot, "zhiyu.db") });

  // Two-level reply-cap config (spec: 回合协议与熔断): deployment default from
  // env (shipped 3) with a deployment-wide bounds range (shipped 1–20).
  const replyCap = {
    default: clampInt(env.ZHIYU_REPLY_CAP_DEFAULT, 3, 1, 100),
    min: clampInt(env.ZHIYU_REPLY_CAP_MIN, 1, 1, 100),
    max: clampInt(env.ZHIYU_REPLY_CAP_MAX, 20, 1, 100),
  };
  const effectiveCap = (room) => room?.replyCap ?? replyCap.default;

  // The round router + ephemeral overlay bus (design D-B/D-E). Without a
  // wired agent lane, callAgent refuses loudly and turns settle as honest
  // `agent_failed` events — an unconfigured deployment still has fully
  // functional human-only rooms rather than a silent void.
  const bus = new EventEmitter();
  const missingLane = async () => {
    throw new Error("agent lane not configured on this deployment");
  };
  const router = createRoomRouter({ store, effectiveCap, callAgent: callAgent ?? missingLane, settleTurn, bus });
  const humanMessageHook = onHumanMessage ?? router.onHumanMessage;

  function clampInt(v, dflt, lo, hi) {
    const n = Number.parseInt(String(v ?? ""), 10);
    if (!Number.isInteger(n)) return dflt;
    return Math.min(Math.max(n, lo), hi);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Authorization: resolve the caller and their seat(s) in one pass. Returns
  // null (after answering 404) when the room must be invisible to them.
  function authorize(req, res, roomId) {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    const room = store.roomGet(roomId);
    if (!room) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    const members = store.membersOf(roomId);
    const email = user.email;
    const myUser = members.find((m) => m.kind === "user" && m.ref === email && m.state === "active");
    const myFacade = members.find((m) => m.kind === "facade" && m.onBehalfOf === email && m.state === "active");
    const isOwner = room.ownerEmail === email;
    if (!isOwner && !myUser && !myFacade) {
      res.status(404).json({ error: "not found" });
      return null;
    }
    return { user, room, members, myUser, myFacade, isOwner };
  }

  // Emit a system/event row into the room stream (seq-ordered like messages).
  function emit(roomId, kind, content, meta) {
    return store.messageAppend({ roomId, kind, content: content ?? "", meta });
  }

  // Take-over flip (spec: 代席回路): the principal's user seat goes active
  // and their on-duty facade steps back to listening. Idempotent — flipping
  // an already-over seat emits nothing.
  function applyTakeOver(auth) {
    let flipped = false;
    if (auth.myUser && auth.myUser.presence !== "active") {
      store.memberSetPresence(auth.myUser.id, "active");
      flipped = true;
    }
    const facade = auth.members.find(
      (m) => m.kind === "facade" && m.onBehalfOf === auth.user.email && m.state === "active" && m.presence === "on_duty",
    );
    if (facade) {
      store.memberSetPresence(facade.id, "listening");
      flipped = true;
    }
    if (flipped) {
      emit(auth.room.id, "system", "", { event: "take_over", by: auth.user.email, facade: facade?.id ?? null });
    }
    return flipped;
  }

  // Notification lanes (group 8): the in-app unread inbox is ALWAYS on
  // (store-backed, per-user); opts.notify is an optional ops-side mirror —
  // unset by default. A facade's collected to-dos travel the EXISTING
  // matters queue, which is precisely the channel for that event class.
  const notifyUser = (type, payload) => {
    if (payload?.to) {
      store.notificationAdd({ email: payload.to, type, roomId: payload.roomId ?? null, payload });
    }
    try {
      notify?.(type, payload);
    } catch (err) {
      console.warn(`[zhiyu] notify mirror failed (${type}): ${err.message}`);
    }
  };

  // Room minutes (8.2): a mechanical digest of the room's shared stream —
  // participants, counts, closing tail — delivered to every member and to
  // each facade's principal. An LLM-authored summary lane is an apply-time
  // open question and can upgrade this payload without touching delivery.
  const endedHook = (room, reason) => {
    try {
      const members = store.membersOf(room.id).filter((m) => m.state !== "removed");
      const shared = store
        .messagesAfter(room.id, 0, { viewerMemberId: null, limit: 10_000 })
        .filter((m) => m.visibility === "shared" && (m.kind === "human" || m.kind === "agent"));
      const recipients = new Set(
        members.flatMap((m) => (m.kind === "user" ? [m.ref] : m.onBehalfOf ? [m.onBehalfOf] : [])),
      );
      const tail = shared.slice(-6).map((m) => ({ kind: m.kind, content: String(m.content).slice(0, 280) }));
      for (const email of recipients) {
        notifyUser("minutes", {
          to: email,
          roomId: room.id,
          roomTitle: room.title,
          reason,
          participants: members.map((m) => m.display || m.ref),
          messageCount: shared.length,
          tail,
        });
      }
    } catch (err) {
      console.warn(`[zhiyu] minutes digest failed for ${room?.id}: ${err.message}`);
    }
    try {
      onRoomEnded?.(room, reason);
    } catch (err) {
      console.warn(`[zhiyu] onRoomEnded hook failed for ${room?.id}: ${err.message}`);
    }
  };

  // Hand-back: the principal steps away and their facade resumes duty.
  function applyHandBack(auth) {
    const facade = auth.members.find((m) => m.kind === "facade" && m.onBehalfOf === auth.user.email && m.state === "active");
    if (!facade) return false;
    if (auth.myUser && auth.myUser.presence !== "away") store.memberSetPresence(auth.myUser.id, "away");
    if (facade.presence !== "on_duty") store.memberSetPresence(facade.id, "on_duty");
    emit(auth.room.id, "system", "", { event: "hand_back", by: auth.user.email, facade: facade.id });
    return true;
  }

  // Accept an invite: land the seat row(s) and stream the join. Facades pull
  // their principal's user seat in too (presence away) — the owner follows
  // their own 分身 into the room, which is also what gives them the private
  // window keyed on their member id.
  function acceptSeats(invite) {
    const member = store.memberEnsure({
      roomId: invite.roomId,
      kind: invite.kind,
      ref: invite.ref,
      onBehalfOf: invite.onBehalfOf,
      display: invite.display,
      historyGrant: invite.historyGrant,
      invitedBy: invite.invitedBy,
    });
    if (member.state !== "active") store.memberSetState(member.id, "active");
    if (invite.kind === "facade") {
      store.memberEnsure({
        roomId: invite.roomId,
        kind: "user",
        ref: invite.onBehalfOf,
        display: invite.onBehalfOf,
        presence: "away",
        invitedBy: invite.invitedBy,
        historyGrant: invite.historyGrant,
      });
    }
    emit(invite.roomId, "system", "", { event: "member_joined", member: store.memberById(member.id) });
    return member;
  }

  // Liveness for the module itself — same public-by-design posture as
  // /healthz, carries no per-user information.
  app.get("/api/zhiyu/health", (_req, res) => {
    res.json({ ok: true, module: "zhiyu" });
  });

  // Deployment-visible config probe: cap bounds + deployment default.
  app.get("/api/zhiyu/config", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    res.json({ replyCap });
  });

  // ── Rooms: create / hatch / list / read / patch ────────────────────────────

  app.post("/api/zhiyu/rooms", express.json({ limit: "32kb" }), async (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const title = String(req.body?.title ?? "").trim().slice(0, 120);
    const idleMinutes = req.body?.idleMinutes === undefined ? 15 : clampInt(req.body.idleMinutes, 15, 1, 1440);
    const replyCapBody = req.body?.replyCap;
    let cap = null;
    if (replyCapBody !== undefined && replyCapBody !== null) {
      const n = Number(replyCapBody);
      if (!Number.isInteger(n) || n < replyCap.min || n > replyCap.max) {
        return res.status(400).json({ error: `replyCap must be an integer within ${replyCap.min}..${replyCap.max}` });
      }
      cap = n;
    }

    // Hatch (升为空间): the owner pulls a transcript window out of their own
    // cell session; the room seeds from it with provenance, the original
    // session is only ever read (design D-F).
    const hatch = req.body?.hatch;
    let seed = null;
    if (hatch && typeof hatch === "object" && hatch.sessionId) {
      if (!cellExport) return res.status(503).json({ error: "hatch lane not configured on this deployment" });
      const window = String(hatch.window ?? "").trim();
      if (!window) return res.status(400).json({ error: "hatch.window required: 'all' or 'last:<1..1000>'" });
      try {
        seed = await cellExport(user, String(hatch.sessionId), window);
      } catch (err) {
        const status = err?.status === 403 || err?.status === 404 ? err.status : 502;
        return res.status(status).json({ error: `could not export session: ${err.message}` });
      }
    }

    const budgetBody = req.body?.dailyBudgetTurns;
    let budget = null;
    if (budgetBody !== undefined && budgetBody !== null) {
      const b = Number(budgetBody);
      if (!Number.isInteger(b) || b < 1 || b > 100_000) {
        return res.status(400).json({ error: "dailyBudgetTurns must be an integer within 1..100000" });
      }
      budget = b;
    }
    const room = store.roomCreate({
      title: title || (seed?.title ? `${seed.title}` : ""),
      ownerEmail: user.email,
      idleMinutes,
      replyCap: cap,
      sourceSession: seed?.sessionId ?? null,
    });
    if (budget !== null) store.roomSetDailyBudget(room.id, budget);
    const ownerMember = store.memberAdd({
      roomId: room.id,
      kind: "user",
      ref: user.email,
      display: user.email,
      invitedBy: user.email,
    });
    if (seed) {
      for (const m of seed.messages ?? []) {
        store.messageAppend({
          roomId: room.id,
          kind: m.role === "assistant" ? "agent" : "human",
          fromAgent: m.role === "assistant" ? 1 : 0,
          content: m.content ?? "",
          provenance: `session:${seed.sessionId}`,
          meta: { event: "hatched_history", role: m.role, window: seed.window },
        });
      }
      emit(room.id, "system", "", { event: "room_hatched", sourceSession: seed.sessionId, window: seed.window, count: seed.messages?.length ?? 0 });
    } else {
      emit(room.id, "system", "", { event: "room_created", by: user.email });
    }
    res.json({ room: store.roomGet(room.id), members: store.membersOf(room.id), myMemberId: ownerMember.id, effectiveReplyCap: effectiveCap(store.roomGet(room.id)) });
  });

  app.get("/api/zhiyu/rooms", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const rooms = store.roomListFor(user.email).map((r) => ({ ...r, effectiveReplyCap: effectiveCap(r) }));
    res.json({ rooms });
  });

  app.get("/api/zhiyu/rooms/:id", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    res.json({
      room: { ...auth.room, effectiveReplyCap: effectiveCap(auth.room) },
      members: auth.members,
      myMemberId: auth.myUser?.id ?? null,
    });
  });

  app.patch("/api/zhiyu/rooms/:id", express.json({ limit: "16kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const patch = {};
    const events = [];
    if (req.body?.title !== undefined) {
      patch.title = String(req.body.title).trim().slice(0, 120);
      events.push({ event: "room_renamed", title: patch.title });
    }
    if (req.body?.replyCap !== undefined) {
      if (req.body.replyCap === null) {
        patch.replyCap = null;
        events.push({ event: "reply_cap_changed", replyCap: null, effective: replyCap.default });
      } else {
        const n = Number(req.body.replyCap);
        if (!Number.isInteger(n) || n < replyCap.min || n > replyCap.max) {
          return res.status(400).json({ error: `replyCap must be an integer within ${replyCap.min}..${replyCap.max}`, bounds: replyCap });
        }
        patch.replyCap = n;
        events.push({ event: "reply_cap_changed", replyCap: n, effective: n });
      }
    }
    if (req.body?.idleMinutes !== undefined) {
      const n = Number(req.body.idleMinutes);
      if (!Number.isInteger(n) || n < 1 || n > 1440) {
        return res.status(400).json({ error: "idleMinutes must be an integer within 1..1440" });
      }
      patch.idleMinutes = n;
    }
    if (req.body?.dailyBudgetTurns !== undefined) {
      if (req.body.dailyBudgetTurns === null) {
        store.roomSetDailyBudget(auth.room.id, null);
        events.push({ event: "budget_changed", dailyBudgetTurns: null });
      } else {
        const b = Number(req.body.dailyBudgetTurns);
        if (!Number.isInteger(b) || b < 1 || b > 100_000) {
          return res.status(400).json({ error: "dailyBudgetTurns must be an integer within 1..100000" });
        }
        store.roomSetDailyBudget(auth.room.id, b);
        events.push({ event: "budget_changed", dailyBudgetTurns: b });
      }
    }
    const room = store.roomPatch(auth.room.id, patch);
    for (const meta of events) emit(auth.room.id, "system", "", meta);
    res.json({ room: { ...room, effectiveReplyCap: effectiveCap(room) } });
  });

  // ── Invites ───────────────────────────────────────────────────────────────

  // Mine: the invites I can act on (as invited user or as a facade/agent
  // seat's principal).
  app.get("/api/zhiyu/invites", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const invites = store.invitesPendingForPrincipal(user.email).map((v) => ({
      ...v,
      room: store.roomGet(v.roomId) ? { id: v.roomId, title: store.roomGet(v.roomId).title } : null,
    }));
    res.json({ invites });
  });

  app.post("/api/zhiyu/rooms/:id/invites", express.json({ limit: "16kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    // Any active member may invite (the授权 default); removal stays owner-only.
    if (!auth.myUser && !auth.isOwner) return res.status(403).json({ error: "active member required" });

    const kind = String(req.body?.kind ?? "");
    if (!["user", "facade", "agent"].includes(kind)) return res.status(400).json({ error: "kind must be user|facade|agent" });
    // Case rules: user refs are emails (canonical lowercase); facade/agent
    // refs are deployment ids `${packId}:${agentId}` and are CASE-SENSITIVE —
    // deployment bookkeeping matches by exact packId (learned the hard way on
    // the first live dispatch: lowercasing broke resolution for mixed-case
    // pack ids).
    const ref = kind === "user" ? String(req.body?.ref ?? "").trim().toLowerCase() : String(req.body?.ref ?? "").trim();
    if (!ref) return res.status(400).json({ error: "ref required" });
    const onBehalfOf = req.body?.onBehalfOf ? String(req.body.onBehalfOf).trim().toLowerCase() : null;
    if (kind === "facade" && !onBehalfOf) return res.status(400).json({ error: "facade invites require onBehalfOf (the principal)" });
    if (!/^[A-Za-z0-9._:@/-]+$/.test(ref)) return res.status(400).json({ error: "ref has invalid characters" });
    const historyGrant = req.body?.historyGrant === "full" ? "full" : "join_from";
    const display = String(req.body?.display ?? ref).slice(0, 120);

    // Already seated?
    const seated = store.memberFor(auth.room.id, kind, ref);
    if (seated && seated.state === "active") return res.status(409).json({ error: "already a member", member: seated });

    // A facade's invitation answers by its principal's policy (spec: 在席成员
    // 与邀请握手): auto_accept lands immediately, ask stays pending, decline
    // resolves declined at once.
    let policy = null;
    if (kind === "facade") {
      policy = store.ownerPolicyGet(onBehalfOf).facadeInvite ?? "ask";
    }
    const idemBase = `${auth.room.id}:${kind}:${ref}`;
    let idemKey = typeof req.body?.idemKey === "string" && req.body.idemKey.trim() ? req.body.idemKey.trim() : idemBase;
    if (store.invitesForRoom(auth.room.id).some((v) => v.idemKey === idemKey)) idemKey = `${idemBase}:${Date.now().toString(36)}`;
    const { invite, replay } = store.inviteCreate({
      roomId: auth.room.id,
      kind,
      ref,
      onBehalfOf,
      display,
      historyGrant,
      invitedBy: auth.user.email,
      idemKey,
    });

    if (!replay && invite.state === "pending") {
      if (policy === "auto_accept") {
        acceptSeats(invite);
        store.inviteResolve(invite.id, "accepted");
        return res.json({ invite: store.inviteGet(invite.id), members: store.membersOf(auth.room.id), policy });
      }
      if (policy === "decline") {
        store.inviteResolve(invite.id, "declined");
        emit(auth.room.id, "event", "", { event: "invite_auto_declined", kind, ref, by: "owner_policy" });
        return res.json({ invite: store.inviteGet(invite.id), members: store.membersOf(auth.room.id), policy });
      }
      emit(auth.room.id, "system", "", { event: "invite_sent", kind, ref, display, by: auth.user.email });
      notifyUser("invite", { to: onBehalfOf ?? ref, roomId: auth.room.id, roomTitle: auth.room.title, kind, display, invitedBy: auth.user.email });
    }
    res.json({ invite, members: store.membersOf(auth.room.id), policy });
  });

  const resolveInviteAction = (verdict) => (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const invite = store.inviteGet(req.params.inviteId);
    if (!invite || invite.state !== "pending") return res.status(404).json({ error: "not found" });
    const mine =
      (invite.kind === "user" && invite.ref === user.email) ||
      ((invite.kind === "facade" || invite.kind === "agent") && invite.onBehalfOf === user.email);
    if (!mine) return res.status(404).json({ error: "not found" });
    if (verdict === "accepted") {
      const member = acceptSeats(invite);
      store.inviteResolve(invite.id, "accepted");
      emit(invite.roomId, "system", "", { event: "invite_accepted", kind: invite.kind, ref: invite.ref });
      return res.json({ invite: store.inviteGet(invite.id), member });
    }
    store.inviteResolve(invite.id, "declined");
    emit(invite.roomId, "event", "", { event: "invite_declined", kind: invite.kind, ref: invite.ref, by: user.email });
    res.json({ invite: store.inviteGet(invite.id) });
  };
  app.post("/api/zhiyu/invites/:inviteId/accept", resolveInviteAction("accepted"));
  app.post("/api/zhiyu/invites/:inviteId/decline", resolveInviteAction("declined"));

  // Per-owner facade invitation policy (auto_accept | ask | decline).
  app.put("/api/zhiyu/policies/facade", express.json({ limit: "8kb" }), (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const policy = String(req.body?.facadeInvite ?? "");
    if (!["auto_accept", "ask", "decline"].includes(policy)) {
      return res.status(400).json({ error: "facadeInvite must be auto_accept|ask|decline" });
    }
    res.json({ policies: store.ownerPolicySet(user.email, { facadeInvite: policy }) });
  });
  app.get("/api/zhiyu/policies", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    res.json({ policies: { facadeInvite: "ask", ...store.ownerPolicyGet(user.email) } });
  });

  // ── Members: leave / remove / owner transfer cascade ───────────────────────

  app.post("/api/zhiyu/rooms/:id/leave", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const roomId = auth.room.id;
    // Leaving takes the caller's user seat AND any facade seat they own out
    // of the room — the room must never keep a 分身 whose principal walked.
    const seats = auth.members.filter(
      (m) => m.state === "active" && ((m.kind === "user" && m.ref === auth.user.email) || (m.kind === "facade" && m.onBehalfOf === auth.user.email)),
    );
    for (const s of seats) {
      store.memberSetState(s.id, "left");
      emit(roomId, "system", "", { event: "member_left", member: { id: s.id, kind: s.kind, display: s.display } });
    }
    let room = store.roomGet(roomId);
    if (auth.isOwner && room.status === "active") {
      const heirs = store.membersOf(roomId).filter((m) => m.kind === "user" && m.state === "active");
      if (heirs.length) {
        room = store.roomTransferOwner(roomId, heirs[0].ref);
        emit(roomId, "system", "", { event: "owner_transferred", to: heirs[0].ref });
      } else {
        room = store.roomSetStatus(roomId, "ended");
        emit(roomId, "system", "", { event: "room_ended", reason: "owner_left" });
        void endedHook(store.roomGet(roomId), "owner_left");
      }
    }
    res.json({ ok: true, room });
  });

  app.post("/api/zhiyu/rooms/:id/remove", express.json({ limit: "8kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const target = store.memberById(String(req.body?.memberId ?? ""));
    if (!target || target.roomId !== auth.room.id) return res.status(404).json({ error: "member not found" });
    store.memberSetState(target.id, "removed");
    emit(auth.room.id, "system", "", { event: "member_removed", member: { id: target.id, kind: target.kind, display: target.display }, by: auth.user.email });
    res.json({ ok: true, members: store.membersOf(auth.room.id) });
  });

  app.post("/api/zhiyu/rooms/:id/end", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!auth.isOwner) return res.status(403).json({ error: "room owner required" });
    const room = store.roomSetStatus(auth.room.id, "ended");
    emit(auth.room.id, "system", "", { event: "room_ended", reason: "owner_ended", by: auth.user.email });
    void endedHook(room, "owner_ended");
    res.json({ room });
  });

  // ── Notifications inbox (站内未读 lane) ────────────────────────────────────

  app.get("/api/zhiyu/notifications", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    res.json({
      notifications: store.notificationsFor(user.email, { unreadOnly }),
      unread: store.notificationUnreadCount(user.email),
    });
  });

  app.post("/api/zhiyu/notifications/:nid/read", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    store.notificationMarkRead(user.email, req.params.nid);
    res.json({ ok: true, unread: store.notificationUnreadCount(user.email) });
  });

  // ── Duty circuit: take-over / hand-back / call ─────────────────────────────

  app.post("/api/zhiyu/rooms/:id/takeover", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const flipped = applyTakeOver(auth);
    res.json({ ok: true, flipped, members: store.membersOf(auth.room.id) });
  });

  app.post("/api/zhiyu/rooms/:id/handback", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (!applyHandBack(auth)) return res.status(409).json({ error: "no facade of yours in this room to hand back to" });
    res.json({ ok: true, members: store.membersOf(auth.room.id) });
  });

  // 呼叫: summon a member's principal back. Streams needs_you, fires the
  // notification hook, and — when the principal's facade is on duty — has the
  // 分身 itself say in-room that its human was called (spec: 呼叫本人).
  app.post("/api/zhiyu/rooms/:id/call", express.json({ limit: "8kb" }), async (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    const target = String(req.body?.target ?? "").trim().toLowerCase();
    if (!target || !/^[^@\s]+@[^@\s]+$/.test(target)) return res.status(400).json({ error: "target email required" });
    const targetUser = auth.members.find((m) => m.kind === "user" && m.ref === target && m.state === "active");
    const targetFacade = auth.members.find((m) => m.kind === "facade" && m.onBehalfOf === target && m.state === "active");
    if (!targetUser && !targetFacade) return res.status(404).json({ error: "target is not a member of this room" });
    emit(auth.room.id, "system", "", { event: "needs_you", to: target, from: auth.user.email });
    notifyUser("call", { to: target, roomId: auth.room.id, roomTitle: auth.room.title, from: auth.user.email });
    if (targetFacade?.presence === "on_duty") {
      void Promise.resolve(
        router.directiveTurn({
          room: auth.room,
          targetRef: targetFacade.ref,
          directive: `请只用一句话向空间说明：你已呼叫你的主人 ${target}，正等他/她本人回来看这句话。称谓用「我主人」。`,
        }),
      ).catch((err) => console.error(`[zhiyu] call directive failed for ${auth.room.id}:`, err.message));
    }
    res.json({ ok: true });
  });

  // ── Messages & live stream ─────────────────────────────────────────────────

  app.post("/api/zhiyu/rooms/:id/messages", express.json({ limit: "32kb" }), (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    if (auth.room.status !== "active") return res.status(409).json({ error: "room ended" });
    // Posting needs an active USER seat — a purely facade-riding principal
    // has one by construction (acceptSeats creates it), so the gate here is
    // membership itself, and SPEAKING is itself take-over: presence flips to
    // active and an on-duty facade of theirs steps back to listening
    // (group 6's explicit take-over button rides the same flip).
    if (!auth.myUser) return res.status(403).json({ error: "active user seat required" });
    const content = String(req.body?.content ?? "").trim();
    if (!content) return res.status(400).json({ error: "content required" });
    if (content.length > 16_000) return res.status(400).json({ error: "content too long" });
    const replyToSeq = Number.isInteger(req.body?.replyToSeq) ? req.body.replyToSeq : null;
    // Speaking is implicit take-over; the explicit button below rides the
    // same flip without a message.
    applyTakeOver(auth);
    const { row } = store.messageAppend({
      roomId: auth.room.id,
      kind: "human",
      senderMemberId: auth.myUser.id,
      content,
      replyToSeq,
    });
    // The round router rides this seam; fire-and-forget with a loud failure
    // so a router bug never eats the human's message silently.
    void Promise.resolve(humanMessageHook({ room: auth.room, member: auth.myUser, message: row })).catch((err) => {
      console.error(`[zhiyu] round router failed for ${auth.room.id}:`, err);
    });
    res.json({ message: row });
  });

  app.get("/api/zhiyu/rooms/:id/messages", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const after = Number(req.query.after ?? 0) || 0;
    const messages = store.messagesAfter(auth.room.id, after, { viewerMemberId: auth.myUser?.id ?? null, limit: 1000 });
    res.json({ messages });
  });

  // SSE live stream (design D-E): seq-monotonic replay makes reconnect =
  // reread from `after` (or Last-Event-ID); no in-memory buffer to expire.
  app.get("/api/zhiyu/rooms/:id/events", (req, res) => {
    const auth = authorize(req, res, req.params.id);
    if (!auth) return;
    const roomId = auth.room.id;
    let last = Number(req.query.after ?? req.headers["last-event-id"] ?? 0) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    res.write(`retry: 1000\n\n`);
    const pump = () => {
      try {
        const rows = store.messagesAfter(roomId, last, { viewerMemberId: auth.myUser?.id ?? null });
        for (const m of rows) {
          last = m.seq;
          res.write(`id: ${m.seq}\ndata: ${JSON.stringify(m)}\n\n`);
        }
      } catch (err) {
        console.error(`[zhiyu] SSE pump failed for ${roomId}:`, err.message);
      }
    };
    pump();
    const poll = setInterval(pump, ssePollMs);
    const keepalive = setInterval(() => res.write(`:ka\n\n`), 25_000);
    // Ephemeral overlay (live deltas / agent lifecycle): seq-less, never
    // persisted; private-window rows filtered per viewer like the DB pump.
    const onOverlay = (ev) => {
      try {
        if (ev.visibility && ev.visibility !== "shared" && ev.visibility !== `private:${auth.myUser?.id ?? ""}`) return;
        res.write(`event: overlay\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch { /* client gone */ }
    };
    bus.on(roomId, onOverlay);
    req.on("close", () => {
      clearInterval(poll);
      clearInterval(keepalive);
      bus.off(roomId, onOverlay);
    });
  });

  // ── Idle auto-close sweep ─────────────────────────────────────────────────

  const sweep = () => {
    try {
      for (const room of store.roomsIdleExpired(Date.now())) {
        store.roomSetStatus(room.id, "ended");
        emit(room.id, "system", "", { event: "room_ended", reason: "idle" });
        void endedHook(store.roomGet(room.id), "idle");
        console.log(`[zhiyu] room ${room.id} auto-closed (idle)`);
      }
    } catch (err) {
      console.error("[zhiyu] idle sweep failed:", err.message);
    }
  };
  const sweepTimer = startTimers ? setInterval(sweep, sweepMs) : null;
  sweepTimer?.unref?.();

  // The prefix is owned: unmatched /api/zhiyu/* paths must 404 here (JSON),
  // never proxy into a cell where a same-named route could answer with a
  // different meaning.
  app.all(/^\/api\/zhiyu(\/.*)?$/, (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return {
    store,
    replyCap,
    effectiveCap,
    router,
    bus,
    sweep,
    close() {
      if (sweepTimer) clearInterval(sweepTimer);
      bus.removeAllListeners();
      if (!storeOpt) store.close();
    },
  };
}
