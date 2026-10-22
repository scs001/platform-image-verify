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
import {
  validateEscalatePayload,
  validateResolution,
  renderDecisionSegment,
  buildExecuteNowPrompt,
  OPEN_QUEUE_LIMIT,
} from "../fleet-decisions.js";
import * as engine from "../../task-engine.js";
import { exportFleetToTemplate } from "../fleet-template.js";
import { provisionFleetFromTemplate } from "../fleet-provisioner.js";
import * as dbModule from "../../db.js";

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

// The template-newer notice (D7): notice only — never a migration, never a
// mutation of the live fleet.
function templateNotice(fleet) {
  if (!fleet.sourceTemplate?.packId) return null;
  const installed = dbModule.getInstalledPack(fleet.sourceTemplate.packId);
  if (!installed?.version) return null;
  const newer = installed.version !== fleet.sourceTemplate.version;
  return {
    packId: fleet.sourceTemplate.packId,
    instantiatedVersion: fleet.sourceTemplate.version ?? null,
    latestVersion: installed.version,
    updateAvailable: newer,
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

  // ── Cockpit aggregate + template lifecycle (agent-fleet-templates) ────────

  // One round-trip for the whole cockpit (design: no four-fetch flicker).
  // Every segment reuses the previous knives' read contracts verbatim —
  // statuses/evidence/latest from the detail face, decisions from the queue
  // face — plus the health rollup and the template-newer notice (D7).
  router.get("/:id/cockpit", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      db.expireOpenDecisions(owned.fleet.id);
      const members = db.listMembers(owned.fleet.id).map((m) =>
        memberView(db, owned.fleet, m, taskIndexFor(owned.fleet.id), { resolver: targetResolver }),
      );
      const statusCounts = {};
      for (const v of members) statusCounts[v.status] = (statusCounts[v.status] ?? 0) + 1;

      // Decisions: open, severity first then closest to policy expiry.
      const policy = owned.fleet.decisionPolicy ?? { expiryHours: 72 };
      const expiryMs = policy.expiryHours > 0 ? policy.expiryHours * 3600_000 : null;
      const decisions = db
        .listDecisions({ fleetId: owned.fleet.id, state: "open" })
        .map((item) => ({
          ...item,
          memberTitle: members.find((m) => m.id === item.memberId)?.title ?? null,
          expiresAt: expiryMs ? item.submittedAt + expiryMs : null,
        }))
        .sort((a, b) => {
          const sev = { high: 0, normal: 1, low: 2 };
          if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
          return (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity);
        });

      // Daily stream: each post's latest report, missing posts first.
      const stream = members
        .map((m) => ({ memberId: m.id, title: m.title, status: m.status, latestReport: m.latestReport }))
        .sort((a, b) => {
          if (a.status === "missing" && b.status !== "missing") return -1;
          if (b.status === "missing" && a.status !== "missing") return 1;
          return (b.latestReport?.at ?? 0) - (a.latestReport?.at ?? 0);
        });

      res.json({
        fleet: owned.fleet,
        members,
        statusCounts,
        decisions,
        openDecisions: decisions.length,
        stream,
        health: {
          onDuty: statusCounts.on_duty ?? 0,
          paused: statusCounts.paused ?? 0,
          missing: statusCounts.missing ?? 0,
          vacant: statusCounts.vacant ?? 0,
          passive: statusCounts.passive ?? 0,
          total: members.length,
        },
        template: templateNotice(owned.fleet),
      });
    } catch (err) {
      console.error("[fleets] cockpit error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Instantiate a fleet from an installed pack's template section. Install
  // never auto-runs: the fleet is born all-paused with a 待启动 banner.
  router.post("/from-template", async (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const packId = req.body?.packId;
      if (typeof packId !== "string" || !packId.trim()) {
        return res.status(400).json({ error: "packId is required" });
      }
      const installed = dbModule.getInstalledPack(packId);
      if (!installed) return res.status(400).json({ error: `pack '${packId}' is not installed here` });
      if (!installed.manifest?.fleet) {
        return res.status(400).json({ error: `pack '${packId}' carries no fleet template` });
      }

      const db = getFleetDatabase();
      const out = await provisionFleetFromTemplate({
        packId,
        version: installed.version ?? null,
        manifest: installed.manifest,
        ownerEmail: user.email,
        deps: {
          db,
          catalogAgentIds: () => new Set(catalog.getChatAgentEntries().map((e) => e.id)),
          resolveExisting: ({ kind, id }) => {
            if (kind === "persona") return !!catalog.getChatAgentEntries().some((e) => e.id === id);
            if (kind === "a2a") {
              const entry = catalog.getAgentEntry(id);
              return !!entry && entry.mode === "a2a";
            }
            const cluster = getClusterDatabase().get(id);
            return !!cluster && cluster.status !== "terminated";
          },
          reconcile: (fleetId) =>
            reconcileFleet({ fleetId, db, cronApi: cron, resolveTarget: targetResolver, rosterPresetId }),
        },
      });
      if (!out.ok) return res.status(400).json({ error: out.error });
      res.status(out.deduped ? 200 : 201).json(out);
    } catch (err) {
      console.error("[fleets] from-template error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Confirm-start (3.2): the owner reviewed the structure — flip the fleet to
  // active and re-enable every member's cadence (vacant posts park again via
  // reconcile; member-level pauses chosen before start are not a thing here —
  // everything was born paused).
  router.post("/:id/start", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      if (owned.fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived" });
      }
      db.updateFleet(owned.fleet.id, { state: "active" });
      for (const m of db.listMembers(owned.fleet.id)) {
        if (m.cadence && m.cadence.enabled === false) {
          db.updateMember(m.id, { cadence: { ...m.cadence, enabled: true } });
        }
      }
      const reconcile = await runReconcile(owned.fleet.id);
      res.json({ fleet: db.getFleet(owned.fleet.id), reconcile });
    } catch (err) {
      console.error("[fleets] start error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Export (3.3): whitelist-only manifest — skeleton/slots/cadence survive;
  // reports, decisions, sessions, owner, credentials never do.
  router.get("/:id/export", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const members = db.listMembers(owned.fleet.id);
      const manifest = exportFleetToTemplate(owned.fleet, members);
      res.setHeader("content-disposition", `attachment; filename="fleet-${owned.fleet.id}.json"`);
      res.json(manifest);
    } catch (err) {
      console.error("[fleets] export error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Decision lane (agent-fleet-decision-lane) ─────────────────────────────
  //
  // The escalate bridge (twin of /report): the in-cell fleet MCP child files
  // an approval request from the post the CURRENT turn runs under. The
  // question text, options and severity come from the caller; expiry NEVER
  // does — that is fleet policy (suggestedDeadline is display-only).

  router.post("/escalate", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const payload = validateEscalatePayload(req.body);
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
      const fleet = db.getFleet(member.fleetId);

      // Flood (design D5): per-post daily cap from the fleet policy, and the
      // fleet-wide open queue cap — a flooded queue must not paralyze the
      // owner's entry point.
      const now = Date.now();
      db.expireOpenDecisions(fleet.id, { now });
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const dailyCount = db.countDecisionsByMemberSince(member.id, dayStart.getTime());
      const cap = fleet.decisionPolicy?.dailyCapPerMember ?? 10;
      if (dailyCount >= cap) {
        return res.status(429).json({ error: `daily escalation limit reached (${cap}/day for this post)`, dailyRemaining: 0 });
      }
      const openCount = db.countOpenDecisions(fleet.id);
      if (openCount >= OPEN_QUEUE_LIMIT) {
        return res.status(429).json({ error: `the fleet's open decision queue is full (${OPEN_QUEUE_LIMIT}) — resolve pending items first` });
      }

      const sessionId =
        attribution.task?.sessionId ?? chatHistory.currentSessionId?.() ?? null;
      const item = db.appendDecision({
        id: `d_${now}_${Math.random().toString(36).slice(2, 8)}`,
        fleetId: fleet.id,
        memberId: member.id,
        question: payload.item.question,
        options: payload.item.options,
        severity: payload.item.severity,
        suggestedDeadline: payload.item.suggestedDeadline,
        recommendation: payload.item.recommendation,
        sourceSessionId: sessionId,
        submittedAt: now,
      });
      // Best-effort out-of-band ping seam (WeChat envelope et al.): mounted
      // by the deployment when a provider exists; absent = in-app badge only.
      try {
        ctx?.fleetDecisionNotifier?.(fleet, item, member);
      } catch { /* best-effort by contract */ }
      res.status(201).json({
        ok: true,
        itemId: item.id,
        memberTitle: member.title,
        queuePosition: openCount + 1,
        dailyRemaining: cap - dailyCount - 1,
      });
    } catch (err) {
      console.error("[fleets] escalate error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Owner queue: lazy expiry sweep first, then the list. `state=open` (the
  // default) is the to-do view; `all` keeps history (expired stay listed).
  router.get("/:id/decisions", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      db.expireOpenDecisions(owned.fleet.id);
      const state = req.query.state === "all" ? null : "open";
      const members = new Map(db.listMembers(owned.fleet.id).map((m) => [m.id, m]));
      const items = db.listDecisions({ fleetId: owned.fleet.id, state }).map((item) => {
        const member = members.get(item.memberId) ?? null;
        return {
          ...item,
          memberTitle: member?.title ?? null,
          memberDeleted: !member,
          pendingDelivery:
            (item.state === "approved" || item.state === "rejected") &&
            item.deliveredAt == null &&
            !!member,
        };
      });
      res.json({
        decisions: items,
        openCount: db.countOpenDecisions(owned.fleet.id),
        decisionPolicy: owned.fleet.decisionPolicy,
      });
    } catch (err) {
      console.error("[fleets] decisions list error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // approve | reject | amend | reopen | execute-now — one handler, the state
  // machine's gatekeeping all in one place. Optimistic transitions make a
  // concurrent second resolution read as a conflict (first resolution wins).
  router.post("/:id/decisions/:itemId/:op", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const { fleet } = owned;
      const { itemId, op } = req.params;
      const now = Date.now();
      db.expireOpenDecisions(fleet.id, { now });

      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Decision not found" });
      }
      const member = db.getMember(item.memberId) ?? null;

      if (op === "reopen") {
        if (item.state !== "expired") {
          return res.status(409).json({ error: `only expired items can be reopened (state: ${item.state})` });
        }
        const reopened = db.transitionDecision(itemId, "expired", { state: "open", resolution: null, submittedAt: now });
        if (!reopened) return res.status(409).json({ error: "concurrent change — reload and retry" });
        return res.json({ decision: reopened });
      }

      if (op === "execute-now") {
        if (item.state !== "approved") {
          return res.status(409).json({ error: `only approved items can execute now (state: ${item.state})` });
        }
        // Delivery vehicle: the post's materialized task if it has a cadence
        // (prompt override carries the decision segment), else a manual task
        // for persona/a2a posts. A passive CLUSTER post has neither lane —
        // honest refusal; delivery rides its next delegated turn instead.
        const task = taskIndexFor(fleet.id).get(item.memberId) ?? null;
        const deliverable = db.listDecisions({ fleetId: fleet.id, pendingDeliveryFor: item.memberId });
        if (task) {
          const digest = renderDecisionSegment(deliverable);
          const base = task.prompt?.includes("{{fleetContext}}") && digest
            ? task.prompt.replace(/\{\{fleetContext\}\}/g, digest)
            : `${task.prompt ?? ""}\n\n${buildExecuteNowPrompt(deliverable)}`;
          engine.setPromptOverride(task.id, base);
          const r = await cron.runJobNow(task.id);
          if (r?.ok === true || r?.already === true) {
            return res.json({
              executing: true,
              alreadyRunning: r?.already === true,
              taskId: task.id,
              note: r?.already === true ? "a turn is already in flight — delivery rides it" : null,
            });
          }
          return res.status(409).json({ error: r?.error ?? "could not start the turn" });
        }
        if (member && member.targetKind === "persona") {
          const manual = engine.createManualTask({
            prompt: buildExecuteNowPrompt(deliverable),
            persona: rosterPresetId(member.targetId),
            sessionTitle: `拍板送达 · ${member.title}`,
            origin: { fleet: { fleetId: fleet.id, memberId: member.id } },
          });
          return res.json({ executing: true, taskId: manual.id, manual: true });
        }
        if (member && member.targetKind === "a2a") {
          const manual = engine.createManualTask({
            prompt: buildExecuteNowPrompt(deliverable),
            agent: member.targetId,
            sessionTitle: `拍板送达 · ${member.title}`,
            origin: { fleet: { fleetId: fleet.id, memberId: member.id } },
          });
          return res.json({ executing: true, taskId: manual.id, manual: true });
        }
        return res.status(409).json({
          error: "this post has no cadence task and no manual lane (passive cluster post) — delivery will ride its next delegated turn",
        });
      }

      if (!["approve", "reject", "amend"].includes(op)) {
        return res.status(400).json({ error: `unknown decision op '${op}'` });
      }
      if (item.state === "expired") {
        return res.status(409).json({ error: "this item expired — reopen it before deciding" });
      }
      if (item.state !== "open") {
        return res.status(409).json({ error: `already ${item.state === "delivered" ? "delivered" : `resolved (${item.state})`}` });
      }
      const resolution = validateResolution(op, req.body ?? {}, item);
      if (!resolution.ok) return res.status(400).json({ error: resolution.error });
      resolution.resolution.by = owned.user.email;
      resolution.resolution.at = now;

      const updated = db.transitionDecision(itemId, "open", {
        state: op === "reject" ? "rejected" : "approved",
        resolution: resolution.resolution,
        resolvedAt: now,
      });
      if (!updated) {
        return res.status(409).json({ error: "first resolution wins — another decision just landed" });
      }
      res.json({ decision: updated });
    } catch (err) {
      console.error("[fleets] decision op error:", err.message);
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
      db.expireOpenDecisions(owned.fleet.id);
      res.json({
        fleet: owned.fleet,
        members: views,
        statusCounts,
        openDecisions: db.countOpenDecisions(owned.fleet.id),
        decisionPolicy: owned.fleet.decisionPolicy,
      });
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

