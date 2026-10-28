// Blueprint trial executor (add-blueprint-studio task 4.1, design D8).
//
// 「装一台跑一轮」= 既有链的编排，不新增第二调度器/第二写路径：
//   市场读面 → installPack（既有装作链）→ provisionFleetFromTemplate（既有装台器，
//   dedup 同 pack+owner 复用）→ 起点火（同 POST /:id/start 的写面语义）→
//   cron.runJobNow 逐作业点火一轮（既有调度器，非新调度）→ 报数/决策收证 →
//   断言闭集判绿 → trial_report_json 落账（既有存储位）。
//
// deps 全注入：测试用假宇宙（零真市场/零真任务），生产走 createLiveTrialDeps()，
// 其装配与 routes/fleets.js 的 from-template 路由逐字同源。
// 断言闭集（D8-5）：post-materialized / first-round-fired / report-landed /
// escalate-bounded；未知 kind 判不绿并如实报（4.2 的结构性闸由此而来）。

import * as cron from "../cron.js";
import * as catalog from "../catalog.js";
import { rosterPresetId } from "../dsh-profile.js";
import { installPack } from "../pack-store.js";
import { fetchMarketManifest } from "./pack-manifest-source.js";
import { provisionFleetFromTemplate } from "./fleet-provisioner.js";
import { reconcileFleet } from "./fleet-reconcile.js";
import { getFleetDatabase } from "./routes/fleets-db.js";
import { getClusterDatabase } from "./routes/clusters-db.js";
import { resolveFleetTarget } from "./routes/fleets.js";
import { TRIAL_ASSERTION_KINDS, normalizeAcceptance } from "./blueprint-validate.js";

function membersFor(assertion, members) {
  if (!assertion.target) return members;
  return members.filter((m) => m.title === assertion.target);
}

// 逐断言判绿并附证据三元组（turnIds / reportIds / sourceRefs）。
export function evaluateTrial({ assertions, evidence, since }) {
  return assertions.map((a) => {
    const members = membersFor(a, evidence.members ?? []);
    const memberIds = new Set(members.map((m) => m.memberId));
    const evidenceOut = { turnIds: [], reportIds: [], sourceRefs: [] };
    const inWindow = (at) => typeof at === "number" && at >= since;

    if (a.kind === "post-materialized") {
      const unstaffed = members.filter((m) => !m.targetId);
      const pass = members.length > 0 && unstaffed.length === 0;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: pass
          ? `${members.length} post(s) staffed`
          : members.length === 0
            ? `no post matches '${a.target ?? "(any)"}'`
            : `unstaffed post(s): ${unstaffed.map((m) => m.title).join(", ")}`,
        evidence: evidenceOut,
      };
    }

    if (a.kind === "first-round-fired") {
      const fired = (evidence.turns ?? []).filter((t) => memberIds.has(t.memberId) && inWindow(t.at));
      evidenceOut.turnIds = fired.map((t) => t.turnId).filter(Boolean);
      evidenceOut.sourceRefs = fired.map((t) => `turn:${t.jobId ?? t.memberId}`);
      const pass = fired.length > 0;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: pass ? `first round fired for ${fired.length} post(s)` : `no round fired within the trial window for '${a.target ?? "(any)"}'`,
        evidence: evidenceOut,
      };
    }

    if (a.kind === "report-landed") {
      const landed = (evidence.reports ?? []).filter((r) => memberIds.has(r.memberId) && inWindow(r.createdAt));
      evidenceOut.reportIds = landed.map((r) => r.reportId).filter(Boolean);
      evidenceOut.turnIds = landed.map((r) => r.turnId).filter(Boolean);
      const pass = landed.length > 0;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: pass ? `${landed.length} report(s) landed` : `no report landed within the trial window for '${a.target ?? "(any)"}'`,
        evidence: evidenceOut,
      };
    }

    if (a.kind === "escalate-bounded") {
      const bound = Number.isFinite(a.expect) ? a.expect : 0;
      const count = Number(evidence.escalations ?? 0);
      const pass = count <= bound;
      return {
        id: a.id,
        kind: a.kind,
        pass,
        detail: `${count} open escalation(s), bound ${bound}`,
        evidence: evidenceOut,
      };
    }

    // 未知 kind（normalize 已报错；这里兜底判不绿，绝不静默通过）。
    return { id: a.id, kind: a.kind, pass: false, detail: `unsupported assertion kind '${a.kind}'`, evidence: evidenceOut };
  });
}

// 主流程：装台→点火→跑一轮→收证→判绿。任何装配失败如实进 errors，不抛。
export async function runTrial({ blueprint, deps, timeoutMs = 10 * 60_000, pollMs = 15_000 } = {}) {
  const now = deps.now ?? Date.now;
  const report = {
    ranAt: now(),
    fleetId: null,
    deduped: false,
    assertions: [],
    green: false,
    errors: [],
  };
  const view = { ownerEmail: blueprint.ownerEmail, content: blueprint.content ?? {} };

  if (!blueprint.castPackId) {
    report.errors.push("blueprint has no cast pack — cast before running a trial");
    return report;
  }
  const normalized = normalizeAcceptance(view.content.acceptance);
  report.acceptanceErrors = normalized.errors;
  if (normalized.assertions.length === 0) {
    // 无断言清单 = 无可验收之实，不得判绿（结构性地拒绝「空报告即可售」）。
    report.errors.push("blueprint declares no acceptance assertions — a trial needs at least one");
    return report;
  }

  try {
    // 装一台：市场读面 → 装作链 → 装台器（dedup 同 pack+owner）。
    const manifest = await deps.fetchManifest({ packId: blueprint.castPackId, version: blueprint.castPackVersion, viewer: blueprint.ownerEmail });
    await deps.install({ packId: blueprint.castPackId, version: blueprint.castPackVersion, manifest, ownerEmail: blueprint.ownerEmail });
    const provisioned = await deps.provision({ packId: blueprint.castPackId, version: blueprint.castPackVersion, manifest, ownerEmail: blueprint.ownerEmail });
    if (!provisioned?.ok) {
      report.errors.push(provisioned?.error ?? "provision failed");
      return report;
    }
    report.fleetId = provisioned.fleetId;
    report.deduped = Boolean(provisioned.deduped);

    // 起点火：同一写面语义（state active + cadence 启用 + reconcile）。
    await deps.startFleet(provisioned.fleetId);

    // 跑一轮：既有 cron 作业逐个点火一次。
    const since = now();
    report.fired = await deps.fireRound(provisioned.fleetId);

    // 收证：窗口内轮询直到可判或超时（超时者按无证判不绿并如实标）。
    const evidence = await deps.collectAndWait({ fleetId: provisioned.fleetId, since, assertions: normalized.assertions, timeoutMs, pollMs, fired: report.fired });
    report.assertions = evaluateTrial({ assertions: normalized.assertions, evidence, since });
    report.green = report.assertions.length > 0 && report.assertions.every((a) => a.pass);
    report.evidenceWindow = { since, until: now() };
  } catch (err) {
    report.errors.push(`trial aborted: ${err?.message || err}`);
  }
  return report;
}

// ── 生产装配（与 routes/fleets.js from-template 路由逐字同源） ──────────────

export function createLiveTrialDeps() {
  return {
    now: Date.now,
    fetchManifest: ({ packId, version, viewer }) => fetchMarketManifest({ packId, version, viewer }),
    install: async ({ packId, version, manifest, ownerEmail }) => {
      const installed = await installPack({ packId, version, manifest, user: { email: ownerEmail, groups: [] }, source: "market" });
      return installed;
    },
    provision: async ({ packId, version, manifest, ownerEmail }) => {
      const db = getFleetDatabase();
      const out = await provisionFleetFromTemplate({
        packId,
        version,
        manifest,
        ownerEmail,
        deps: {
          db,
          catalogAgentIds: () => new Set(catalog.getChatAgentEntries().map((e) => e.id)),
          resolveExisting: ({ kind, id }) => {
            if (kind === "persona") return !!catalog.getChatAgentEntries().some((e) => e.id === id);
            if (kind === "a2a") {
              const entry = catalog.getAgentEntry(id);
              return !!entry && entry.mode === "a2a";
            }
            if (kind === "tool" || kind === "bot") return resolveFleetTarget({ targetKind: kind, targetId: id }).alive;
            const cluster = getClusterDatabase().get(id);
            return !!cluster && cluster.status !== "terminated";
          },
          reconcile: (fleetId) => reconcileFleet({ fleetId, db, cronApi: cron, resolveTarget: resolveFleetTarget, rosterPresetId }),
        },
      });
      if (!out.ok) return out;
      return { ok: true, fleetId: out.fleet?.id ?? out.fleetId, deduped: out.deduped };
    },
    // 起点火：与 POST /api/fleets/:id/start 的写面一致（state→active、cadence 启用、
    // 再 reconcile 一次让物化作业跟上）。
    startFleet: async (fleetId) => {
      const db = getFleetDatabase();
      const fleet = db.getFleet(fleetId);
      if (!fleet) throw new Error(`trial fleet '${fleetId}' disappeared`);
      if (fleet.state !== "active") db.updateFleet(fleetId, { state: "active" }, { actor: "blueprint-trial", via: "POST /api/blueprints/:id/trial" });
      for (const m of db.listMembers(fleetId)) {
        if (m.cadence && m.cadence.enabled === false) db.updateMember(m.id, { cadence: { ...m.cadence, enabled: true } });
      }
      await reconcileFleet({ fleetId, db, cronApi: cron, resolveTarget: resolveFleetTarget, rosterPresetId });
    },
    fireRound: async (fleetId) => {
      const jobs = cron.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId);
      const fired = [];
      for (const job of jobs) {
        try {
          await cron.runJobNow(job.id);
          fired.push({ jobId: job.id, memberId: job.sourceTag?.memberId ?? null, at: Date.now() });
        } catch (err) {
          fired.push({ jobId: job.id, memberId: job.sourceTag?.memberId ?? null, at: Date.now(), error: err?.message || String(err) });
        }
      }
      return fired;
    },
    collectAndWait: async ({ fleetId, since, assertions, timeoutMs, pollMs, fired = [] }) => {
      const db = getFleetDatabase();
      const collect = () => {
        const members = db.listMembers(fleetId);
        const reports = [];
        for (const m of members) {
          for (const r of db.listReports(m.id, { limit: 20 })) {
            if ((r.createdAt ?? 0) >= since) reports.push({ memberId: m.id, reportId: r.id, createdAt: r.createdAt, turnId: r.sessionId ?? null });
          }
        }
        // 回合证据 = fireRound 的点火记录（作业触发即算首轮已发；turnId 待 trace
        // tap 补齐）。2026-10-28 生产走查逮住：此前这里恒返回空 turns，
        // first-round-fired 断言永远判不绿——点火事实必须进收证。
        return {
          members: members.map((m) => ({ memberId: m.id, title: m.title, targetId: m.targetId })),
          turns: fired.filter((f) => !f.error).map((f) => ({ memberId: f.memberId, at: f.at, jobId: f.jobId, turnId: null })),
          reports,
          escalations: db.countOpenDecisions(fleetId) ?? 0,
        };
      };
      const deadline = Date.now() + timeoutMs;
      let evidence = collect();
      // 等待条件：所有 report-landed 目标都已有报告（其余断言不依赖等待）。
      const needsReports = (ev) => {
        const targets = assertions.filter((a) => a.kind === "report-landed");
        if (!targets.length) return true;
        return targets.every((a) => {
          const ids = new Set(membersFor(a, ev.members).map((m) => m.memberId));
          return (ev.reports ?? []).some((r) => ids.has(r.memberId));
        });
      };
      while (!needsReports(evidence) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        evidence = collect();
      }
      return evidence;
    },
  };
}