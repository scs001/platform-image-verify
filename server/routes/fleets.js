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
import { resolveDispatchTarget } from "../../server/fleet-chat-context.js";
import { getClusterDatabase } from "./clusters-db.js";
import {
  getFleetDatabase,
  FLEET_STATES,
  MEMBER_TARGET_KINDS,
} from "./fleets-db.js";
import { reconcileFleet, deriveMemberStatus, cronPeriodMs, staleWindowMs } from "../fleet-reconcile.js";
import { validateOrchestration, expandedEdges, dispatchAllowed, constraintsOf } from "../fleet-orchestration.js";
import { validateFleetDraft, applyFleetDraft } from "../fleet-architect.js";
import { splitToolTarget } from "../tool-turn.js";
import { resolveServerEndpoint, resolveStdioServerConfig } from "../../lib/action-executor.js";
import { fleetModelChoiceError, resolveModelChain, validateConfigDims, effortUnionFrom } from "../fleet-model.js";
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
import {
  normalizeDelegationPolicy,
  normalizeQuestion,
  routeForItem,
  SEVERITY_RANK,
} from "./fleets-db.js";
import { memoryRefClientFor, memoryRefSlug } from "../memory-refs.js";
import * as engine from "../../task-engine.js";
import { exportFleetToTemplate } from "../fleet-template.js";
import { createConfigChangeProposal, runIterationCast, retryIterationCast } from "../fleet-iteration.js";
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

// 常务岗职责（DEPUTY_PROMPT）：加岗时就写进 cadence.promptTemplate——职责是
// 岗位声明的一部分，不是一个隐藏开关。措辞点明「越权会被服务端拒绝，然后
// 转主人」，因为闸在服务端，这段只影响模型行为、不构成授权。
//
// 2026-10-29 真机实证后的两处收紧：
//   ① 队列每项**已经带着**主人的同类判例（`precedents` 字段，服务端连人带
//      理由一起给）——旧措辞「按主人过往判例裁决」让一个岗把整轮时间花在
//      工作区和记忆里翻判例，8 分钟跑完一条都没裁。现在明写「就地用，
//      不要为此另做检索」。
//   ② 「找不到判例」不是不裁的理由。凭空要求判例会让代理把「无先例」当成
//      阻塞项而停摆；正确行为是照事实与策略自己裁，并在 evidence 里**如实
//      说明没有同类判例、理由是什么**（这一点真机里它其实做到了，值得固化）。
const DEPUTY_PROMPT =
  "你是本舰队的常务岗（决策代理）。每一轮：1) 用 decision_queue 读取待裁项——" +
  "每项已附来源岗位近期报数与主人同类判例（precedents），**就地使用，不要为此另做检索**；" +
  "2) 逐项裁决（decision_resolve，必须附 evidence；approve 必须选一个选项 value）：" +
  "有判例就引用它，没有就按事实与策略自己裁并在 evidence 里写明「无同类判例，理由如下」——" +
  "缺判例不是不裁的理由；3) 真正判不了的（超出授权、事实不足、需主人偏好）用 " +
  "decision_escalate_to_owner 附分析上报，不要硬裁；4) 问题单做归并与跟踪，不重复上报；" +
  "5) 裁决与进度写记忆，让主人可查证。一轮之内把队列处理完（每条要么裁、要么上报），" +
  "不要留到最后不了了之。绝不越出策略授权——被服务端拒绝就转主人，不要重试。";

function memberId(_id) {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Target resolution ────────────────────────────────────────────────────────
//
// The single authority for "does this targetRef point at a live object".
// Creation-time validation and read-time vacancy derivation share it, so a
// post can never be BUILT dangling — 待补岗 only ever comes from the target
// being deleted afterwards (design: 对象模型).

// `view` is a request-scoped catalog snapshot (catalog.mergedView): a roster
// read resolves one target per member, and resolving against the LIVE catalog
// re-merges it per member — 60 merges × ~30ms of blocked event loop on one
// request, which delayed every other request in the cell including the chat
// WebSocket handshake. One view per request keeps every member of that
// request on the same snapshot AND costs one merge.
function resolveTarget(member, view = null) {
  if (member.targetKind === "persona") {
    const entries = view ? view.chatAgentEntries : catalog.getChatAgentEntries();
    const entry = entries.find((e) => e.id === member.targetId) || null;
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
  const entry = view ? view.agentEntry(member.targetId) : catalog.getAgentEntry(member.targetId);
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

// `jobs` is the already-listed cron job set: a roster read lists the jobs
// once and indexes them per fleet, instead of re-listing every job for every
// fleet (21 fleets × the whole job table).
function taskIndexFor(fleetId, jobs = cron.listJobs()) {
  const map = new Map();
  for (const job of jobs) {
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
  // Failure streak feeds the status derivation (fix-fleet-failure-visibility
  // D3): one pass gives the count, when it started and what the newest
  // failure was. Read BEFORE the derivation because it is an input to it.
  const streak = db.failureStreak(member.id);
  // Presence reads REAL rounds only (fix-fleet-turn-veracity D3): once the
  // turn stream holds any events, the plain latest row settles whether the
  // stream exists, and the newest REAL turn (skips excluded) is what may
  // advance presence — a skip-only history reads as never ran. The in-window
  // skip count doubles as the card badge's "第 k 次" below.
  const lastTurn = db.latestTurnFor(member.id);
  const skipWindowMs = member.cadence ? staleWindowMs(member.cadence.cron, member.cadence.tz) : null;
  const skippedRounds = db.skippedCount(member.id, skipWindowMs ? { sinceMs: now - skipWindowMs } : {});
  // Newest REAL turn (fleet-ops-canvas): skips never carry usage, so the
  // context-budget histogram reads this row, not the plain latest.
  const latestRealTurn = lastTurn ? db.latestRealTurnFor(member.id) : null;
  const derived = deriveMemberStatus({
    member,
    fleet,
    task,
    targetAlive: target.alive,
    latestReport: latest,
    now,
    failureStreak: streak.streak,
    failureSince: streak.since,
    lastFailureKind: streak.lastErrorKind,
    effectiveLastRunAt: lastTurn ? (latestRealTurn?.endedAt ?? null) : undefined,
    skippedRounds,
  });
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
    // Config dimensions (add-agent-config-dims): declared values verbatim.
    // `effort` here is the DECLARED level; the effective level is resolved at
    // turn time (against the landed model) and recorded on the turn event.
    effort: member.effort ?? null,
    contextBudget: member.contextBudget ?? null,
    // Latest real turn's usage (fleet-ops-canvas): the config bar's context
    // budget histogram buckets by this over the declared budget. null = the
    // newest real round reported none (用量字段缺失 ≠ 未超预算).
    latestTurnUsage: latestRealTurn?.usage ?? null,
    effectiveModel: resolution.effective,
    modelNotice: resolution.notices.length ? resolution.notices.join("; ") : null,
    sortKey: member.sortKey,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    taskId: task?.id ?? null,
    status: derived.status,
    statusReason: derived.reason,
    evidence: derived.evidence,
    // Downtime loss, top-level for the post card (P2, 2026-10-26): `missed -->
    // 0` means a platform restart covered one or more of this post's triggers.
    // `catchUpPending` says a make-up round is in flight right now, so a
    // returning owner reads "already being made up", not "still broken".
    missedRounds: derived.evidence.missedRounds ?? 0,
    lastMissedAt: derived.evidence.lastMissedAt ?? null,
    catchUpPending: derived.evidence.catchUpPending === true,
    // Failure attribution, top-level for the card (fix-fleet-failure-visibility):
    // the streak is what downgraded the status — the card says so in the same
    // breath as the colour, never a bare red dot.
    failureStreak: derived.evidence.failureStreak ?? 0,
    failingSince: derived.evidence.failingSince ?? null,
    lastErrorKind: derived.evidence.lastErrorKind ?? null,
    // In-window skip count (fix-fleet-turn-veracity): the post card's
    // 「本轮未执行（第 k 次）」 badge reads this; sustained skips show up in
    // `status` (missing with the count named), not here.
    skippedRounds: derived.evidence.skippedRounds ?? 0,
    // Bot sidecar (fleet-ops-canvas, agent-fleet-core): target kind `bot`
    // posts carry the channel's runtime story as a read-only object —
    // enabled from the bot row, inbound/outbound/error as best-effort
    // timestamps (columns absent → null, never fabricated).
    ...(member.targetKind === "bot"
      ? {
          bot: (() => {
            const bot = dbModule.getBot(member.targetId);
            const activity = dbModule.botActivitySummary(member.targetId) ?? {};
            return {
              type: bot?.type ?? member.targetId,
              enabled: bot ? !!bot.enabled : false,
              lastInboundAt: activity?.lastInboundAt ?? null,
              lastOutboundAt: activity?.lastOutboundAt ?? null,
              lastError: activity?.lastError ?? null,
            };
          })(),
        }
      : {}),
    latestReport: buildLatestView({ report: latest, previous, kpiSlots: member.kpiSlots }),
    reportTimeline: db.listReports(member.id, { limit: 5 }).map(reportTimelineEntry),
    lastTurn: lastTurn
      ? {
          status: lastTurn.status,
          errorKind: lastTurn.errorKind,
          error: lastTurn.error,
          endedAt: lastTurn.endedAt,
          sessionId: lastTurn.sessionId,
          // Timeout/degrade attribution (fix-fleet-turn-attribution): the
          // card renders stalled-vs-budget and the degraded hop verbatim.
          detail: lastTurn.detail ?? null,
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

  // A per-request target resolver: a roster read resolves one target per
  // member across every fleet, and the default resolver re-merges the catalog
  // each time (~30ms × 60 members ≈ 1.8s of blocked event loop — long enough
  // to delay the chat WebSocket handshake in the same cell, measured at
  // 1.2s→3.9s). One view per request means one merge. A test-injected
  // resolver ignores the second argument, so it passes straight through.
  const rosterResolver = () => {
    const view = targetResolver === resolveTarget ? catalog.mergedView() : null;
    return (m) => targetResolver(m, view);
  };

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

  // 迭代回调的默认运输（fleet-owner-iteration）：附体身份=当下决策 req 的
  // cookie 转交。安装/预检 = 同源 /api/packs*/validate；发布 = /api/packs 以
  // 操作者凭据上场 — 两门与人工 UI 上提交逐字节同缝；测试经 ctx 注入替身。
  const defaultInstallFn = () => ctx?.iterationsInstallFn ?? ((packId) => dbModule.getInstalledPack(packId));
  const defaultPublishFn = (req) =>
    ctx?.iterationsPublisher ??
    (async ({ packId, manifest }) => {
      const base = `${req.protocol || "http"}://${req.get("host") ?? "127.0.0.1"}`;
      const r = await fetch(`${base}/api/packs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        },
        body: JSON.stringify({ packId, manifest }),
      });
      const body = await r.json().catch(() => ({}));
      return r.ok ? body : { error: body?.error ?? `HTTP ${r.status}` };
    });
  const defaultValidateFn = (req) =>
    ctx?.iterationsValidator ??
    (async ({ packId, manifest }) => {
      const base = `${req.protocol || "http"}://${req.get("host") ?? "127.0.0.1"}`;
      const r = await fetch(`${base}/api/packs/validate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        },
        body: JSON.stringify({ packId, manifest }),
      });
      const body = await r.json().catch(() => ({}));
      return r.ok ? body : { valid: false, errors: [body?.error ?? `HTTP ${r.status}`] };
    });

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
      // Timeout/degrade/lane attribution (fix-fleet-turn-attribution): the
      // timeline carries the summary verbatim; legacy rows read null.
      detail: event.detail ?? null,
      // fleet-ops-canvas mini span: the client joins this to the trace store
      // for the tool waterfall — without it every non-live span lookup fell
      // through (live-found in production walkthrough 2026-10-27).
      traceTurnId: event.traceTurnId ?? null,
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
      if (status && !["ok", "failed", "interrupted", "skipped"].includes(status)) {
        return res.status(400).json({ error: "status must be one of ok|failed|interrupted|skipped" });
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

  // ── Run read face (agent-fleet-runs, add-fleet-cockpit-v2) ─────────────────
  //
  // The execution instance behind the timeline: paged run list (filters:
  // status / root source / started-at window) and one run's ordered turn
  // detail — the chain (parentTurnId × edgeKind) reconstructs from the rows.
  // System facts only: ids, outcome, timing, usage; no credentials, no
  // session bodies. Owner scope identical to every other fleet read.

  const RUN_STATUSES = ["open", "ok", "failed", "partial"];
  const TURN_SOURCES = ["cron", "manual", "delegation", "event"];

  function runListEntry(run, memberTitles) {
    return {
      runId: run.runId,
      rootSource: run.rootSource,
      rootMemberId: run.rootMemberId,
      rootMemberTitle: memberTitles.get(run.rootMemberId) ?? null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.endedAt != null ? run.endedAt - run.startedAt : null,
      status: run.status,
      turns: run.turns,
      okCount: run.okCount,
      failedCount: run.failedCount,
      usage: run.usage,
    };
  }

  function runTurnEntry(event) {
    return {
      ...turnTimelineEntry(event),
      turnId: event.turnId,
      runId: event.runId,
      parentTurnId: event.parentTurnId,
      edgeKind: event.edgeKind,
      usage: event.usage,
      traceTurnId: event.traceTurnId,
    };
  }

  router.get("/:id/runs", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const status = req.query.status ?? null;
      const source = req.query.source ?? null;
      if (status && !RUN_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${RUN_STATUSES.join("|")}` });
      }
      if (source && !TURN_SOURCES.includes(source)) {
        return res.status(400).json({ error: `source must be one of ${TURN_SOURCES.join("|")}` });
      }
      const parseMs = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };
      const since = parseMs(req.query.since);
      const until = parseMs(req.query.until);
      if ((req.query.since != null && since == null) || (req.query.until != null && until == null)) {
        return res.status(400).json({ error: "since/until must be epoch milliseconds" });
      }
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const db = getFleetDatabase();
      const { total, runs } = db.listRuns(owned.fleet.id, { status, source, since, until, limit, offset });
      const memberTitles = new Map(db.listMembers(owned.fleet.id).map((m) => [m.id, m.title]));
      res.json({ total, runs: runs.map((r) => runListEntry(r, memberTitles)) });
    } catch (err) {
      console.error("[fleets] runs list error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/:id/runs/:runId", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const run = db.getRun(req.params.runId);
      if (!run || run.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Run not found" });
      }
      const memberTitles = new Map(db.listMembers(owned.fleet.id).map((m) => [m.id, m.title]));
      res.json({
        run: runListEntry(run, memberTitles),
        turns: db.listRunTurns(run.runId).map(runTurnEntry),
      });
    } catch (err) {
      console.error("[fleets] run detail error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Design-mode draft lane (agent-fleet-architect v2, add-fleet-cockpit-v2) ─
  //
  // The cockpit's design mode rides the SAME validate/diff/estimate/apply
  // functions the architect tool bridge calls — two doors, one judgment. This
  // door is owner-gated per the fleet face (401 anonymous / 404 unknown /
  // 403 foreign, identical to every other fleet route) and scoped to the
  // design-mode subset: the orchestration section plus per-member cadence /
  // model / fallbackModel edits. Structural moves (add/remove posts, renames,
  // targets, fleet policy) stay on the architect lane — the subset guard
  // rejects them by name so the UI never offers what this door refuses.
  function cockpitDraftSubsetError(draft) {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return "draft must be an object";
    const allowedFleet = new Set(["orchestration"]);
    for (const k of Object.keys(draft.fleet ?? {})) {
      if (!allowedFleet.has(k)) return `fleet.${k} is outside the design-mode subset — the architect lane owns it`;
    }
    const allowedMember = new Set(["ref", "op", "cadence", "model", "fallbackModel"]);
    const members = Array.isArray(draft.members) ? draft.members : [];
    for (const [i, op] of members.entries()) {
      if (op?.op !== "update") {
        return `members[${i}].op '${op?.op ?? "?"}' is outside the design-mode subset — add/pause/resume/remove go through the architect lane`;
      }
      if (typeof op.ref !== "string" || !op.ref) return `members[${i}].ref is required`;
      for (const k of Object.keys(op)) {
        if (!allowedMember.has(k)) return `members[${i}].${k} is outside the design-mode subset`;
      }
    }
    return null;
  }

  const toCockpitDraft = (body, fleetId) => ({ ...(body ?? {}), mode: "edit", fleetId, fleet: { ...(body?.fleet ?? {}) } });

  router.post("/:id/orchestration/draft", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const subset = cockpitDraftSubsetError(req.body);
      if (subset) return res.status(400).json({ error: subset });
      res.json(validateFleetDraft(getFleetDatabase(), toCockpitDraft(req.body, owned.fleet.id), { resolver: rosterResolver() }));
    } catch (err) {
      console.error("[fleets] orchestration draft error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/orchestration/apply", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const subset = cockpitDraftSubsetError(req.body);
      if (subset) return res.status(400).json({ error: subset });
      // Revalidation happens inside (drift fails honestly, same as the bridge).
      const out = await applyFleetDraft(getFleetDatabase(), toCockpitDraft(req.body, owned.fleet.id), {
        ownerEmail: owned.fleet.ownerEmail,
        resolver: rosterResolver(),
      });
      if (!out.ok) return res.status(409).json(out);
      res.json(out);
    } catch (err) {
      console.error("[fleets] orchestration apply error:", err.message);
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
      // Addressing (fix-external-team-chat-lane B1): the caller is a persona
      // that reads a ROSTER — it types a title or a member id, not a database
      // id it cannot see. A title resolves within THIS fleet only; an
      // ambiguous title refuses and lists the candidates (never a guess).
      const resolved = resolveDispatchTarget(db, fleet.id, toRef);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }
      const target = resolved.member;
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
          `【集群派发】来自同集群岗位「${from.title}」的派发(回执将自动送回其下一回合):\n${brief.trim().slice(0, 4000)}`;
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
      // carries the target post + depth 1 for the turn contract. The chain
      // position (agent-fleet-runs) comes from the dispatcher's in-flight turn
      // — looked up by POST, since attribution above is post-level; a dispatch
      // from a non-fleet conversation finds none and the target starts a root
      // run, honestly.
      const prompt = dispatchPrompt;
      const upstream = ctx?.fleetTurnLedger?.lookupByMember?.(from.id) ?? null;
      const chain = ctx?.fleetTurnLedger?.chainFor?.(upstream, "dispatch") ?? null;
      const task = engine.createManualTask({
        prompt,
        ...(target.targetKind === "a2a"
          ? { agent: target.targetId }
          : target.targetKind === "tool"
            ? { tool: target.targetId }
            : { persona: rosterPresetId(target.targetId) }),
        sessionTitle: `派发 · ${target.title}`,
        initiator: chatHistory.currentSessionId(),
        origin: { fleet: { fleetId: fleet.id, memberId: target.id, depth: 1, ...(chain ? { chain } : {}) } },
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

  // Compact per-cell projection of every fleet the caller owns
  // (agent-fleet-cockpit-projection): ONE round-trip the gateway cell sampler
  // folds into cell_fleets events. Same read contracts as the list/cockpit
  // faces — the payload is a bounded VIEW, never raw cockpit trees (50 fleets
  // cap; decision snips ≤80 chars; report snips ≤120; slots ≤4).
  router.get("/overview", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      // Hosted cells are single-owner: anyone but the cell owner (or an admin
      // probing the cell) gets nothing — the sampler carries the cell owner's
      // identity by construction.
      if (ctx?.authEnabled && ctx?.cellUserEmail && user.email !== ctx.cellUserEmail
          && !ctx?.isAdminUser?.(user)) {
        return res.status(403).json({ error: "Admin group or cell ownership required" });
      }
      const db = getFleetDatabase();
      const clip = (s, n) =>
        typeof s === "string" ? (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s) : (s ?? null);
      // One catalog merge + one job list for the whole projection: this route
      // walks every member of every fleet (the cell reporter samples it on a
      // timer), so a per-member merge dominated its cost.
      const resolveMember = rosterResolver();
      const jobs = cron.listJobs();
      const model = modelCtx();
      const fleets = db
        .listFleets({ ownerEmail: user.email })
        .slice(0, 50)
        .map((fleet) => {
          db.expireOpenDecisions(fleet.id);
          const tasks = taskIndexFor(fleet.id, jobs);
          const members = db.listMembers(fleet.id).map((m) =>
            memberView(db, fleet, m, tasks, { resolver: resolveMember, model }),
          );
          const counts = { onDuty: 0, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0 };
          for (const v of members) {
            const k = v.status === "on_duty" ? "onDuty" : v.status;
            if (k in counts) counts[k] += 1;
          }
          // Decisions: open, severity first then closest to policy expiry —
          // the cockpit's ordering, verbatim.
          const policy = fleet.decisionPolicy ?? { expiryHours: 72 };
          const expiryMs = policy.expiryHours > 0 ? policy.expiryHours * 3600_000 : null;
          const decisions = db
            .listDecisions({ fleetId: fleet.id, state: "open" })
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
          const stream = members.map((m) => {
            const latest = m.latestReport;
            const metrics = {};
            for (const s of (latest?.slots ?? []).slice(0, 4)) {
              metrics[s.key] = clip(String(s.value), 24);
            }
            return {
              title: m.title,
              status: m.status,
              reasonSnip: m.statusReason ? clip(m.statusReason, 80) : null,
              at: latest?.at ?? null,
              source: latest?.source ?? null,
              metrics,
              summarySnip: latest?.summary ? clip(latest.summary, 120) : null,
            };
          });
          return {
            id: fleet.id,
            name: clip(fleet.name, 60),
            state: fleet.state,
            counts: { ...counts, total: members.length },
            openDecisions: {
              count: decisions.length,
              top: decisions.slice(0, 3).map((d) => ({
                question: clip(d.question, 80),
                severity: d.severity,
                expiresAt: d.expiresAt,
                memberTitle: d.memberTitle,
              })),
            },
            stream,
          };
        });
      res.json({ v: 1, sampledAt: Date.now(), fleets });
    } catch (err) {
      console.error("[fleets] overview error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── 主人经营坞总览 (fleet-owner-surface A/B/C) ────────────────────────────
  // 一屏读面: 集群清单+聚合状态+异常告警计数+花销(a)投影, 与 overview/cockpit
  // 契约同源重算 (不另造状态机)。仅自有组织的集群 (与 list 面同一 scope)。
  router.get("/owner/board", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      // One catalog merge + one job list for the whole board (same roster
      // shape as the list route — this face walks every member too).
      const resolveMember = rosterResolver();
      const jobs = cron.listJobs();
      const model = modelCtx();
      const fleets = db.listFleets({ ownerEmail: user.email }).map((fleet) => {
        db.expireOpenDecisions(fleet.id);
        const tasks = taskIndexFor(fleet.id, jobs);
        const members = db.listMembers(fleet.id).map((m) =>
          memberView(db, fleet, m, tasks, { resolver: resolveMember, model }),
        );
        const counts = { onDuty: 0, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0 };
        for (const v of members) {
          const k = v.status === "on_duty" ? "onDuty" : v.status;
          if (k in counts) counts[k] += 1;
        }
        const openDecisions = db.listDecisions({ fleetId: fleet.id, state: "open" }).length;
        const policy = fleet.decisionPolicy ?? { expiryHours: 72 };
        const lastActivity = Math.max(
          0,
          ...members.map((m) => m.latestReport?.at ?? 0),
        );
        return {
          id: fleet.id,
          name: fleet.name,
          state: fleet.state,
          sourceTemplate: fleet.sourceTemplate ?? null,
          counts: { ...counts, total: members.length },
          // 告警入口的两个聚合 — 坞面行直达对应面 (decisions / failing)。
          openDecisions,
          failing: counts.failing,
          decisionPolicy: policy,
          lastActivityAt: lastActivity || null,
          spend: db.spendProjection(fleet.id),
        };
      });
      res.json({ v: 1, sampledAt: Date.now(), fleets });
    } catch (err) {
      console.error("[fleets] owner-board error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 花销读数(a) — 单集群的回合/token 事实投影 (fleet-owner-surface C)。
  router.get("/:id/spend", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      res.json({ fleetId: owned.fleet.id, ...db.spendProjection(owned.fleet.id) });
    } catch (err) {
      console.error("[fleets] spend error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── 迭代回路 (fleet-owner-iteration) ─────────────────────────────────────
  // 提议入口: 配置改动主张 → 决策车道（批准前零生效）。
  router.post("/:id/iterations/propose", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const out = createConfigChangeProposal({
        db,
        fleet: owned.fleet,
        ownerEmail: owned.user.email,
        changeDoc: req.body ?? {},
      });
      if (!out.ok) return res.status(400).json({ error: out.error });
      res.status(201).json(out);
    } catch (err) {
      console.error("[fleets] propose error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/:id/iterations", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      res.json({ iterations: getFleetDatabase().listIterations(owned.fleet.id) });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 从失败环重试: 不重跑整链 (published = 幂等返回)。
  router.post("/:id/iterations/:itId/retry", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const out = await retryIterationCast({
        db: getFleetDatabase(),
        iterationId: req.params.itId,
        ownerEmail: owned.user.email,
        installFn: defaultInstallFn(),
        publishFn: defaultPublishFn(req),
        validateFn: defaultValidateFn(req),
        log: console,
      });
      if (!out.ok && !out.already) return res.status(out.error?.includes("not approved") ? 409 : 502).json({ error: out.error ?? "retry failed", iteration: out.iteration ?? null });
      res.json(out);
    } catch (err) {
      console.error("[fleets] iteration retry error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Digest 订阅 (fleet-owner-iteration) ──────────────────────────────────
  const DIGEST_KINDS = new Set(["daily", "weekly"]);
  router.post("/:id/digest-subscribe", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const cadence = String(req.body?.cadence ?? "");
      if (!DIGEST_KINDS.has(cadence)) return res.status(400).json({ error: "cadence must be daily|weekly" });
      const row = getFleetDatabase().upsertDigestSub({ id: `dg_${Math.random().toString(36).slice(2, 10)}`, fleetId: owned.fleet.id, ownerEmail: owned.user.email, cadence });
      res.status(201).json({ subscription: row });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.delete("/:id/digest-subscribe/:cadence", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      getFleetDatabase().removeDigestSub(owned.fleet.id, owned.user.email, req.params.cadence);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/owner/digest-subscriptions", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const names = Object.fromEntries(db.listFleets({ ownerEmail: user.email }).map((f) => [f.id, f.name]));
      res.json({
        subscriptions: db.listDigestSubscriptions({ ownerEmail: user.email }).map((s) => ({ ...s, fleetName: names[s.fleetId] ?? null })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

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
      const resolveMember = rosterResolver();
      const tasks = taskIndexFor(owned.fleet.id);
      const model = modelCtx();
      const members = db.listMembers(owned.fleet.id).map((m) =>
        memberView(db, owned.fleet, m, tasks, { resolver: resolveMember, model }),
      );
      const statusCounts = {};
      for (const v of members) statusCounts[v.status] = (statusCounts[v.status] ?? 0) + 1;
      // Failure dimension: derived from the STATUS now (fix-fleet-failure-
      // visibility D5). The old "latest turn !== ok" reading missed the case
      // that matters most — a post that failed many rounds but happened to
      // succeed last — and let `normal` count downgraded posts.
      const failing = statusCounts.failing ?? 0;

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
        // Edge traffic (agent-fleet-runs): hops in the last 24h grouped by
        // (from post, to post, edge kind) with the outcome split — the canvas
        // weighs edges by it. Pre-v2 rows carry no chain and simply do not
        // appear (honest absence, not a zero).
        edgeTraffic: db.edgeTraffic(owned.fleet.id),
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
        // 参数槽（agent-fleet-templates delta）：向导提供的值；必填缺失/
        // 类型不符 → params-invalid 422 指名缺失槽，零实化痕迹。
        params: req.body?.params && typeof req.body.params === "object" && !Array.isArray(req.body.params) ? req.body.params : null,
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
      if (!out.ok) {
        // params-invalid 是 422 口径（参数不合 ≠ 请求畸形），其余与既往一致。
        if (out.code === "params-invalid") {
          return res.status(422).json({ error: out.error, code: "params-invalid", errors: out.errors ?? [] });
        }
        return res.status(400).json({ error: out.error });
      }
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
      // 防洪口径改为升级流水（add-deputy-decision-delegate）：归并不落新行，
      // 但每次 escalate 都是一次升级事件——上限必须把归并也算进去，否则重复
      // 升级绕开防洪。
      const dailyCount = db.countEscalationsByMemberSince(member.id, dayStart.getTime());
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

      // 归并检查 (design D5)：同岗位近 7 天的相似 open 项——topicKey 精确命中
      // 或问题归一化文本相同。归并 = 既有项升级次数 +1（审计流水记 merged），
      // 不落新行。不跨岗位、不改问题文本与过期基准。
      const dedupeWindowStart = now - 7 * 86_400_000;
      const similar = db.findSimilarOpenDecision({
        memberId: member.id,
        topicKey: payload.item.topicKey,
        question: payload.item.question,
        sinceMs: dedupeWindowStart,
      });
      if (similar) {
        const mergedItem = db.mergeDecisionEscalation(similar.id, { now, sessionId });
        db.recordEscalation({
          id: `e_${now}_${Math.random().toString(36).slice(2, 8)}`,
          fleetId: fleet.id,
          memberId: member.id,
          decisionId: similar.id,
          merged: 1,
          sourceSessionId: sessionId,
          now,
        });
        return res.status(200).json({
          ok: true,
          merged: true,
          itemId: mergedItem?.id ?? similar.id,
          escalations: mergedItem?.escalations ?? (similar.escalations ?? 0) + 1,
          memberTitle: member.title,
          note: "an open item for this topic already exists — this escalation was merged into it",
        });
      }

      // 委托路由 (design D2/D3)：escalate 时按当次生效策略同步打 route——
      // 规则先行（确定性、可解释），deputy 不参与路由。
      const delegationPolicy = db.getFleetDelegationPolicy(fleet.id);
      const route = routeForItem(
        { category: payload.item.category, itemType: payload.item.itemType, severity: payload.item.severity },
        delegationPolicy,
      );

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
        route,
        category: payload.item.category,
        topicKey: payload.item.topicKey,
      });
      db.recordEscalation({
        id: `e_${now}_${Math.random().toString(36).slice(2, 8)}`,
        fleetId: fleet.id,
        memberId: member.id,
        decisionId: item.id,
        merged: 0,
        sourceSessionId: sessionId,
        now,
      });
      // Best-effort out-of-band ping seam (WeChat envelope et al.): mounted
      // by the deployment when a provider exists; absent = in-app badge only.
      try {
        ctx?.fleetDecisionNotifier?.(fleet, item, member);
      } catch { /* best-effort by contract */ }
      // Fleet working memory (add-zhiyu-team-memory): the decision opening is
      // a team fact. Fire-and-forget; capture never surfaces into the path.
      try {
        ctx?.captureFleetFact?.(fleet.id, member.id, "decision-opened", item.question, `严重度 ${item.severity}${route ? `，路由 ${route}` : ""}`);
      } catch { /* capture never surfaces */ }
      res.status(201).json({
        ok: true,
        itemId: item.id,
        memberTitle: member.title,
        queuePosition: openCount + 1,
        dailyRemaining: cap - dailyCount - 1,
        route,
      });
    } catch (err) {
      console.error("[fleets] escalate error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Deputy bridge (add-deputy-decision-delegate) ──────────────────────────
  //
  // 常务岗的工具面（fleet MCP → bridge）：身份归因与 escalate 同构
  // （currentPreset → 岗位），服务端强制授权在这里逐项执行——**闸在代码不在
  // 提示词**。所有路由都要求：归因成功、归因岗位 = 舰队策略的 deputyMemberId。

  // 校验归因岗位是否为本舰队委托策略的 deputy。返回 { fleet, deputy, policy }
  // 或 { error }。
  function deputyGuard({ db, attribution }) {
    if (attribution.kind === "none" || attribution.kind === "ambiguous") {
      return { error: attribution.error || "deputy identity could not be attributed", status: 409 };
    }
    const deputy = db.getMember(attribution.memberId);
    if (!deputy) return { error: "the attributed post no longer exists", status: 409 };
    const fleet = db.getFleet(deputy.fleetId);
    if (!fleet) return { error: "the deputy's fleet no longer exists", status: 409 };
    const policy = db.getFleetDelegationPolicy(fleet.id);
    if (!policy.enabled || policy.deputyMemberId !== deputy.id) {
      return { error: "this post is not the fleet's delegated deputy", status: 403 };
    }
    return { fleet, deputy, policy };
  }

  // 策略里的「裁决所用模型」落到常务岗这个岗位的 model 字段上——策略是声明，
  // 岗位 model 才是回合实际解析链的第一跳（fleetModelFor → resolveModelChain）。
  // 不这样做 policy.model 就是一只没接线的旋钮：存了、看得见、不影响任何行为。
  // 声明为空则清掉岗位 model，回到继承（舰队默认 → cell 默认）。
  function applyDeputyModel(db, fleetId, policy) {
    const deputyId = policy?.deputyMemberId;
    if (!deputyId) return null;
    const member = db.getMember(deputyId);
    if (!member || member.fleetId !== fleetId) return null;
    const next = typeof policy.model === "string" && policy.model ? policy.model : null;
    if ((member.model ?? null) === next) return member;
    db.updateMember(deputyId, { model: next });
    return db.getMember(deputyId);
  }

  // Deputy 队列：route=deputy 的 open 项 + 每项的来源岗位上下文（标题/状态/
  // 近期报数摘要）与主人过往同类判例（resolved_by=owner 的历史裁决）。
  router.post("/deputy/queue", async (_req, res) => {
    try {
      const db = getFleetDatabase();
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
      const guard = deputyGuard({ db, attribution });
      if (guard.error) return res.status(guard.status).json({ error: guard.error });
      const { fleet, policy } = guard;
      db.expireOpenDecisions(fleet.id, { now: Date.now() });
      const items = db.listDecisions({ fleetId: fleet.id, state: "open", route: "deputy" });
      const memberOf = (id) => db.getMember(id);
      const queue = items.map((item) => {
        const m = memberOf(item.memberId);
        const recent = m ? db.listReports(m.id, { limit: 1 }) : [];
        // 判例：主人过往对同一岗位/同类别的裁决（resolved_by=owner）。
        const precedents = db
          .listDecisions({ fleetId: fleet.id, memberId: item.memberId })
          .filter((d) => d.resolvedBy === "owner" && d.state === "delivered")
          .slice(0, 3)
          .map((d) => ({ id: d.id, question: d.question, resolution: d.resolution, resolvedAt: d.resolvedAt }));
        return {
          id: item.id,
          question: item.question,
          options: item.options,
          severity: item.severity,
          category: item.category,
          submittedAt: item.submittedAt,
          escalations: item.escalations ?? 0,
          member: m ? { id: m.id, title: m.title, status: m.status ?? null } : { id: item.memberId, title: null },
          recentReport: recent[0]?.summary?.slice(0, 300) ?? null,
          precedents,
        };
      });
      res.json({
        fleet: { id: fleet.id, name: fleet.name },
        policy: { maxSeverity: policy.maxSeverity, dailyBudget: policy.dailyBudget, routes: policy.routes },
        queue,
      });
    } catch (err) {
      console.error("[fleets] deputy queue error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Deputy 裁决：approve/reject + 依据。强制授权逐项校验——顺序：deputy 身份
  // → 条目 route=deputy → 类别硬闸 → severity 上限 → 日预算。裁决落
  // resolved_by=deputy + 模型 + 依据，走既有 approved/rejected 管线送达。
  router.post("/deputy/resolve", async (req, res) => {
    try {
      const db = getFleetDatabase();
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
      const guard = deputyGuard({ db, attribution });
      if (guard.error) return res.status(guard.status).json({ error: guard.error });
      const { fleet, deputy, policy } = guard;

      const { itemId, kind, choice, note, evidence } = req.body ?? {};
      if (!["approve", "reject"].includes(kind)) {
        return res.status(400).json({ error: "kind must be approve or reject (amend is owner-only)" });
      }
      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open") return res.status(409).json({ error: `already ${item.state}` });
      if (item.route !== "deputy") {
        return res.status(403).json({ error: "beyond delegation mandate — this item is routed to the owner" });
      }
      const category = item.category ?? "routine-ops";
      const route = policy.routes[category] ?? policy.routes.default;
      if (route !== "deputy") {
        return res.status(403).json({ error: `beyond delegation mandate — category '${category}' is routed to ${route}` });
      }
      if ((SEVERITY_RANK[item.severity] ?? 1) > (SEVERITY_RANK[policy.maxSeverity] ?? 1)) {
        return res.status(403).json({ error: `beyond delegation mandate — severity ${item.severity} exceeds the policy cap (${policy.maxSeverity})` });
      }
      const dayStart = new Date(Date.now());
      dayStart.setHours(0, 0, 0, 0);
      const ruled = db
        .listDecisions({ fleetId: fleet.id })
        .filter((d) => d.resolvedBy === "deputy" && (d.resolvedAt ?? 0) > dayStart.getTime()).length;
      if (ruled >= policy.dailyBudget) {
        return res.status(429).json({ error: `deputy daily ruling budget reached (${policy.dailyBudget}/day) — remaining items roll to the owner` });
      }
      const resolution = validateResolution(kind, { choice, note }, item);
      if (!resolution.ok) return res.status(400).json({ error: resolution.error });
      resolution.resolution.by = `deputy:${deputy.title ?? deputy.id}`;
      resolution.resolution.at = Date.now();

      // 裁决所用模型 SHALL 由服务端取（spec「裁决携带身份与依据」）：读本回合
      // 子进程自己发出的 request/header，而不是请求体自报，也不是声明的
      // 模型链（后者会 out-of-band 漂移）。取不到就如实留空，不猜。
      const rulingModel = ctx?.fleetTurnLedger?.observedModelFor?.(deputy.id) ?? null;

      const updated = db.transitionDecision(itemId, "open", {
        state: kind === "reject" ? "rejected" : "approved",
        resolution: resolution.resolution,
        resolvedAt: Date.now(),
        resolvedBy: "deputy",
        resolvedByModel: rulingModel ? String(rulingModel).slice(0, 120) : null,
        rulingEvidence: typeof evidence === "string" ? evidence.slice(0, 2000) : null,
      });
      if (!updated) return res.status(409).json({ error: "first resolution wins — another decision just landed" });
      // 记忆镜像 (design D7 写侧)：代理裁决即时进主人记忆 reference 层——
      // 主人能在记忆里查证"常务岗判了什么、依据是什么"。fire-and-forget，
      // 失败降级不影响裁决本身（裁决已落审计）。
      try {
        const ownerEmail = fleet.ownerEmail ?? fleet.owner_email ?? null;
        if (ownerEmail) {
          const cli = await memoryRefClientFor(process.env, ownerEmail).catch(() => null);
          if (cli) {
            const label = item.options.find((o) => o.value === choice)?.label ?? choice ?? "";
            cli.writeReference({
              title: `常务岗裁决 · ${updated.memberId} · ${kind === "reject" ? "驳回" : "批准"}`,
              summary: `${String(item.question).slice(0, 120)} → ${kind === "reject" ? "驳回" : label}${evidence ? `（依据：${String(evidence).slice(0, 120)}）` : ""}`,
              source_ref: `decision:${fleet.id}:${item.id}`,
              slug: memoryRefSlug(`deputy-ruling-${item.id}`),
              tier: "draft",
            }).catch((e) => console.warn(`[fleet-memory] deputy ruling mirror failed (degrade open): ${e?.message || e}`));
          }
        }
      } catch (e) {
        console.warn(`[fleet-memory] deputy ruling mirror failed (degrade open): ${e?.message || e}`);
      }
      res.json({ ok: true, decision: updated });
    } catch (err) {
      console.error("[fleets] deputy resolve error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Deputy 上报：判不了的条目转路由 owner 并携带分析——强判比不判糟。
  router.post("/deputy/escalate-to-owner", async (req, res) => {
    try {
      const db = getFleetDatabase();
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
      const guard = deputyGuard({ db, attribution });
      if (guard.error) return res.status(guard.status).json({ error: guard.error });
      const { fleet } = guard;
      const { itemId, analysis } = req.body ?? {};
      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open" || item.route !== "deputy") {
        return res.status(409).json({ error: "only open deputy-routed items can be escalated to the owner" });
      }
      const detail = {
        ...(item.detail ?? {}),
        deputyAnalysis: {
          at: Date.now(),
          analysis: typeof analysis === "string" ? analysis.slice(0, 2000) : null,
        },
      };
      const updated = db.transitionDecision(itemId, "open", { detail });
      if (!updated) return res.status(409).json({ error: "concurrent change — reload and retry" });
      const routed = db.setDecisionRoute(itemId, "owner");
      res.json({ ok: true, decision: routed ?? updated });
    } catch (err) {
      console.error("[fleets] deputy escalate-to-owner error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 存量 triage (design D5 / 角标口径迁移)：发布委托功能时对既有 open 项做
  // 一次性重路由——按当次策略给每项算 route，并把同岗位同主题的重复项归并
  // 到最早一条。幂等：第二次调用不再产生变化（已归并的项 escalations>0 且
  // 状态不变，已路由的项 route 相同）。
  //
  // 返回 {scanned, rerouted, merged}。
  router.post("/:id/decisions/triage", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const fleet = owned.fleet;
      const policy = db.getFleetDelegationPolicy(fleet.id);
      const open = db.listDecisions({ fleetId: fleet.id, state: "open" });
      let rerouted = 0;
      let merged = 0;
      const seen = new Map(); // `${memberId}::${topic}` -> 最早条目
      // 按提交时间升序：最早的条目是归并的落点。
      for (const item of [...open].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0))) {
        const route = routeForItem(
          { category: item.category, itemType: item.itemType, severity: item.severity },
          policy,
        );
        if (route !== item.route) {
          db.setDecisionRoute(item.id, route);
          rerouted += 1;
        }
        // 归并键：优先提交方声明的 topicKey，否则问题归一化文本。
        const key = `${item.memberId}::${item.topicKey ?? normalizeQuestion(item.question) ?? item.id}`;
        const first = seen.get(key);
        if (!first) {
          seen.set(key, item.id);
          continue;
        }
        const mergedItem = db.mergeDecisionEscalation(first, { now: Date.now() });
        if (mergedItem) {
          db.transitionDecision(item.id, "open", {
            state: "expired",
            resolution: { kind: "dedup", note: `merged into ${first}`, by: null, at: Date.now() },
          });
          merged += 1;
        }
      }
      res.json({ scanned: open.length, rerouted, merged, policy });
    } catch (err) {
      console.error("[fleets] decision triage error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 主人收回委托：route=deputy 的 open 条目转回 owner（design：主人可随时
  // 收回；deputy 队列随之移除）。
  router.post("/:id/decisions/:itemId/recall", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const item = db.getDecision(req.params.itemId);
      if (!item || item.fleetId !== owned.fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open" || item.route !== "deputy") {
        return res.status(409).json({ error: "only open deputy-routed items can be recalled" });
      }
      const updated = db.setDecisionRoute(item.id, "owner");
      res.json({ decision: updated });
    } catch (err) {
      console.error("[fleets] decision recall error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 委托策略设置面 (design：cell 默认 + 舰队覆写)。读 = 生效合并结果（+
  // cell 默认与覆写原文）；写 = 各自一路。高风险类别（config-change/hr/spend）
  // 的委托路由 SHALL 被归一化硬闸覆盖——写进来也会被归一成 owner。
  router.get("/delegation-policy", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const cellDefault = db.getCellSetting("delegationPolicy");
      const fleetId = req.query.fleetId ? String(req.query.fleetId) : null;
      const override = fleetId ? db.getFleetDelegationPolicyRaw(fleetId) : null;
      const effective = fleetId ? db.getFleetDelegationPolicy(fleetId) : normalizeDelegationPolicy(cellDefault, null);
      res.json({ cellDefault: cellDefault ?? null, override, effective });
    } catch (err) {
      console.error("[fleets] delegation policy read error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.put("/delegation-policy", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const body = req.body ?? {};
      // 归一化即硬闸：routes 里的 config-change/hr/spend 会被强制归一为 owner
      // （normalizeRoutes），无需在此逐项拒绝。
      const scope = body.scope === "fleet" && body.fleetId ? "fleet" : "cell";
      if (scope === "cell") {
        db.setCellSetting("delegationPolicy", body.policy ?? null);
      } else {
        db.setFleetDelegationPolicy(body.fleetId, body.policy ?? null);
        // 裁决所用模型是声明，真正的生效点是常务岗岗位的 model——
        // 策略写入即同步（写空 = 回到继承链）。
        applyDeputyModel(db, body.fleetId, db.getFleetDelegationPolicy(body.fleetId));
      }
      const effective = body.fleetId
        ? db.getFleetDelegationPolicy(body.fleetId)
        : normalizeDelegationPolicy(scope === "cell" ? db.getCellSetting("delegationPolicy") : null, null);
      res.json({ ok: true, scope, effective });
    } catch (err) {
      console.error("[fleets] delegation policy write error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 常务岗设立：两种形态——指定既有 persona 岗位，或（不传 memberId 而传
  // targetId）新建一个专属常务岗。两种都设策略 deputyMemberId + 挂巡逻节奏
  // 与职责提示。已存在 cadence 的岗位 SHALL NOT 被静默改写（显式传 cadence
  // 才覆盖）。
  router.post("/:id/deputy", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      // 新建路径：没有 memberId 但有 targetId（一个 persona 预设 id）。
      if (!req.body?.memberId && typeof req.body?.targetId === "string" && req.body.targetId) {
        if (owned.fleet.state === "archived") {
          return res.status(409).json({ error: "This fleet is archived — no new posts" });
        }
        const targetId = req.body.targetId;
        if (!targetResolver({ targetKind: "persona", targetId }).alive) {
          return res.status(400).json({ error: invalidTargetMessage("persona", targetId) });
        }
        if (db.findPostByTarget("persona", targetId)) {
          return res.status(409).json({ error: "that persona already holds a post — designate it with memberId instead" });
        }
        // 注意：本路由下方声明了 const memberId（请求体字段），会遮蔽模块级
        // 的 memberId() 造号函数——这里直接内联同一造号模式。
        const created = db.createMember({
          id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          fleetId: owned.fleet.id,
          title: typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 40) : "常务",
          targetKind: "persona",
          targetId,
          cadence: {
            cron: "0 * * * *",
            tz: req.body?.tz ?? "Asia/Shanghai",
            enabled: true,
            promptTemplate: DEPUTY_PROMPT,
            ...(req.body?.cadence ?? {}),
          },
        });
        const policy = db.getFleetDelegationPolicy(owned.fleet.id);
        db.setFleetDelegationPolicy(owned.fleet.id, { ...policy, enabled: true, deputyMemberId: created.id });
        applyDeputyModel(db, owned.fleet.id, db.getFleetDelegationPolicy(owned.fleet.id));
        const reconcile = await reconcileFleet({
          fleetId: owned.fleet.id,
          db,
          cronApi: cron,
          resolveTarget: targetResolver,
          rosterPresetId,
        });
        return res.status(201).json({
          fleet: db.getFleet(owned.fleet.id),
          member: db.getMember(created.id),
          delegationPolicy: db.getFleetDelegationPolicy(owned.fleet.id),
          reconcile,
        });
      }
      const memberId = req.body?.memberId;
      const member = memberId ? db.getMember(memberId) : null;
      if (!member || member.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Member not found in this fleet" });
      }
      if (member.targetKind !== "persona") {
        return res.status(400).json({ error: "the deputy must be a persona post" });
      }
      const cadence = req.body?.cadence ?? member.cadence ?? null;
      // 提示词三级：显式传值 > 显式 resetPrompt（升到当前版本的 DEPUTY_PROMPT）
      // > 岗位既有值 > 当前版本。resetPrompt 是存量岗位的升级通道——没有它，
      // 服务端改了职责提示词，已建成的常务岗永远拿不到（它的 cadence 是副本），
      // 只能改库；而「重新指定一次」按旧值兜底，形同没刷。
      const promptTemplate =
        typeof req.body?.promptTemplate === "string" && req.body.promptTemplate.trim()
          ? req.body.promptTemplate.trim()
          : req.body?.resetPrompt === true
            ? DEPUTY_PROMPT
            : member.cadence?.promptTemplate ?? DEPUTY_PROMPT;
      if (cadence && typeof cadence.cron === "string" && cadence.cron.trim()) {
        db.updateMember(member.id, { cadence: { ...cadence, promptTemplate } });
      }
      const policy = db.getFleetDelegationPolicy(owned.fleet.id);
      db.setFleetDelegationPolicy(owned.fleet.id, { ...policy, enabled: true, deputyMemberId: member.id });
      applyDeputyModel(db, owned.fleet.id, db.getFleetDelegationPolicy(owned.fleet.id));
      const reconcile = await reconcileFleet({
        fleetId: owned.fleet.id,
        db,
        cronApi: cron,
        resolveTarget: targetResolver,
        rosterPresetId,
      });
      res.json({
        fleet: db.getFleet(owned.fleet.id),
        member: db.getMember(member.id),
        delegationPolicy: db.getFleetDelegationPolicy(owned.fleet.id),
        reconcile,
      });
    } catch (err) {
      console.error("[fleets] designate deputy error:", err.message);
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
        // 委托分视 (add-deputy-decision-delegate)：主人视图与常务岗视图各自
        // 计数——角标口径是 route=owner，deputy 队列另计。
        ownerOpenCount: db.countOwnerOpenDecisions(owned.fleet.id),
        deputyOpenCount: db.countDeputyOpenDecisions(owned.fleet.id),
        decisionPolicy: owned.fleet.decisionPolicy,
        delegationPolicy: db.getFleetDelegationPolicy(owned.fleet.id),
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
        // 拍板送达即落记忆名份（add-unified-memory-and-outputs 4.2）：交付物是
        // 「做过什么」的最强信号，进 owner 记忆的 reference 页（草稿层，fire-and-forget）。
        {
          const ownerEmail = fleet.ownerEmail ?? fleet.owner_email ?? null;
          const seg = renderDecisionSegment(deliverable);
          if (ownerEmail && seg) {
            const cli = await memoryRefClientFor(process.env, ownerEmail).catch(() => null);
            if (cli) {
              const refId = `deliv-${fleet.id}-${item.memberId}-${item.id}`;
              cli.writeReference({
                title: `拍板送达 · ${member?.title ?? item.memberTitle ?? item.memberId}`,
                summary: String(seg).replace(/\s+/g, " ").slice(0, 200),
                source_ref: `deliverable:${fleet.id}:${item.memberId}:${item.id}`,
                slug: memoryRefSlug(refId),
                tier: "draft",
              }).catch((e) => console.warn(`[fleet-memory] deliverable mirror failed (degrade open): ${e?.message || e}`));
            }
          }
        }
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
        resolvedBy: "owner",
      });
      if (!updated) {
        return res.status(409).json({ error: "first resolution wins — another decision just landed" });
      }
      // 迭代回路回调 (fleet-owner-iteration): approved 的 config-change 拍板项
      // 触发铸版链——结论先行落审计, 链在后台写轴迭代行, 链路失败不翻盘。
      // 结果随响应附在 iteration 键下 (additive, 既有响应语义逐字节)。
      let iteration = null;
      if (op === "approve" && (updated.itemType === "config-change" || item?.itemType === "config-change")) {
        try {
          const fleet = owned.fleet;
          const it = (db.listIterations(fleet.id) ?? []).find((x) => x.decisionId === updated.id) ?? null;
          if (it) {
            iteration = await runIterationCast({
              db,
              iteration: it,
              ownerEmail: owned.user.email,
              installFn: defaultInstallFn(),
              publishFn: defaultPublishFn(req),
              validateFn: defaultValidateFn(req),
              log: console,
            });
          }
        } catch (e) {
          console.warn(`[fleets] iteration cast callback failed (decision kept): ${e?.message || e}`);
        }
      }
      // Fleet working memory (add-zhiyu-team-memory): the ruling is a team
      // fact — the digest lets every member see what the owner decided.
      try {
        ctx?.captureFleetFact?.(owned.fleet.id, updated.memberId, "decision-resolved", updated.question, `${op === "reject" ? "驳回" : "批准"}：${String(resolution.resolution?.detail ?? resolution.resolution?.choice ?? "").slice(0, 200)}（裁决者 ${owned.user.email}）`);
      } catch { /* capture never surfaces */ }
      res.json(iteration ? { decision: updated, iteration } : { decision: updated });
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
      // One request, one snapshot of everything the roster read touches:
      // the catalog (merged once — see rosterResolver), the cron job list, and
      // the model roster. Previously each of the 60 members re-merged the
      // catalog and re-listed every cron job, so one roster read blocked the
      // cell's event loop for ~2.8s — long enough to delay the chat WebSocket
      // handshake that carries the transcript.
      const resolveMember = rosterResolver();
      const jobs = cron.listJobs();
      const model = modelCtx();
      const fleets = db
        .listFleets({ ownerEmail: user.email })
        .map((fleet) => {
          const members = db.listMembers(fleet.id);
          const tasks = taskIndexFor(fleet.id, jobs);
          const counts = {};
          for (const m of members) {
            const view = memberView(db, fleet, m, tasks, { resolver: resolveMember, model });
            counts[view.status] = (counts[view.status] ?? 0) + 1;
          }
          return {
            id: fleet.id,
            name: fleet.name,
            state: fleet.state,
            memberCount: members.length,
            statusCounts: counts,
            // Row-level quick-edit fields (agent-teams-management D4): the
            // three inline-editable fields ride the list so the management
            // view never needs a per-row detail round-trip. Absent = null.
            defaultModel: fleet.defaultModel ?? null,
            effort: fleet.effort ?? null,
            contextBudget: fleet.contextBudget ?? null,
            // Spend projection mirrors owner/board (same source of truth).
            spend: db.spendProjection(fleet.id),
            // The pending-decision count the nav badge reads (add-fleet-decision-lane
            // 刀3): the badge is derived from this list, so the number has to
            // ride here — a badge computed from a field the list never carried
            // is a badge that can never appear.
            // 角标口径 (add-deputy-decision-delegate)：「等你 N 件」只计
            // route=owner——委托给常务岗的不再算主人头上。
            openDecisions: db.countOwnerOpenDecisions(fleet.id),
            deputyOpen: db.countDeputyOpenDecisions(fleet.id),
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

  // ── 批量动作（agent-teams-management D3）：逐条执行既有单团队语义、逐条回执 ──
  // pause/resume/archive share the PATCH /:id state semantics verbatim
  // (FLEET_STATES gate, archived-is-terminal 409 → per-item error). Any single
  // failure MUST NOT stop the rest; a shape-valid request answers 200 with
  // per-item results — partial failure is a business result, not a request
  // error. Foreign/unknown ids answer "not found" (probing teaches nothing).
  const FLEET_BATCH_MAX = Number(process.env.FLEET_BATCH_MAX || 50);
  const FLEET_BATCH_ACTIONS = { pause: "paused", resume: "active", archive: "archived" };

  router.post("/batch", async (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const action = req.body?.action;
      const ids = req.body?.ids;
      if (!FLEET_BATCH_ACTIONS[action]) {
        return res.status(400).json({ error: `action must be one of ${Object.keys(FLEET_BATCH_ACTIONS).join(", ")}` });
      }
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.trim())) {
        return res.status(400).json({ error: "ids must be a non-empty array of fleet ids" });
      }
      // Dedupe preserving order — a repeated id executes once.
      const unique = [...new Set(ids)];
      if (unique.length > FLEET_BATCH_MAX) {
        return res.status(400).json({
          error: `batch limited to ${FLEET_BATCH_MAX} fleets per call (got ${unique.length})`,
          code: "batch_limit_exceeded",
        });
      }
      const db = getFleetDatabase();
      const targetState = FLEET_BATCH_ACTIONS[action];
      const results = [];
      for (const id of unique) {
        const fleet = db.getFleet(id);
        if (!fleet || fleet.ownerEmail !== user.email) {
          results.push({ id, ok: false, error: "not found" });
          continue;
        }
        if (fleet.state === "archived") {
          results.push({ id, ok: false, error: "This fleet is archived — archived is terminal" });
          continue;
        }
        try {
          db.updateFleet(fleet.id, { state: targetState }, auditMeta(req, `POST /api/fleets/batch ${action}`));
          await runReconcile(fleet.id);
          results.push({ id, ok: true, state: targetState });
        } catch (err) {
          results.push({ id, ok: false, error: err.message || "internal error" });
        }
      }
      const summary = {
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
      res.json({ action, results, summary });
    } catch (err) {
      console.error("[fleets] batch error:", err.message);
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
      const resolveMember = rosterResolver();
      const model = modelCtx();
      const views = members.map((m) => memberView(db, owned.fleet, m, tasks, { resolver: resolveMember, model }));
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
      const { name, state, defaultModel, effort, contextBudget } = req.body ?? {};
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

      // Config dimensions at fleet level (add-agent-config-dims D4): the fleet
      // default an undeclared post inherits. Same shape gate as the post PATCH.
      const dims = validateConfigDims({ effort, contextBudget }, effortUnionFrom(ctx?.dshModels));
      if (dims.error) return res.status(400).json({ error: dims.error });
      if (effort !== undefined) updates.effort = dims.effort;
      if (contextBudget !== undefined) updates.contextBudget = dims.contextBudget;

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
      const { title, parentId, cadence, kpiSlots, model, fallbackModel, effort, contextBudget } = req.body ?? {};

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

      // Config dimensions (add-agent-config-dims D5): the SAME shape gates as
      // the model — an effort must be a level SOME known model declares (the
      // union, since the effective model may change later), a budget must be a
      // sane positive integer. null/"" clears a declaration.
      const dims = validateConfigDims({ effort, contextBudget }, effortUnionFrom(ctx?.dshModels));
      if (dims.error) return res.status(400).json({ error: dims.error });
      if (effort !== undefined) updates.effort = dims.effort;
      if (contextBudget !== undefined) updates.contextBudget = dims.contextBudget;

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
      //
      // fix-fleet-round-discipline D6: the dsh-side delete inside
      // deleteSession is best-effort (old runtimes have no session/delete RPC
      // and the failure is swallowed) — acceptable BY CONTRACT now: the
      // guarantee lives in the round rotation (cron-runner D4), which gives
      // this post's next round a fresh child conversation id regardless of
      // whether the child-side delete landed, so the new incumbent can never
      // inherit the old one's child-side state (production 2026-10-25: the
      // swap cleared only the mirror; the child resumed its 2.36MB session).
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
      // Fleet working memory (add-zhiyu-team-memory): the restaff is a team
      // fact — the incoming member's next digest tells it whose post it took.
      try {
        ctx?.captureFleetFact?.(fleet.id, member.id, "swap", `岗位「${member.title}」换防`, `新在岗者 ${String(targetId).slice(0, 80)}${req.body?.freshSession === true ? "（清史重开——对话史清空，记忆与报数史照旧）" : ""}`);
      } catch { /* capture never surfaces */ }
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

