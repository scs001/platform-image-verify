// Unit tests for the fleet report lane (agent-fleet-report-lane).
//
// Covers the chain the spec pins:
//   - member_reports storage: append/latest/timeline/previous/count
//   - payload validation (lenient write) + flood window math
//   - attribution: running cluster task wins over preset, unique preset hit,
//     ambiguity rejection, non-member rejection, roster mapping
//   - trends: system-computed vs previous report, self-delta as note only,
//     no-predecessor = no trend (never faked)
//   - a2a derived execution summaries (ok text / failure / not applicable)
//   - patrol-context rendering: child slot values + blockers + overview,
//     no-children segment, per-post and total truncation marks
//   - cron fire chain: non-fleet prompt byte-identical, fleet template gets a
//     per-fire render (stored prompt stays the template), render failure fails
//     the fire explicitly (never a silent empty-context patrol)
//   - dual-window missing: execution window vs report window, evidence names
//     which window fired
//   - routes: report bridge (attribution/flood/slot echo), timeline paging,
//     detail latestReport with trends
//
// Run: node --test scripts/test-fleet-report-lane.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-report-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { deriveMemberStatus } = await import("../server/fleet-reconcile.js");
const {
  validateReportPayload,
  resolveAttribution,
  floodWindowMs,
  checkFlood,
  computeTrend,
  buildLatestView,
  derivedReportFromTask,
  renderFleetIdentity,
  fleetIdentityFor,
} = await import("../server/fleet-reports.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { buildFleetContext } = await import("../server/fleet-context.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");

// The fake turn captures the prompt it ran with — the injection assertions
// compare against it.
const firedPrompts = [];
async function bootEngine() {
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async (job) => {
      firedPrompts.push(job.prompt);
      return { ok: true, text: "远端答复" };
    },
    isBusy: () => false,
  });
}
await bootEngine();

test.after(async () => {
  cron.shutdown?.();
  // Drain the engine's serialized write chain BEFORE deleting the tmp root —
  // a queued jobs.json rename against a removed directory is an unhandled
  // rejection the runner flags as a suite failure.
  await engine.idle();
  await new Promise((r) => setTimeout(r, 50));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

function fixtureFleet(db, name = "一号舰队") {
  return db.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail: "owner@test" });
}

function fixtureMember(db, fleetId, over = {}) {
  return db.createMember({
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "电商部",
    parentId: over.parentId ?? null,
    targetKind: over.targetKind ?? "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [{ key: "sales_week", label: "本周销售额", unit: "$" }],
    cadence: over.cadence !== undefined ? over.cadence : { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
  });
}

function fixtureReport(db, member, over = {}) {
  return db.appendReport({
    id: `r_${Math.random().toString(36).slice(2, 10)}`,
    fleetId: member.fleetId,
    memberId: member.id,
    sessionId: over.sessionId ?? null,
    metrics: over.metrics ?? { sales_week: { value: 280 } },
    resources: over.resources ?? [],
    blockers: over.blockers ?? [],
    summary: over.summary ?? "稳定",
    source: over.source ?? "self",
    createdAt: over.createdAt ?? Date.now(),
  });
}

// ── 1.1 storage ─────────────────────────────────────────────────────────────

test("member_reports: append, latest per fleet, timeline desc, previous, count", () => {
  const fleet = fixtureFleet(fleetDb);
  const m1 = fixtureMember(fleetDb, fleet.id, { id: "m_one" });
  const m2 = fixtureMember(fleetDb, fleet.id, { id: "m_two", title: "内容部", targetId: "persona-b" });

  const t0 = Date.now();
  const a = fixtureReport(fleetDb, m1, { createdAt: t0 - 3000, metrics: { sales_week: { value: 280 } } });
  fixtureReport(fleetDb, m2, { createdAt: t0 - 2000 });
  const b = fixtureReport(fleetDb, m1, { createdAt: t0 - 1000, metrics: { sales_week: { value: 309 } } });
  fixtureReport(fleetDb, m1, { createdAt: t0, source: "derived", summary: "a2a 摘要" });

  const latestByMember = fleetDb.latestReports(fleet.id);
  assert.equal(latestByMember.get("m_one").summary, "a2a 摘要", "newest wins regardless of source");
  assert.equal(latestByMember.get("m_two").summary, "稳定");

  const timeline = fleetDb.listReports("m_one", { limit: 10 });
  assert.deepEqual(timeline.map((r) => r.id), [latestByMember.get("m_one").id, b.id, a.id], "newest first");

  const prev = fleetDb.previousReport("m_one", b.createdAt);
  assert.equal(prev.id, a.id);
  assert.equal(fleetDb.previousReport("m_one", a.createdAt), null);

  // Flood counting ignores derived rows.
  assert.equal(fleetDb.countReportsSince("m_one", t0 - 60_000), 2);
});

// ── 1.2 validation + flood ──────────────────────────────────────────────────

test("validateReportPayload: summary required, lenient metrics, 8KB cap", () => {
  assert.equal(validateReportPayload({}).ok, false);
  assert.equal(validateReportPayload({ summary: "  " }).ok, false);
  const ok = validateReportPayload({
    summary: "今日 $309",
    metrics: { sales_week: { value: "$309", delta: "+12%" }, extra_undeclared: { value: 1 } },
    blockers: ["库存告急"],
    resources: [{ name: "主店铺", kind: "shop" }],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.metrics.sales_week.delta, "+12%");
  assert.equal(ok.report.metrics.extra_undeclared.value, 1, "undeclared keys kept verbatim");

  assert.equal(validateReportPayload({ summary: "x", metrics: { a: { value: true } } }).ok, false);
  assert.equal(
    validateReportPayload({ summary: "x", metrics: { a: { value: "y".repeat(9 * 1024) } } }).ok,
    false,
    "8KB body cap",
  );
});

test("flood window math + rejection carries windowResetsAt", () => {
  const hourly = floodWindowMs({ cron: "0 * * * *", tz: null }, (c) => (c === "0 * * * *" ? 3600_000 : null));
  assert.equal(hourly, 1800_000);
  const daily = floodWindowMs({ cron: "0 9 * * *", tz: null }, (c) => (c === "0 9 * * *" ? 86_400_000 : null));
  assert.equal(daily, 43_200_000);
  assert.equal(floodWindowMs(null, () => null), 600_000, "floor 10min");
  assert.equal(floodWindowMs({ cron: "x", tz: null }, () => null), 600_000, "unparseable → floor");

  const now = Date.now();
  const pass = checkFlood({ countSince: 2, windowMs: 600_000, now });
  assert.equal(pass.ok, true);
  const fail = checkFlood({ countSince: 3, windowMs: 600_000, now, oldestInWindowAt: now - 60_000 });
  assert.equal(fail.ok, false);
  assert.equal(fail.windowResetsAt, now - 60_000 + 600_000, "resets one window after the oldest in-window report");
});

// ── 1.3 attribution ─────────────────────────────────────────────────────────

test("attribution: running cluster task wins; preset resolves uniquely; ambiguity and none rejected", () => {
  const m = fixtureMember(fleetDb, fixtureFleet(fleetDb).id, { targetId: "Persona_A" });
  const roster = (id) => id.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

  // Cluster fire running → its post, even though a persona post would also
  // match the live preset (the fan-out rotates presets — that match is a lie).
  const clusterTask = { state: "running", targetType: "cluster", sourceTag: { fleetId: m.fleetId, memberId: "m_cluster" } };
  const hit = resolveAttribution({
    currentPreset: "persona-a",
    runningTasks: [clusterTask],
    personaMembers: [m],
    rosterPresetId: roster,
  });
  assert.equal(hit.kind, "cluster-task");
  assert.equal(hit.memberId, "m_cluster");

  const preset = resolveAttribution({ currentPreset: "persona-a", runningTasks: [], personaMembers: [m], rosterPresetId: roster });
  assert.equal(preset.kind, "preset");
  assert.equal(preset.memberId, m.id, "roster mapping resolves the catalog id");

  const twin = fixtureMember(fleetDb, m.fleetId, { title: "影子岗", targetId: "persona-a" });
  const ambiguous = resolveAttribution({ currentPreset: "persona-a", runningTasks: [], personaMembers: [m, twin], rosterPresetId: roster });
  assert.equal(ambiguous.kind, "ambiguous");
  assert.match(ambiguous.error, /several posts/);

  const none = resolveAttribution({ currentPreset: "stranger", runningTasks: [], personaMembers: [m], rosterPresetId: roster });
  assert.equal(none.kind, "none");
  const noPreset = resolveAttribution({ currentPreset: null, runningTasks: [], personaMembers: [m], rosterPresetId: roster });
  assert.equal(noPreset.kind, "none");
});

// ── trends + views ──────────────────────────────────────────────────────────

test("trends: system-computed; self-delta is a note; no predecessor = null", () => {
  assert.deepEqual(computeTrend({ value: 309 }, { value: 280 }), { direction: "up", deltaValue: 29 });
  assert.deepEqual(computeTrend({ value: 280 }, { value: 309 }), { direction: "down", deltaValue: -29 });
  assert.deepEqual(computeTrend({ value: "280" }, { value: 280 }), { direction: "flat", deltaValue: 0 }, "numeric strings compare numerically");
  assert.deepEqual(computeTrend({ value: "beta" }, { value: "alpha" }), { direction: "changed", deltaValue: null });
  assert.equal(computeTrend({ value: 1 }, undefined), null);

  const member = { kpiSlots: [{ key: "sales_week", label: "本周销售额", unit: "$" }, { key: "stars", label: "星数" }] };
  const view = buildLatestView({
    report: {
      createdAt: 2,
      summary: "涨了",
      source: "self",
      sessionId: "s1",
      metrics: { sales_week: { value: 309, delta: "+1%" }, stars: { value: 47 }, undeclared: { value: "x" } },
      blockers: [],
    },
    previous: { metrics: { sales_week: { value: 280 }, stars: { value: 47 } } },
    kpiSlots: member.kpiSlots,
  });
  const sales = view.slots.find((s) => s.key === "sales_week");
  assert.equal(sales.trend.direction, "up");
  assert.equal(sales.trend.deltaValue, 29);
  assert.equal(sales.note, "+1%", "self-delta rides as note only");
  assert.deepEqual(view.slots.find((s) => s.key === "stars").trend, { direction: "flat", deltaValue: 0 });
  assert.deepEqual(view.undeclaredKeys, ["undeclared"], "undeclared keys surface for the detail view");
  assert.equal(view.metricsAll.undeclared.value, "x");

  const firstEver = buildLatestView({
    report: { createdAt: 1, summary: "首次", source: "self", sessionId: null, metrics: { sales_week: { value: 10 } }, blockers: [] },
    previous: null,
    kpiSlots: member.kpiSlots,
  });
  assert.equal(firstEver.slots.find((s) => s.key === "sales_week").trend, null, "无前值不伪造");
});

// ── a2a derived summaries ───────────────────────────────────────────────────

test("derivedReportFromTask: a2a fires only, text or failure become the summary", () => {
  const task = {
    sourceTag: { fleetId: "f", memberId: "m" },
    targetType: "a2a",
    sessionId: "cron-x",
    history: [{ time: "2026-10-23T00:00:00.000Z", success: true, text: "外部服务答复正文" }],
  };
  const derived = derivedReportFromTask(task, { now: 1 });
  assert.equal(derived.source, "derived");
  assert.equal(derived.summary, "外部服务答复正文");
  assert.equal(derived.sessionId, "cron-x");

  const failed = derivedReportFromTask({
    ...task,
    history: [{ time: "2026-10-23T00:00:00.000Z", success: false, error: "502" }],
  }, { now: 1 });
  assert.match(failed.summary, /执行失败/);
  assert.deepEqual(failed.blockers, ["502"]);

  assert.equal(derivedReportFromTask({ ...task, targetType: "persona" }), null);
  assert.equal(derivedReportFromTask({ ...task, sourceTag: null }), null);
  assert.equal(derivedReportFromTask({ ...task, history: [] }), null);
});

// ── patrol context ──────────────────────────────────────────────────────────

function contextDeps(db, statuses) {
  return {
    db,
    deriveStatuses: () => new Map(Object.entries(statuses ?? { x: "on_duty" })),
    decisionDigest: null,
  };
}

test("fleet-context: renders child slots, blockers, overview; no-children segment", async () => {
  const fleet = fixtureFleet(fleetDb, "试验舰队");
  const _ceo = fixtureMember(fleetDb, fleet.id, { id: "m_ceo", title: "CEO", targetId: "persona-ceo", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  const shop = fixtureMember(fleetDb, fleet.id, { id: "m_shop", title: "电商部", parentId: "m_ceo", targetId: "persona-shop" });
  fixtureMember(fleetDb, fleet.id, { id: "m_far", title: "孙岗", parentId: "m_shop", targetId: "persona-far" }); // grandchild — NOT direct
  fixtureReport(fleetDb, shop, { metrics: { sales_week: { value: "$309" } }, blockers: ["库存告急"], summary: "今日大促" });
  fixtureReport(fleetDb, fleetDb.getMember("m_far"), { summary: "孙岗报数", metrics: {} });

  const text = await buildFleetContext({ fleetId: fleet.id, memberId: "m_ceo" }, {}, contextDeps(fleetDb));
  assert.match(text, /【舰队巡视上下文】舰队「试验舰队」在岗 1\/3/);
  assert.match(text, /### 电商部/);
  assert.match(text, /本周销售额（\$）: \$309/);
  assert.match(text, /库存告急/);
  assert.match(text, /今日大促/);
  assert.ok(!text.includes("孙岗报数"), "only DIRECT children render");

  const _lonely = fixtureMember(fleetDb, fleet.id, { id: "m_solo", title: "独立岗", targetId: "persona-solo", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  const soloText = await buildFleetContext({ fleetId: fleet.id, memberId: "m_solo" }, {}, contextDeps(fleetDb));
  assert.match(soloText, /本岗位无直接下级/);
});

test("fleet-context: per-post 4KB and total 24KB truncation marks; dead fleet throws", async () => {
  const fleet = fixtureFleet(fleetDb);
  const _ceo = fixtureMember(fleetDb, fleet.id, { id: "m_ceo2", title: "CEO", targetId: "persona-ceo2", cadence: { cron: "0 * * * *", tz: null, promptTemplate: "x {{fleetContext}}", enabled: true } });

  // A maximal child post: 8 declared slots × 300-char values + 20 blockers —
  // the inner caps themselves allow >4KB, so the per-post guard cuts.
  const fatSlots = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `槽${i}` }));
  const fat = fixtureMember(fleetDb, fleet.id, { title: "话痨岗", parentId: "m_ceo2", targetId: "persona-x", kpiSlots: fatSlots });
  const fatMetrics = Object.fromEntries(fatSlots.map((s) => [s.key, { value: "v".repeat(300) }]));
  fixtureReport(fleetDb, fat, { summary: "多", metrics: fatMetrics, blockers: Array.from({ length: 20 }, (_, i) => `b${i}-${"x".repeat(110)}`) });
  const oneChild = await buildFleetContext({ fleetId: fleet.id, memberId: "m_ceo2" }, {}, contextDeps(fleetDb));
  assert.match(oneChild, /…\[截断\]/, "per-post 4KB cap marks the cut");

  // Several fat children exceed the 24KB total → the tail is marked.
  for (let i = 0; i < 12; i++) {
    const c = fixtureMember(fleetDb, fleet.id, { title: `岗${i}`, parentId: "m_ceo2", targetId: `persona-t${i}`, kpiSlots: fatSlots });
    fixtureReport(fleetDb, c, { summary: "多", metrics: fatMetrics, blockers: [] });
  }
  const big = await buildFleetContext({ fleetId: fleet.id, memberId: "m_ceo2" }, {}, contextDeps(fleetDb));
  assert.match(big, /总量上限截断/);
  assert.ok(big.length < 26 * 1024, "hard ceiling holds");

  await assert.rejects(
    () => buildFleetContext({ fleetId: "fleet_nope", memberId: "x" }, {}, contextDeps(fleetDb)),
    /no longer exists/,
  );
});

// ── cron fire chain (2.1–2.3) ───────────────────────────────────────────────

test("fire chain: non-fleet prompt byte-identical; fleet template renders per fire", async () => {
  cron.setFleetContextRenderer(null);
  firedPrompts.length = 0;

  const plain = await cron.addJob({ cron: "0 3 1 1 *", prompt: "静态巡视 {{fleetContext}}", preset: "p" });
  await cron.fireTask(plain.id);
  await engine.idle();
  assert.equal(firedPrompts[firedPrompts.length - 1], "静态巡视 {{fleetContext}}", "no sourceTag → placeholder untouched, byte-for-byte");

  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-fire" });
  const spec = {
    cron: "0 3 1 1 *",
    prompt: "巡视下属。{{fleetContext}}",
    sessionTitle: "巡视",
    preset: "persona-fire",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  };
  const task = await cron.addJob(spec);
  cron.setFleetContextRenderer(async () => "【舰队巡视上下文】在岗 3/3");
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts[firedPrompts.length - 1], "巡视下属。【舰队巡视上下文】在岗 3/3");
  // The STORED prompt stays the template — the render was per-fire only.
  assert.equal(cron.getJob(task.id).prompt, "巡视下属。{{fleetContext}}");

  // Re-render on the next fire (fresh context each time).
  cron.setFleetContextRenderer(async () => "第二帧上下文");
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts[firedPrompts.length - 1], "巡视下属。第二帧上下文");
});

test("fire chain: render failure fails the fire explicitly, nothing enqueues", async () => {
  firedPrompts.length = 0;
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id, { targetId: "persona-boom" });
  const task = await cron.addJob({
    cron: "0 3 1 1 *",
    prompt: "巡视 {{fleetContext}}",
    preset: "persona-boom",
    sourceTag: { fleetId: fleet.id, memberId: member.id },
  });
  cron.setFleetContextRenderer(async () => {
    throw new Error("db exploded");
  });
  await cron.fireTask(task.id);
  await engine.idle();
  const after = cron.getJob(task.id);
  assert.equal(after.state, "failed");
  assert.match(after.history.at(-1).error, /fleetContext render failed: db exploded/);
  assert.equal(firedPrompts.length, 0, "no turn ran — never a silent empty-context patrol");

  // A renderer that returns an empty segment is equally fatal.
  await engine.runTaskNow(task.id); // reset lifecycle via the re-run path
  await engine.idle();
  firedPrompts.length = 0;
  cron.setFleetContextRenderer(async () => "   ");
  await cron.fireTask(task.id);
  await engine.idle();
  assert.equal(firedPrompts.length, 0);
  assert.match(cron.getJob(task.id).history.at(-1).error, /empty segment/);

  cron.setFleetContextRenderer(null);
});

// ── dual-window missing (3.4) ───────────────────────────────────────────────

test("derive: report window fires when executions are healthy", () => {
  const fleet = { state: "active" };
  const cadence = { cron: "0 * * * *", tz: null, promptTemplate: "x", enabled: true }; // window 6h
  const now = Date.now();
  const freshTask = {
    lastRun: new Date(now - 1800_000).toISOString(),
    createdAt: new Date(now - 7200_000).toISOString(),
  };

  const healthy = deriveMemberStatus({ member: { cadence }, fleet, task: freshTask, targetAlive: true, latestReport: { createdAt: now - 1800_000 }, now });
  assert.equal(healthy.status, "on_duty");
  assert.equal(healthy.evidence.hitWindow, null);

  const reportStale = deriveMemberStatus({ member: { cadence }, fleet, task: freshTask, targetAlive: true, latestReport: { createdAt: now - 7 * 3600_000 }, now });
  assert.equal(reportStale.status, "missing");
  assert.equal(reportStale.evidence.hitWindow, "report");
  assert.match(reportStale.reason, /no report/);

  // Never reported → the report window does not fire (nothing to go stale).
  const neverReported = deriveMemberStatus({ member: { cadence }, fleet, task: freshTask, targetAlive: true, latestReport: null, now });
  assert.equal(neverReported.status, "on_duty");

  const execStale = deriveMemberStatus({
    member: { cadence }, fleet,
    task: { lastRun: new Date(now - 8 * 3600_000).toISOString(), createdAt: new Date(now - 8200_000).toISOString() },
    targetAlive: true,
    latestReport: { createdAt: now - 1800_000 },
    now,
  });
  assert.equal(execStale.status, "missing");
  assert.equal(execStale.evidence.hitWindow, "execution");
});

// ── routes (3.1) ────────────────────────────────────────────────────────────

async function startServer(ctx) {
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

test("routes: report bridge attribution, slot echo, flood, timeline, detail latest", async () => {
  const universe = { "persona-a": { name: "甲" }, "persona-b": { name: "乙" } };
  const fleet = fixtureFleet(fleetDb, "报数舰队");
  const member = fixtureMember(fleetDb, fleet.id, { title: "电商部" });
  // A live conversation pointer — the manual-turn source session.
  chatHistory.setSessionManager({ getSessionId: () => "sess-live" });
  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-a",
    fleetTargetResolver: (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null }),
  });

  try {
    // Baseline report: accepted + unrecognized keys echoed.
    const r1 = await call("POST", "/api/fleets/report", {
      summary: "第一轮 $280",
      metrics: { sales_week: { value: 280 }, typo_key: { value: "x" } },
    });
    assert.equal(r1.status, 201);
    assert.deepEqual(r1.body.slotsAccepted, ["sales_week"]);
    assert.deepEqual(r1.body.slotsUnrecognized, ["typo_key"]);
    assert.equal(r1.body.memberTitle, "电商部");

    // Second report: trend-able predecessor.
    const r2 = await call("POST", "/api/fleets/report", {
      summary: "第二轮 $309",
      metrics: { sales_week: { value: 309, delta: "+1%" } },
    });
    assert.equal(r2.status, 201);

    // Flood: window = max(30min, 10min); third passes, fourth rejects.
    const r3 = await call("POST", "/api/fleets/report", { summary: "第三轮", metrics: { sales_week: { value: 315 } } });
    assert.equal(r3.status, 201);
    const r4 = await call("POST", "/api/fleets/report", { summary: "第四轮", metrics: {} });
    assert.equal(r4.status, 429);
    assert.ok(r4.body.windowResetsAt > Date.now());
    assert.equal(fleetDb.listReports(member.id).length, 3, "rejected call left nothing behind");

    // Non-member (preset with no post) → 409.
    const stranger = await startServer({
      authEnabled: false,
      cellUserEmail: "owner@test",
      currentPreset: "persona-zz",
      fleetTargetResolver: (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null }),
    });
    const r409 = await stranger.call("POST", "/api/fleets/report", { summary: "x" });
    assert.equal(r409.status, 409);
    assert.match(r409.body.error, /not a member/);
    stranger.server.close();

    // Timeline endpoint: desc + paging via nextBefore.
    const page1 = await call("GET", `/api/fleets/${fleet.id}/members/${member.id}/reports?limit=2`);
    assert.equal(page1.status, 200);
    assert.equal(page1.body.reports.length, 2);
    assert.ok(page1.body.reports[0].at >= page1.body.reports[1].at);
    assert.ok(page1.body.nextBefore);
    const page2 = await call("GET", `/api/fleets/${fleet.id}/members/${member.id}/reports?limit=2&before=${page1.body.nextBefore}`);
    assert.equal(page2.body.reports.length, 1);
    assert.equal(page2.body.nextBefore, null);

    // Detail: latestReport with system trend + timeline preview + evidence.
    const detail = await call("GET", `/api/fleets/${fleet.id}`);
    assert.equal(detail.status, 200);
    const view = detail.body.members.find((m) => m.id === member.id);
    assert.equal(view.latestReport.source, "self");
    const slot = view.latestReport.slots.find((s) => s.key === "sales_week");
    assert.equal(slot.trend.direction, "up");
    assert.equal(slot.trend.deltaValue, 6, "trend vs the previous report (309 → 315)");
    assert.equal(slot.note, null);
    assert.equal(view.reportTimeline.length, 3);
    assert.equal(view.reportTimeline[0].sessionId, "sess-live", "timeline rows carry the source session");
    assert.equal(view.evidence.latestReportAt != null, true);
  } finally {
    server.close();
  }
});

// ── enable-wire-content-fleet: post identity + cadence read ─────────────────

test("renderFleetIdentity: four fields, credential-free", () => {
  const line = renderFleetIdentity({
    fleetId: "f_1",
    memberId: "m_1",
    title: "巡线岗",
    targetKind: "persona",
    targetId: "persona-a",
  });
  assert.match(line, /fleet=f_1/);
  assert.match(line, /post=m_1/);
  assert.match(line, /title=巡线岗/);
  assert.match(line, /target=persona:persona-a/);
  assert.ok(!/token|key|secret|Bearer/i.test(line), "identity carries no credential");
});

test("routes: ghost posts of archived fleets exit attribution (0030e1e8 family)", async () => {
  // A persona swapped into a DISSOLVED fleet's post keeps a member row. That
  // ghost must not collide with its live post: report attribution (and the
  // same candidate set escalate rides) resolves to the LIVE post alone.
  const universe = { "persona-a": { name: "甲" } };
  const live = fixtureFleet(fleetDb, "活舰队");
  const livePost = fixtureMember(fleetDb, live.id, { title: "真岗", kpiSlots: [{ key: "risk_flags", label: "风险提示" }] });
  const ghostFleet = fixtureFleet(fleetDb, "已解散舰队");
  fixtureMember(fleetDb, ghostFleet.id, { title: "幽灵岗", targetId: "persona-a" });
  fleetDb.updateFleet(ghostFleet.id, { state: "archived" });

  chatHistory.setSessionManager({ getSessionId: () => "sess-ghost" });
  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-a",
    fleetTargetResolver: (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null }),
  });
  try {
    const r = await call("POST", "/api/fleets/report", {
      summary: "幽灵岗不应造成歧义",
      metrics: { risk_flags: { value: 6 } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.memberTitle, "真岗");
    assert.deepEqual(r.body.slotsAccepted, ["risk_flags"]);
    assert.equal(fleetDb.listReports(livePost.id).length, 1);
  } finally {
    server.close();
  }
});

// A ctx whose stub bridge closes the turn immediately — enough to drive the
// REAL runPersonaTurn and inspect the prompt it dispatched.
function identityCtx(resolveFleetIdentity) {
  const ctx = {
    currentPreset: "persona-a",
    isStreaming: false,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => () => {},
    switchPresetTo: async () => ({ ok: true }),
    resolveFleetIdentity,
    prompts: [],
    dshBridge: {
      isReady: () => true,
      prompt: async (sessionId, blocks) => {
        ctx.prompts.push(blocks[0].text);
        ctx.sessionCollectors.get(sessionId)?.({ method: "session.status", params: { status: "idle" } });
      },
    },
  };
  attachCronRunner(ctx);
  return ctx;
}

test("member turn gets the identity prefix; non-member turn is byte-identical", async () => {
  const identity = "【舰队岗位身份】fleet=f_1; post=m_1; title=巡线岗; target=persona:persona-a";

  const memberCtx = identityCtx((p) => (p === "persona-a" ? identity : null));
  await memberCtx.runCronJobTurn(
    { id: "job_m", sessionId: "sess_m", prompt: "巡视一下", preset: "persona-a", sessionTitle: "岗" },
    { turnTimeoutMs: 2000 },
  );
  assert.equal(memberCtx.prompts[0], `${identity}\n\n巡视一下`, "identity prefixes the dispatched prompt");
  const hist = await chatHistory.getSession("sess_m");
  assert.equal(hist.messages[0].content, `${identity}\n\n巡视一下`, "session history keeps the same line");

  // Non-member (resolver returns null) — the delegation/manual lane and plain
  // persona turns both land here; prompt must not be touched.
  const plainCtx = identityCtx(() => null);
  await plainCtx.runCronJobTurn(
    { id: "job_p", sessionId: "sess_p", prompt: "随便聊聊", preset: "persona-a", sessionTitle: "聊" },
    { turnTimeoutMs: 2000 },
  );
  assert.equal(plainCtx.prompts[0], "随便聊聊", "non-member turn unchanged");
});

test("cadence read contract: rhythm + target only, passive post answers null", async () => {
  const fleet = fixtureFleet(fleetDb, "节奏舰队");
  const active = fixtureMember(fleetDb, fleet.id, {
    id: "m_active",
    title: "巡线岗",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "巡视", enabled: true },
  });
  fixtureMember(fleetDb, fleet.id, {
    id: "m_passive",
    title: "内容岗",
    cadence: null,
    kpiSlots: [{ key: "secret_slot", label: "不该出现" }],
  });

  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "persona-a",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId, clusterName: null }),
  });
  try {
    const r = await call("GET", `/api/fleets/${fleet.id}/cadence`);
    assert.equal(r.status, 200);
    assert.equal(r.body.fleetName, "节奏舰队");
    const byRef = Object.fromEntries(r.body.posts.map((p) => [p.ref, p]));
    assert.deepEqual(byRef[active.id], {
      ref: "m_active",
      title: "巡线岗",
      cron: "0 9 * * *",
      tz: "Asia/Shanghai",
      targetRef: { kind: "persona", id: "persona-a" },
    });
    assert.equal(byRef.m_passive.cron, null, "passive post answers null cron");
    assert.equal(byRef.m_passive.tz, null);
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes("secret_slot"), "KPI slots never leave the fleet");
    assert.ok(!raw.includes("kpi"), "no KPI surface in the read contract");

    const missing = await call("GET", "/api/fleets/nope/cadence");
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test("fleetIdentityFor: unique post resolves; no post and ambiguity yield null", () => {
  const fleet = fixtureFleet(fleetDb, "身份舰队");
  const post = fixtureMember(fleetDb, fleet.id, { id: "m_id1", title: "巡线岗", targetId: "persona-a" });

  const line = fleetIdentityFor(fleetDb, "persona-a");
  assert.equal(line, renderFleetIdentity({
    fleetId: fleet.id, memberId: post.id, title: "巡线岗", targetKind: "persona", targetId: "persona-a",
  }));

  assert.equal(fleetIdentityFor(fleetDb, "persona-zz"), null, "no post → null");
  assert.equal(fleetIdentityFor(fleetDb, null), null, "no preset → null");

  // A second post on the SAME persona makes attribution ambiguous → null.
  fixtureMember(fleetDb, fleet.id, { id: "m_id2", title: "内容岗", targetId: "persona-a" });
  assert.equal(fleetIdentityFor(fleetDb, "persona-a"), null, "ambiguous → null");
});
