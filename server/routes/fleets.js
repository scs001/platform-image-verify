// Fleet management routes (agent-fleet-core).
//
// Fleet = organization, Member = stable post (ADR-0031). Every write path
// ends in a synchronous reconcile (server/fleet-reconcile.js) so the
// materialized task-engine jobs always match the fleet's declared state —
// there is no background syncer to race. Auth/identity semantics mirror
// clusters.js: auth-on reads the forward-auth user, auth-off the machine
// owner; writes are owner-scoped by fleet.ownerEmail.

import { Router } from "express";
import * as cron from "../../cron.js";
import * as catalog from "../../catalog.js";
import * as chatHistory from "../../chat-history.js";
import { rosterPresetId } from "../../dsh-profile.js";
import { getClusterDatabase } from "./clusters-db.js";
import {
  getFleetDatabase,
  FLEET_STATES,
  MEMBER_TARGET_KINDS,
} from "./fleets-db.js";
import { reconcileFleet, deriveMemberStatus, cronPeriodMs } from "../fleet-reconcile.js";
import {
  validateReportPayload,
  resolveAttribution,
  floodWindowMs,
  checkFlood,
  buildLatestView,
} from "../fleet-reports.js";

const DENSE_CADENCE_MS = 10 * 60 * 1000; // design D7: <10min cadence needs confirmation
const KPI_SLOT_LIMIT = 8;

function resolveUserFactory(ctx) {
  return (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
}

function fleetId(id) {
  return `fleet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function memberId(id) {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Target resolution ────────────────────────────────────────────────────────
//
// The single authority for "does this targetRef point at a live object".
// Creation-time validation and read-time vacancy derivation share it, so a
// post can never be BUILT dangling — 待补岗 only ever comes from the target
// being deleted afterwards (design: 对象模型).

function resolveTarget(member) {
  if (member.targetKind === "persona") {
    const entry = catalog.getChatAgentEntries().find((e) => e.id === member.targetId) || null;
    return { alive: !!entry, label: entry?.name ?? member.targetId, clusterName: null };
  }
  if (member.targetKind === "cluster") {
    const cluster = getClusterDatabase().get(member.targetId);
    const alive = !!cluster && cluster.status !== "terminated";
    return { alive, label: cluster?.name ?? member.targetId, clusterName: cluster?.name ?? null };
  }
  const entry = catalog.getAgentEntry(member.targetId);
  const alive = !!entry && entry.mode === "a2a";
  return { alive, label: entry?.name ?? member.targetId, clusterName: null };
}

// Shared with the server.js catalog-change hook (reconcileAllFleets) so the
// "vacant post stops firing" pass resolves targets exactly like the routes.
export const resolveFleetTarget = resolveTarget;

function invalidTargetMessage(kind, id) {
  if (!MEMBER_TARGET_KINDS.includes(kind)) {
    return `targetKind must be one of ${MEMBER_TARGET_KINDS.join(", ")}`;
  }
  if (kind === "persona") return `persona '${id}' is not in the catalog chat roster`;
  if (kind === "cluster") return `cluster '${id}' does not exist`;
  return `market agent '${id}' is not an online a2a entry`;
}

// ── Cadence & KPI validation ────────────────────────────────────────────────

function normalizeCadence(cadence, { confirmed } = {}) {
  if (cadence === undefined || cadence === null) return { ok: true, cadence: null };
  if (typeof cadence !== "object" || Array.isArray(cadence)) {
    return { ok: false, error: "cadence must be an object or null" };
  }
  const { cron: expr, tz, promptTemplate, enabled } = cadence;
  if (!expr || typeof expr !== "string") {
    return { ok: false, error: "cadence.cron is required" };
  }
  const invalid = cron.validateCron(expr, tz || null);
  if (invalid) return { ok: false, error: invalid };
  if (!promptTemplate || typeof promptTemplate !== "string") {
    return { ok: false, error: "cadence.promptTemplate is required when a cadence is set" };
  }
  if (tz !== undefined && tz !== null && typeof tz !== "string") {
    return { ok: false, error: "cadence.tz must be an IANA timezone string or null" };
  }
  // Dense-cadence guard (design D7): interval under 10 minutes requires an
  // explicit confirmation flag — the UI shows the cost warning first.
  const period = cronPeriodMs(expr, tz || null);
  if (period != null && period < DENSE_CADENCE_MS && confirmed !== true) {
    return { ok: false, error: "cadence fires more often than every 10 minutes — confirm the cost to proceed", code: "cadence_confirmation_required", periodMs: period };
  }
  return {
    ok: true,
    cadence: { cron: expr, tz: tz || null, promptTemplate, enabled: enabled !== false },
  };
}

function normalizeKpiSlots(slots) {
  if (slots === undefined || slots === null) return { ok: true, kpiSlots: [] };
  if (!Array.isArray(slots)) return { ok: false, error: "kpiSlots must be an array" };
  if (slots.length > KPI_SLOT_LIMIT) {
    return { ok: false, error: `kpiSlots is capped at ${KPI_SLOT_LIMIT}` };
  }
  for (const s of slots) {
    if (!s || typeof s !== "object" || typeof s.key !== "string" || !s.key.trim() || typeof s.label !== "string" || !s.label.trim()) {
      return { ok: false, error: "each kpiSlot needs a key and a label" };
    }
  }
  return { ok: true, kpiSlots: slots };
}

// Cycle guard: reject a parent edge that would loop (A under its descendant).
function wouldCycle(db, member, newParentId) {
  if (!newParentId) return false;
  let cursor = newParentId;
  const seen = new Set();
  while (cursor) {
    if (cursor === member.id) return true;
    if (seen.has(cursor)) return true; // defensive: existing corruption must not spin
    seen.add(cursor);
    const node = db.getMember(cursor);
    cursor = node?.parentId ?? null;
  }
  return false;
}

// ── Derived read faces ───────────────────────────────────────────────────────

function taskIndexFor(fleetId) {
  const map = new Map();
  for (const job of cron.listJobs()) {
    if (job?.sourceTag?.fleetId === fleetId) map.set(job.sourceTag.memberId, job);
  }
  return map;
}

function memberView(db, fleet, member, tasks, { now = Date.now(), resolver = resolveTarget } = {}) {
  const target = resolver(member);
  const task = tasks.get(member.id) ?? null;
  // Report lane: latest with system trends (dual-window missing reads its
  // timestamp too); timeline preview is the first page — the drawer pages.
  const latest = db.latestReportFor(member.id);
  const previous = latest ? db.previousReport(member.id, latest.createdAt) : null;
  const derived = deriveMemberStatus({ member, fleet, task, targetAlive: target.alive, latestReport: latest, now });
  return {
    id: member.id,
    fleetId: member.fleetId,
    title: member.title,
    parentId: member.parentId,
    target: { kind: member.targetKind, id: member.targetId, label: target.label },
    kpiSlots: member.kpiSlots,
    cadence: member.cadence,
    sortKey: member.sortKey,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    taskId: task?.id ?? null,
    status: derived.status,
    statusReason: derived.reason,
    evidence: derived.evidence,
    latestReport: buildLatestView({ report: latest, previous, kpiSlots: member.kpiSlots }),
    reportTimeline: db.listReports(member.id, { limit: 5 }).map(reportTimelineEntry),
  };
}

// One timeline row (drawer): value snapshot, blockers, the source-session
// jump link, and the self/derived provenance badge.
function reportTimelineEntry(report) {
  return {
    id: report.id,
    at: report.createdAt,
    summary: report.summary,
    metrics: report.metrics,
    blockers: report.blockers,
    resources: report.resources,
    source: report.source,
    sessionId: report.sessionId ?? null,
  };
}

// ── Route registration ───────────────────────────────────────────────────────

export function createFleetRoutes(app, ctx = null) {
  const resolveUser = resolveUserFactory(ctx);
  // Tests inject a fake universe through ctx; production always resolves
  // against the live catalog/clusters store.
  const targetResolver = ctx?.fleetTargetResolver ?? resolveTarget;
  const router = Router();

  const requireOwnedFleet = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    const fleet = getFleetDatabase().getFleet(req.params.id);
    if (!fleet) {
      res.status(404).json({ error: "Fleet not found" });
      return null;
    }
    if (fleet.ownerEmail !== user.email) {
      res.status(403).json({ error: "Not your fleet" });
      return null;
    }
    return { user, fleet };
  };

  const runReconcile = async (fleetId) => {
    try {
      return await reconcileFleet({
        fleetId,
        db: getFleetDatabase(),
        cronApi: cron,
        resolveTarget: targetResolver,
        rosterPresetId,
      });
    } catch (err) {
      console.error(`[fleets] reconcile failed for ${fleetId}:`, err.message);
      return { error: err.message };
    }
  };

  // ── Report lane (agent-fleet-report-lane) ─────────────────────────────────
  //
  // The report_status bridge. Attribution is SERVER-side (D3): the caller
  // never names a post — a running fleet cluster task attributes to its own
  // post (the fan-out rotates presets, which would otherwise misattribute),
  // else the live preset resolves the unique persona post holding it. The
  // in-cell fleet MCP child reaches this over loopback; a non-loopback caller
  // still passes the full auth gate and gets the same server-side attribution.
  router.post("/report", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const payload = validateReportPayload(req.body);
      if (!payload.ok) return res.status(400).json({ error: payload.error });

      const personaMembers = [];
      for (const f of db.listFleets()) {
        for (const m of db.listMembers(f.id)) {
          if (m.targetKind === "persona") personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        personaMembers,
        rosterPresetId,
      });
      if (attribution.kind === "none" || attribution.kind === "ambiguous") {
        return res.status(409).json({ error: attribution.error });
      }
      const member = db.getMember(attribution.memberId);
      if (!member) return res.status(409).json({ error: "the attributed post no longer exists" });

      // Flood control (design D7): window = half the cadence period with a
      // 10-minute floor; at most 3 self reports per window. Derived (a2a)
      // rows never pass through this door, so they never count.
      const windowMs = floodWindowMs(member.cadence, cronPeriodMs);
      const now = Date.now();
      const since = now - windowMs;
      const recent = db.listReports(member.id, { limit: 3 });
      const inWindow = recent.filter((r) => r.createdAt > since && r.source === "self");
      const flood = checkFlood({
        countSince: inWindow.length,
        windowMs,
        now,
        oldestInWindowAt: inWindow.length ? inWindow[inWindow.length - 1].createdAt : null,
      });
      if (!flood.ok) {
        return res.status(429).json({ error: flood.error, windowResetsAt: flood.windowResetsAt });
      }

      // Source session: the running task's bound session when the report
      // rides a fleet fire, else the live conversation pointer.
      const sessionId =
        attribution.task?.sessionId ?? chatHistory.currentSessionId?.() ?? null;

      const declared = new Set(member.kpiSlots.map((s) => s.key));
      const submitted = Object.keys(payload.report.metrics);
      const report = db.appendReport({
        id: `r_${now}_${Math.random().toString(36).slice(2, 8)}`,
        fleetId: member.fleetId,
        memberId: member.id,
        sessionId,
        metrics: payload.report.metrics,
        resources: payload.report.resources,
        blockers: payload.report.blockers,
        summary: payload.report.summary,
        source: "self",
        createdAt: now,
      });
      res.status(201).json({
        ok: true,
        memberTitle: member.title,
        fleetName: db.getFleet(member.fleetId)?.name ?? member.fleetId,
        reportId: report.id,
        slotsAccepted: submitted.filter((k) => declared.has(k)),
        slotsUnrecognized: submitted.filter((k) => !declared.has(k)),
        windowResetsAt: now + windowMs,
      });
    } catch (err) {
      console.error("[fleets] report error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Report timeline page for the detail drawer (owner-gated like the fleet).
  router.get("/:id/members/:mid/reports", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      const beforeMs = req.query.before ? Number(req.query.before) : null;
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const rows = db.listReports(member.id, {
        ...(Number.isFinite(beforeMs) ? { beforeMs } : {}),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit).map(reportTimelineEntry);
      res.json({
        reports: page,
        nextBefore: rows.length > limit ? page[page.length - 1].at : null,
      });
    } catch (err) {
      console.error("[fleets] reports timeline error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Fleet CRUD ────────────────────────────────────────────────────────────

  router.get("/", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const fleets = db
        .listFleets({ ownerEmail: user.email })
        .map((fleet) => {
          const members = db.listMembers(fleet.id);
          const tasks = taskIndexFor(fleet.id);
          const counts = {};
          for (const m of members) {
            const view = memberView(db, fleet, m, tasks, { resolver: targetResolver });
            counts[view.status] = (counts[view.status] ?? 0) + 1;
          }
          return {
            id: fleet.id,
            name: fleet.name,
            state: fleet.state,
            memberCount: members.length,
            statusCounts: counts,
            createdAt: fleet.createdAt,
            updatedAt: fleet.updatedAt,
          };
        });
      res.json({ fleets });
    } catch (err) {
      console.error("[fleets] list error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const name = req.body?.name;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Fleet name is required" });
      }
      const fleet = getFleetDatabase().createFleet({
        id: fleetId(),
        name: name.trim().slice(0, 120),
        ownerEmail: user.email,
      });
      res.status(201).json({ fleet });
    } catch (err) {
      console.error("[fleets] create error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/:id", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const members = db.listMembers(owned.fleet.id);
      const tasks = taskIndexFor(owned.fleet.id);
      const views = members.map((m) => memberView(db, owned.fleet, m, tasks, { resolver: targetResolver }));
      const statusCounts = {};
      for (const v of views) statusCounts[v.status] = (statusCounts[v.status] ?? 0) + 1;
      res.json({ fleet: owned.fleet, members: views, statusCounts });
    } catch (err) {
      console.error("[fleets] detail error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      const { name, state } = req.body ?? {};
      const updates = {};

      if (name !== undefined) {
        if (!name || typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ error: "Fleet name must be a non-empty string" });
        }
        updates.name = name.trim().slice(0, 120);
      }
      if (state !== undefined) {
        if (!FLEET_STATES.includes(state)) {
          return res.status(400).json({ error: `state must be one of ${FLEET_STATES.join(", ")}` });
        }
        if (fleet.state === "archived") {
          return res.status(409).json({ error: "This fleet is archived — archived is terminal" });
        }
        updates.state = state;
      }

      const updated = getFleetDatabase().updateFleet(fleet.id, updates);
      const reconcile = await runReconcile(fleet.id);
      res.json({ fleet: updated, reconcile });
    } catch (err) {
      console.error("[fleets] patch error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Dissolve: archive + delete the materialized tasks, keep every history row.
  router.delete("/:id", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      for (const job of cron.listJobs()) {
        if (job?.sourceTag?.fleetId === fleet.id) {
          await cron.removeJob(job.id);
        }
      }
      const updated = getFleetDatabase().updateFleet(fleet.id, { state: "archived" });
      res.json({ fleet: updated, dissolved: true });
    } catch (err) {
      console.error("[fleets] delete error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Members ────────────────────────────────────────────────────────────────

  router.post("/:id/members", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — members can no longer be added" });
      }
      const db = getFleetDatabase();

      const title = req.body?.title;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Member title is required" });
      }
      const targetKind = req.body?.targetKind;
      const targetId = req.body?.targetId;
      if (!targetId || typeof targetId !== "string") {
        return res.status(400).json({ error: "targetId is required" });
      }
      if (!MEMBER_TARGET_KINDS.includes(targetKind)) {
        return res.status(400).json({ error: `targetKind must be one of ${MEMBER_TARGET_KINDS.join(", ")}` });
      }
      if (!targetResolver({ targetKind, targetId }).alive) {
        return res.status(400).json({ error: invalidTargetMessage(targetKind, targetId) });
      }
      // Unique post (design D8): persona/cluster globally hold one post; a2a
      // is exempt (external execution has no attribution ambiguity).
      if (targetKind !== "a2a") {
        const existing = db.findPostByTarget(targetKind, targetId);
        if (existing) {
          return res.status(409).json({
            error: `already on duty: post '${existing.member.title}' in fleet '${existing.fleet?.name ?? existing.member.fleetId}'`,
            existing: { fleetId: existing.member.fleetId, memberId: existing.member.id, title: existing.member.title },
          });
        }
      }
      const cad = normalizeCadence(req.body?.cadence, { confirmed: req.body?.confirmed });
      if (!cad.ok) {
        return res.status(cad.code ? 400 : 400).json({ error: cad.error, ...(cad.code ? { code: cad.code } : {}) });
      }
      const kpi = normalizeKpiSlots(req.body?.kpiSlots);
      if (!kpi.ok) return res.status(400).json({ error: kpi.error });

      const parentId = req.body?.parentId ?? null;
      if (parentId) {
        const parent = db.getMember(parentId);
        if (!parent || parent.fleetId !== fleet.id) {
          return res.status(400).json({ error: "parentId must reference a member of the same fleet" });
        }
      }

      const member = db.createMember({
        id: memberId(),
        fleetId: fleet.id,
        title: title.trim().slice(0, 120),
        parentId,
        targetKind,
        targetId,
        kpiSlots: kpi.kpiSlots,
        cadence: cad.cadence,
      });
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      res.status(201).json({ member: memberView(db, fleet, member, tasks, { resolver: targetResolver }), reconcile });
    } catch (err) {
      console.error("[fleets] member create error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.patch("/:id/members/:mid", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }

      const updates = {};
      const { title, parentId, cadence, kpiSlots } = req.body ?? {};

      if (title !== undefined) {
        if (!title || typeof title !== "string" || !title.trim()) {
          return res.status(400).json({ error: "Member title must be a non-empty string" });
        }
        updates.title = title.trim().slice(0, 120);
      }
      if (kpiSlots !== undefined) {
        const kpi = normalizeKpiSlots(kpiSlots);
        if (!kpi.ok) return res.status(400).json({ error: kpi.error });
        updates.kpiSlots = kpi.kpiSlots;
      }
      if (parentId !== undefined) {
        if (parentId !== null) {
          if (typeof parentId !== "string") {
            return res.status(400).json({ error: "parentId must be a member id or null" });
          }
          const parent = db.getMember(parentId);
          if (!parent || parent.fleetId !== fleet.id) {
            return res.status(400).json({ error: "parentId must reference a member of the same fleet" });
          }
          if (parentId === member.id || wouldCycle(db, member, parentId)) {
            return res.status(400).json({ error: "parent must not form a cycle in the org tree" });
          }
        }
        updates.parentId = parentId;
      }
      if (cadence !== undefined) {
        if (fleet.state === "archived") {
          return res.status(409).json({ error: "This fleet is archived — cadence edits are closed" });
        }
        const cad = normalizeCadence(cadence, { confirmed: req.body?.confirmed });
        if (!cad.ok) {
          return res.status(400).json({ error: cad.error, ...(cad.code ? { code: cad.code } : {}) });
        }
        updates.cadence = cad.cadence;
      }

      const updated = db.updateMember(member.id, updates);
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      res.json({ member: memberView(db, fleet, updated, tasks, { resolver: targetResolver }), reconcile });
    } catch (err) {
      console.error("[fleets] member patch error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Restaff (换防, ADR-0031): swap the incumbent targetRef in place — the
  // post identity, tree position, KPI slots, and report history are untouched.
  // Default keeps the dedicated session's conversation; freshSession clears
  // it for a clean handover.
  router.post("/:id/members/:mid/swap", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — restaffing is closed" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      const targetKind = req.body?.targetKind;
      const targetId = req.body?.targetId;
      if (!targetId || typeof targetId !== "string") {
        return res.status(400).json({ error: "targetId is required" });
      }
      if (!MEMBER_TARGET_KINDS.includes(targetKind)) {
        return res.status(400).json({ error: `targetKind must be one of ${MEMBER_TARGET_KINDS.join(", ")}` });
      }
      if (!targetResolver({ targetKind, targetId }).alive) {
        return res.status(400).json({ error: invalidTargetMessage(targetKind, targetId) });
      }
      if (targetKind !== "a2a") {
        const existing = db.findPostByTarget(targetKind, targetId, { excludeMemberId: member.id });
        if (existing) {
          return res.status(409).json({
            error: `already on duty: post '${existing.member.title}' in fleet '${existing.fleet?.name ?? existing.member.fleetId}'`,
            existing: { fleetId: existing.member.fleetId, memberId: existing.member.id, title: existing.member.title },
          });
        }
      }

      // 清史重开: clear the dedicated session's conversation before the new
      // incumbent takes over. Report history lives elsewhere (刀2) and is
      // never touched. A session with a turn in flight cannot be cleared —
      // the swap is refused rather than half-applied.
      if (req.body?.freshSession === true) {
        const task = taskIndexFor(fleet.id).get(member.id);
        if (task?.sessionId) {
          try {
            await chatHistory.deleteSession(task.sessionId);
          } catch (err) {
            if (err?.code === "active") {
              return res.status(409).json({ error: "The post's session has a turn in flight — retry the swap after it settles" });
            }
            // not_found (or a best-effort dsh hiccup) = nothing to clear.
          }
        }
      }

      const updated = db.updateMember(member.id, { targetKind, targetId });
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      const view = memberView(db, fleet, updated, tasks, { resolver: targetResolver });
      res.json({ member: view, reconcile });
    } catch (err) {
      console.error("[fleets] swap error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.delete("/:id/members/:mid", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — its history rows are frozen" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      // Children are re-parented to the removed post's parent (the tree edge
      // must never dangle); the reconcile pass then removes the task.
      const children = db.listMembers(fleet.id).filter((m) => m.parentId === member.id);
      for (const child of children) {
        db.updateMember(child.id, { parentId: member.parentId ?? null });
      }
      db.deleteMember(member.id);
      const reconcile = await runReconcile(fleet.id);
      res.json({ removed: member.id, reparented: children.map((c) => c.id), reconcile });
    } catch (err) {
      console.error("[fleets] member delete error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/members/:mid/pause", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — cadence writes are closed" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      if (!member.cadence) {
        return res.status(400).json({ error: "A passive post has no cadence to pause" });
      }
      const updated = db.updateMember(member.id, { cadence: { ...member.cadence, enabled: false } });
      const reconcile = await runReconcile(fleet.id);
      res.json({ member: { id: updated.id, cadence: updated.cadence }, reconcile });
    } catch (err) {
      console.error("[fleets] member pause error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/members/:mid/resume", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — cadence writes are closed" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      if (!member.cadence) {
        return res.status(400).json({ error: "A passive post has no cadence to resume" });
      }
      const updated = db.updateMember(member.id, { cadence: { ...member.cadence, enabled: true } });
      const reconcile = await runReconcile(fleet.id);
      res.json({ member: { id: updated.id, cadence: updated.cadence }, reconcile });
    } catch (err) {
      console.error("[fleets] member resume error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  app.use("/api/fleets", router);
}

