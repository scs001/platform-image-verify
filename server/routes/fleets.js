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
import { validateOrchestration, expandedEdges, dispatchAllowed, constraintsOf } from "../fleet-orchestration.js";
import { splitToolTarget } from "../tool-turn.js";
import { resolveServerEndpoint, resolveStdioServerConfig } from "../../lib/action-executor.js";
import { fleetModelChoiceError, resolveModelChain } from "../fleet-model.js";
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

function fleetId(_id) {
  return `fleet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function memberId(_id) {
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
    // Empty targetId = provisioner conflict sentinel — no label, the vacant
    // badge and its reason carry the story.
    return { alive: !!entry, label: entry?.name ?? (member.targetId || null), clusterName: null };
  }
  if (member.targetKind === "cluster") {
    const cluster = getClusterDatabase().get(member.targetId);
    const alive = !!cluster && cluster.status !== "terminated";
    return { alive, label: cluster?.name ?? (member.targetId || null), clusterName: cluster?.name ?? null };
  }
  if (member.targetKind === "tool") {
    // Tool posts (add-tool-posts): alive = the server is routable at all
    // (operator stdio config or a registry entry); the tool name itself is
    // judged at run time, honestly, because MCP tool surfaces drift.
    const split = splitToolTarget(member.targetId);
    const alive = !!split && (resolveStdioServerConfig(split.server) != null || resolveServerEndpoint(split.server) != null);
    return { alive, label: member.targetId, clusterName: null };
  }
  if (member.targetKind === "bot") {
    // Bot posts (add-mixed-fleet-packs D4): the target is a bot id in the
    // bots store — pack bots and incumbent bots are indistinguishable here.
    // Existence is the only gate; enabled/connection state is the operator's
    // runtime story, read honestly like every other target.
    const bot = dbModule.getBot(member.targetId);
    return { alive: !!bot, label: bot?.name ?? (member.targetId || null), clusterName: null };
  }
  const entry = catalog.getAgentEntry(member.targetId);
  const alive = !!entry && entry.mode === "a2a";
  return { alive, label: entry?.name ?? (member.targetId || null), clusterName: null };
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
  if (kind === "tool") {
    return splitToolTarget(id)
      ? `tool server '${splitToolTarget(id).server}' is not routable (no registry entry, no stdio config)`
      : `tool target '${id}' must be 'server::tool'`;
  }
  if (kind === "bot") return `bot '${id}' has no instance in this cell's bots store`;
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

// Tool posts (add-tool-posts): the cadence prompt IS the tool's arguments —
// a JSON object, deterministically. Checked wherever a tool post's cadence is
// written (create/update/swap), after normalizeCadence's shape checks.
function toolCadenceError(targetKind, cadence) {
  if (targetKind !== "tool" || !cadence) return null;
  try {
    const parsed = JSON.parse(cadence.promptTemplate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    return "a tool post's cadence.promptTemplate must be a JSON object — it is the tool's arguments";
  }
  return null;
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

function memberView(db, fleet, member, tasks, { now = Date.now(), resolver = resolveTarget, model = null } = {}) {
  const target = resolver(member);
  const task = tasks.get(member.id) ?? null;
  // Report lane: latest with system trends (dual-window missing reads its
  // timestamp too); timeline preview is the first page — the drawer pages.
  const latest = db.latestReportFor(member.id);
  const previous = latest ? db.previousReport(member.id, latest.createdAt) : null;
  const derived = deriveMemberStatus({ member, fleet, task, targetAlive: target.alive, latestReport: latest, now });
  // Turn outcome (add-fleet-turn-events D5): a SECOND dimension next to the
  // presence derivation above — derived status stays byte-identical, the last
  // turn's facts ride alongside. Passive posts read their latest wake turn;
  // no turns yet reads as 尚未执行 in the UI, never as failure.
  const lastTurn = db.latestTurnFor(member.id);
  // Post model (add-fleet-post-model F1/F3): declared values verbatim plus the
  // advisory effective model — what this post's NEXT turn would run on, given
  // the chain and the roster as of this read. Advisory because the roster at
  // turn time may have drifted again.
  const resolution = resolveModelChain({
    model: member.model ?? null,
    fallbackModel: member.fallbackModel ?? null,
    fleetDefault: fleet?.defaultModel ?? null,
    cellDefault: model?.cellDefault ?? null,
    roster: model?.roster ?? null,
  });
  return {
    id: member.id,
    fleetId: member.fleetId,
    title: member.title,
    parentId: member.parentId,
    target: { kind: member.targetKind, id: member.targetId, label: target.label },
    kpiSlots: member.kpiSlots,
    cadence: member.cadence,
    model: member.model ?? null,
    fallbackModel: member.fallbackModel ?? null,
    effectiveModel: resolution.effective,
    modelNotice: resolution.notices.length ? resolution.notices.join("; ") : null,
    sortKey: member.sortKey,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    taskId: task?.id ?? null,
    status: derived.status,
    statusReason: derived.reason,
    evidence: derived.evidence,
    latestReport: buildLatestView({ report: latest, previous, kpiSlots: member.kpiSlots }),
    reportTimeline: db.listReports(member.id, { limit: 5 }).map(reportTimelineEntry),
    lastTurn: lastTurn
      ? {
          status: lastTurn.status,
          errorKind: lastTurn.errorKind,
          error: lastTurn.error,
          endedAt: lastTurn.endedAt,
          sessionId: lastTurn.sessionId,
        }
      : null,
    consecutiveFailures: lastTurn ? db.consecutiveFailures(member.id) : 0,
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

  // Fleet access log (add-fleet-row-update-audit): one line for every
  // non-read /api/fleets request — during the 2026-10-24 reset window the
  // verdict "zero PATCHes" rested on inference precisely because nothing
  // recorded method lines. Read methods stay silent (log volume).
  router.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      console.log(`[fleet-access] ${req.method} ${req.baseUrl}${req.path} ${resolveUser(req)?.email ?? "anon"}`);
    }
    next();
  });

  // Audit attribution (add-fleet-row-update-audit): every fleet-row write
  // from this router stamps who and through which route.
  const auditMeta = (req, via) => ({ actor: resolveUser(req)?.email ?? null, via });

  // ── Post-model helpers (add-fleet-post-model) ─────────────────────────────
  //
  // Roster source for both faces is ctx.dshModels — the same in-memory list
  // getAvailableModels() serves (deduped for display; membership tests don't
  // care). Null (tests without a runtime) degrades every roster gate open.
  const modelRoster = () => (Array.isArray(ctx?.dshModels) ? ctx.dshModels.map((m) => m.id) : null);
  const modelCtx = () => ({ roster: modelRoster(), cellDefault: ctx?.bootModel?.id ?? null });

  // Write gate, evaluated against the RESULTING row (not the patch alone):
  // the fallback⇒primary constraint and the persona-only rule must hold after
  // the write, so a patch that only clears `model` while a fallback hangs on
  // is caught here, not by a later turn.
  const memberModelWriteError = ({ existing = null, targetKind, body }) => {
    const model = body?.model !== undefined ? body.model : (existing?.model ?? null);
    const fallbackModel = body?.fallbackModel !== undefined ? body.fallbackModel : (existing?.fallbackModel ?? null);
    for (const v of [model, fallbackModel]) {
      if (v != null && typeof v !== "string") return "model fields must be a model id string or null";
    }
    if (targetKind !== "persona" && (model != null || fallbackModel != null)) {
      return "only persona posts declare a model — a2a posts take theirs from the service deployment config, cluster posts from their member posts, tool posts run no LLM at all";
    }
    if (fallbackModel != null && model == null) {
      return "fallbackModel requires model — clear the fallback before clearing (or omitting) the primary";
    }
    const roster = modelRoster();
    for (const [label, value] of [["model", model], ["fallbackModel", fallbackModel]]) {
      if (value == null) continue;
      const err = fleetModelChoiceError({ model: value, roster });
      if (err) return `${label}: ${err}`;
    }
    return null;
  };

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
        // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
        // attribution — a persona swapped into a walkthrough fleet's post must
        // not collide with its live post and wedge report/escalate with 409s.
        if (f.state === "archived") continue;
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
      // Selection-time model fallbacks (add-fleet-post-model D7): the turn
      // recorded them under this member; a report filed in that same turn
      // carries them as blockers so the owner sees WHY the post ran degraded.
      // One-shot — a report is the only consumer; no report leaves them in the
      // log only.
      const modelNotices =
        typeof ctx?.takeFleetModelNotices === "function" ? ctx.takeFleetModelNotices(member.id) : [];
      const report = db.appendReport({
        id: `r_${now}_${Math.random().toString(36).slice(2, 8)}`,
        fleetId: member.fleetId,
        memberId: member.id,
        sessionId,
        metrics: payload.report.metrics,
        resources: payload.report.resources,
        blockers: [...modelNotices.map(String), ...payload.report.blockers].slice(0, 20),
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

  // ── Turn result events (add-fleet-turn-events D6) ─────────────────────────

  // One timeline row: system facts only — no credentials, no session bodies.
  function turnTimelineEntry(event) {
    return {
      id: event.id,
      memberId: event.memberId,
      source: event.source,
      status: event.status,
      errorKind: event.errorKind,
      error: event.error,
      model: event.model,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      sessionId: event.sessionId,
    };
  }

  // Member turn timeline for the detail drawer — same cursor shape as the
  // report timeline (nextBefore = last row's id).
  router.get("/:id/members/:mid/turns", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      const beforeId = req.query.before ? Number(req.query.before) : null;
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const rows = db.listTurnEvents(member.id, {
        ...(Number.isFinite(beforeId) ? { beforeId } : {}),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      res.json({
        turns: page.map(turnTimelineEntry),
        nextBefore: rows.length > limit ? page[page.length - 1].id : null,
      });
    } catch (err) {
      console.error("[fleets] turn timeline error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Fleet-wide filter (status/source) — the data source the architect pack's
  // read verbs and O3's both-sides dispatch events will consume.
  router.get("/:id/turns", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const status = req.query.status ?? null;
      const source = req.query.source ?? null;
      if (status && !["ok", "failed", "interrupted"].includes(status)) {
        return res.status(400).json({ error: "status must be one of ok|failed|interrupted" });
      }
      if (source && !["cron", "manual", "delegation", "event"].includes(source)) {
        return res.status(400).json({ error: "source must be one of cron|manual|delegation" });
      }
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const db = getFleetDatabase();
      res.json({ turns: db.listFleetTurnEvents(owned.fleet.id, { status, source, limit }).map(turnTimelineEntry) });
    } catch (err) {
      console.error("[fleets] fleet turns error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Dispatch bridge (agent-fleet-orchestration O3) ────────────────────────
  //
  // A member turn's dispatch_post lands here: the running post (server-side
  // attribution, same seam as report/escalate) dispatches work to another
  // post of the SAME fleet. The task rides the existing delegation lane —
  // engine manual task with origin.fleet evidence (depth 1) and the
  // dispatcher's session as initiator, so the aggregator returns the summary
  // into the dispatcher's NEXT turn. Async by construction: never a wait.
  const dispatchBudgets = new Map(); // `${fleetId}:${memberId}` / fleetId → timestamps[]
  function dispatchCap(kind, fallback) {
    const n = Number(process.env[`FLEET_DISPATCH_${kind}_CAP`]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  function budgetTake(key, windowMs, cap) {
    const now = Date.now();
    const stamps = (dispatchBudgets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (stamps.length >= cap) {
      dispatchBudgets.set(key, stamps);
      return false;
    }
    stamps.push(now);
    dispatchBudgets.set(key, stamps);
    return true;
  }

  router.post("/dispatch", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const toRef = req.body?.to;
      const brief = req.body?.brief;
      if (typeof toRef !== "string" || !toRef) {
        return res.status(400).json({ error: "to (target post ref) is required" });
      }
      if (typeof brief !== "string" || !brief.trim()) {
        return res.status(400).json({ error: "brief is required" });
      }

      const personaMembers = [];
      for (const f of db.listFleets()) {
        if (f.state === "archived") continue;
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
      const from = db.getMember(attribution.memberId);
      if (!from) return res.status(409).json({ error: "the attributed post no longer exists" });
      const fleet = db.getFleet(from.fleetId);
      if (!fleet) return res.status(409).json({ error: "the dispatcher's fleet no longer exists" });

      // Guard 1: same fleet. Guard 2: no self-dispatch (attribution already
      // implies it, but the ref could be the caller's own post).
      const target = db.getMember(toRef);
      if (!target || target.fleetId !== fleet.id) {
        return res.status(400).json({ error: `post '${toRef}' is not a member of ${fleet.name}` });
      }
      if (target.id === from.id) {
        return res.status(400).json({ error: "a post cannot dispatch to itself" });
      }
      // Guard 3: the edge/mode permission.
      const allowed = dispatchAllowed({ members: db.listMembers(fleet.id), orchestration: fleet.orchestration }, from.id, target.id);
      if (!allowed.ok) return res.status(403).json({ error: allowed.error });
      // Guard 4: cluster posts have no manual lane (delegation targets
      // personas, a2a agents, and tool posts). Tool posts take their args as
      // the brief — it must BE the JSON arguments, deterministically.
      if (target.targetKind === "cluster") {
        return res.status(400).json({ error: `post '${target.title}' runs a cluster — the manual dispatch lane targets persona/a2a/tool posts` });
      }
      let dispatchPrompt = null;
      if (target.targetKind === "tool") {
        try {
          const parsed = JSON.parse(brief);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          dispatchPrompt = brief.trim();
        } catch {
          return res.status(400).json({ error: `post '${target.title}' is a tool post — the brief must be its JSON arguments (e.g. {"query":"…"})` });
        }
      } else {
        dispatchPrompt =
          `【舰队派发】来自同舰队岗位「${from.title}」的派发(回执将自动送回其下一回合):\n${brief.trim().slice(0, 4000)}`;
      }
      // Guard 5: rate caps — per member per turn-proxy window, per fleet per hour.
      if (!budgetTake(`m:${from.id}`, 15 * 60_000, dispatchCap("PER_TURN", 3))) {
        return res.status(429).json({ error: "dispatch cap reached for this post (3 per ~15min) — batch the work into fewer briefs" });
      }
      if (!budgetTake(`f:${fleet.id}`, 60 * 60_000, dispatchCap("HOURLY", 30))) {
        return res.status(429).json({ error: "fleet dispatch cap reached for this hour (30) — tighten the edges" });
      }

      // Dispatch rides the delegation lane: initiator = the dispatcher's
      // session (the aggregator delivers the summary back there), origin.fleet
      // carries the target post + depth 1 for the turn contract.
      const prompt = dispatchPrompt;
      const task = engine.createManualTask({
        prompt,
        ...(target.targetKind === "a2a"
          ? { agent: target.targetId }
          : target.targetKind === "tool"
            ? { tool: target.targetId }
            : { persona: rosterPresetId(target.targetId) }),
        sessionTitle: `派发 · ${target.title}`,
        initiator: chatHistory.currentSessionId(),
        origin: { fleet: { fleetId: fleet.id, memberId: target.id, depth: 1 } },
      });
      res.status(201).json({
        dispatched: true,
        taskId: task.id,
        to: { memberId: target.id, title: target.title, kind: target.targetKind },
        note: "async — the summary arrives in the dispatching post's next turn",
      });
    } catch (err) {
      console.error("[fleets] dispatch error:", err.message);
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
        memberView(db, owned.fleet, m, taskIndexFor(owned.fleet.id), { resolver: targetResolver, model: modelCtx() }),
      );
      const statusCounts = {};
      for (const v of members) statusCounts[v.status] = (statusCounts[v.status] ?? 0) + 1;
      // Failure dimension (add-fleet-turn-events D5): on-duty posts whose
      // latest turn did not end ok. Presence counts below stay untouched —
      // a missing post with a failed last turn counts in both dimensions.
      const failing = members.filter((m) => m.status === "on_duty" && m.lastTurn && m.lastTurn.status !== "ok").length;

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
        // Orchestration read view (agent-fleet-orchestration): declared
        // section + read-time mode expansion (implicit supervisor edges are
        // marked, never stored).
        orchestration: owned.fleet.orchestration
          ? {
              mode: owned.fleet.orchestration.mode ?? null,
              constraints: constraintsOf(owned.fleet.orchestration),
              edges: expandedEdges({ members, orchestration: owned.fleet.orchestration }),
            }
          : null,
        health: {
          onDuty: statusCounts.on_duty ?? 0,
          paused: statusCounts.paused ?? 0,
          missing: statusCounts.missing ?? 0,
          vacant: statusCounts.vacant ?? 0,
          passive: statusCounts.passive ?? 0,
          failing,
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
            // tool/bot resolve through resolveTarget semantics — the same
            // authority the member read face uses (mixed-fleet D4).
            if (kind === "tool" || kind === "bot") {
              return resolveTarget({ targetKind: kind, targetId: id }).alive;
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
      db.updateFleet(owned.fleet.id, { state: "active" }, auditMeta(req, "POST /api/fleets/:id/start"));
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
        // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
        // attribution — a persona swapped into a walkthrough fleet's post must
        // not collide with its live post and wedge report/escalate with 409s.
        if (f.state === "archived") continue;
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

  // Cadence read contract (enable-wire-content-fleet D3): the fleet's posts
  // with their cadence and target ref — the facts an external content system
  // needs to refuse a refresh schedule equivalent to a post it cannot see.
  // Rhythm and target ONLY: no KPI slots, reports, decisions or credentials.
  // Passive posts answer cron/tz null (the caller reads that as "not in the
  // equivalence comparison").
  router.get("/:id/cadence", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const posts = db.listMembers(owned.fleet.id).map((m) => ({
        ref: m.id,
        title: m.title,
        cron: m.cadence?.cron ?? null,
        tz: m.cadence?.tz ?? null,
        targetRef: { kind: m.targetKind, id: m.targetId },
      }));
      res.json({ fleetId: owned.fleet.id, fleetName: owned.fleet.name, posts });
    } catch (err) {
      console.error("[fleets] cadence read error:", err.message);
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
        if (member && member.targetKind === "tool") {
          // Tool posts: the delivery must BE the arguments — a JSON body, not
          // prose. Decision text is prose by nature, so require an explicit
          // args object on the op.
          const args = req.body?.args;
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            return res.status(400).json({ error: "a tool post's execute-now needs `args` — the tool's JSON arguments (decision prose is not executable)" });
          }
          const manual = engine.createManualTask({
            prompt: JSON.stringify(args),
            tool: member.targetId,
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
            const view = memberView(db, fleet, m, tasks, { resolver: targetResolver, model: modelCtx() });
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
      const views = members.map((m) => memberView(db, owned.fleet, m, tasks, { resolver: targetResolver, model: modelCtx() }));
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
      const { name, state, defaultModel } = req.body ?? {};
      const updates = {};

      if (name !== undefined) {
        if (!name || typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ error: "Fleet name must be a non-empty string" });
        }
        updates.name = name.trim().slice(0, 120);
      }
      if (defaultModel !== undefined) {
        if (defaultModel !== null) {
          const err = fleetModelChoiceError({ model: defaultModel, roster: modelRoster() });
          if (err) return res.status(400).json({ error: `defaultModel: ${err}` });
        }
        updates.defaultModel = defaultModel;
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
      if (req.body?.orchestration !== undefined) {
        const orch = req.body.orchestration;
        // Full graph validation against the live member set — edges reference
        // posts, so the section lands after the posts exist (create-time
        // fleets have no members: mode/constraints pass, edges cannot).
        const check = validateOrchestration({ members: getFleetDatabase().listMembers(fleet.id), orchestration: orch });
        if (!check.ok) {
          return res.status(400).json({ error: "orchestration: " + check.errors[0].error, errors: check.errors });
        }
        updates.orchestration = orch;
      }

      const updated = getFleetDatabase().updateFleet(fleet.id, updates, auditMeta(req, `PATCH /api/fleets/${fleet.id}`));
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
      const updated = getFleetDatabase().updateFleet(fleet.id, { state: "archived" }, auditMeta(req, `DELETE /api/fleets/${fleet.id}`));
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
      // and tool targets are exempt (external execution / stateless calls
      // carry no attribution ambiguity).
      if (targetKind !== "a2a" && targetKind !== "tool") {
        const existing = db.findPostByTarget(targetKind, targetId);
        if (existing) {
          return res.status(409).json({
            error: `already on duty: post '${existing.member.title}' in fleet '${existing.fleet?.name ?? existing.member.fleetId}'`,
            existing: { fleetId: existing.member.fleetId, memberId: existing.member.id, title: existing.member.title },
          });
        }
      }
      const cad = normalizeCadence(req.body?.cadence, { confirmed: req.body?.confirmed });
      const cadToolErr = toolCadenceError(targetKind, cad.cadence);
      if (cadToolErr) return res.status(400).json({ error: cadToolErr });
      if (!cad.ok) {
        return res.status(cad.code ? 400 : 400).json({ error: cad.error, ...(cad.code ? { code: cad.code } : {}) });
      }
      const kpi = normalizeKpiSlots(req.body?.kpiSlots);
      if (!kpi.ok) return res.status(400).json({ error: kpi.error });

      const modelErr = memberModelWriteError({ targetKind, body: req.body });
      if (modelErr) return res.status(400).json({ error: modelErr });

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
        model: req.body?.model ?? null,
        fallbackModel: req.body?.fallbackModel ?? null,
      });
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      res.status(201).json({ member: memberView(db, fleet, member, tasks, { resolver: targetResolver, model: modelCtx() }), reconcile });
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
      const { title, parentId, cadence, kpiSlots, model, fallbackModel } = req.body ?? {};

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
        const cadToolErr = toolCadenceError(member.targetKind, cad.cadence);
        if (cadToolErr) return res.status(400).json({ error: cadToolErr });
        updates.cadence = cad.cadence;
      }
      if (model !== undefined || fallbackModel !== undefined) {
        const modelErr = memberModelWriteError({ existing: member, targetKind: member.targetKind, body: { model, fallbackModel } });
        if (modelErr) return res.status(400).json({ error: modelErr });
        if (model !== undefined) updates.model = model;
        if (fallbackModel !== undefined) updates.fallbackModel = fallbackModel;
      }

      const updated = db.updateMember(member.id, updates);
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      res.json({ member: memberView(db, fleet, updated, tasks, { resolver: targetResolver, model: modelCtx() }), reconcile });
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
      if (targetKind !== "a2a" && targetKind !== "tool") {
        const existing = db.findPostByTarget(targetKind, targetId, { excludeMemberId: member.id });
        if (existing) {
          return res.status(409).json({
            error: `already on duty: post '${existing.member.title}' in fleet '${existing.fleet?.name ?? existing.member.fleetId}'`,
            existing: { fleetId: existing.member.fleetId, memberId: existing.member.id, title: existing.member.title },
          });
        }
      }
      // Post model belongs to persona posts only (add-fleet-post-model F1):
      // restaffing to an a2a/cluster target with a model declared would leave
      // a dead declaration on a post whose model is owned elsewhere — refuse.
      if (targetKind !== "persona" && (member.model || member.fallbackModel)) {
        return res.status(400).json({ error: "this post declares a model — clear it before restaffing to a non-persona target" });
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
      const view = memberView(db, fleet, updated, tasks, { resolver: targetResolver, model: modelCtx() });
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
      // Orchestration edges must not dangle either: any edge touching the
      // removed post drops with it (explicit-by-declaration, gone-by-removal).
      if (fleet.orchestration?.edges?.length) {
        const kept = fleet.orchestration.edges.filter(
          (e) => (e.from ?? null) !== member.id && e.to !== member.id,
        );
        if (kept.length !== fleet.orchestration.edges.length) {
          db.updateFleet(fleet.id, { orchestration: { ...fleet.orchestration, edges: kept } }, auditMeta(req, `DELETE /api/fleets/${fleet.id}/members/${req.params.mid}`));
        }
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

