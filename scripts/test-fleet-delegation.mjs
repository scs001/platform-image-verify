// 拍板委托 (add-deputy-decision-delegate) — 策略路由、强制授权、归并、角标口径。
//
// 这些用例钉的是「服务端闸」而不是提示词：draft 里最硬的一条是"AI 越权由
// 代码拦下"，所以每条越权路径都必须有一条断言说 403 且条目原样保留。
//
// Run: node --test scripts/test-fleet-delegation.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-delegation-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb } = await import("../db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const {
  createFleetDatabase,
  setFleetDatabase,
  normalizeDelegationPolicy,
  routeForItem,
} = await import("../server/routes/fleets-db.js");

await initDb();
const fleetDb = createFleetDatabase({});
setFleetDatabase(fleetDb);

const FLEET = "fleet_dlg_1";
const DEPUTY = "m_deputy";
const WORKER = "m_worker";
const OWNER = "owner@test";

// The deputy is identified by the turn's current preset — the same attribution
// path escalate uses. Tests flip `ctx.currentPreset` to act as either post.
const ctx = { authEnabled: false, cellUserEmail: OWNER, currentPreset: null };

async function startServer() {
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

before(() => {
  fleetDb.createFleet({ id: FLEET, name: "委托舰队", ownerEmail: OWNER });
  // Persona posts whose targetId doubles as the preset id — attribution
  // resolves the running turn's preset against these.
  fleetDb.createMember({
    id: DEPUTY, fleetId: FLEET, title: "常务", targetKind: "persona", targetId: "preset-deputy",
    cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
  });
  fleetDb.createMember({
    id: WORKER, fleetId: FLEET, title: "投稿岗", targetKind: "persona", targetId: "preset-worker",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  });
});

// ── 策略模型（纯函数） ───────────────────────────────────────────────────────

test("policy:高风险类别不可委托——写进来也被归一为 owner", () => {
  const p = normalizeDelegationPolicy(
    { enabled: true, routes: { "config-change": "deputy", hr: "deputy", spend: "deputy", "routine-ops": "deputy" } },
    null,
  );
  assert.equal(p.routes["config-change"], "owner");
  assert.equal(p.routes.hr, "owner");
  assert.equal(p.routes.spend, "owner");
  assert.equal(p.routes["routine-ops"], "deputy", "可委托类别照常生效");
});

test("policy:默认关闭委托，行为与未启用一致", () => {
  const p = normalizeDelegationPolicy(null, null);
  assert.equal(p.enabled, false);
  assert.equal(routeForItem({ category: "routine-ops", severity: "low" }, { ...p, enabled: false }), "deputy");
  // enabled=false 时路由字段仍按策略算，但舰队覆写可把 routes.default 设 owner
  const off = normalizeDelegationPolicy(null, { enabled: false, routes: { default: "owner" } });
  assert.equal(off.enabled, false);
});

test("policy:严重度超过上限一律路由 owner", () => {
  const p = normalizeDelegationPolicy({ enabled: true, maxSeverity: "normal" }, null);
  assert.equal(routeForItem({ category: "routine-ops", severity: "high" }, p), "owner");
  assert.equal(routeForItem({ category: "routine-ops", severity: "normal" }, p), "deputy");
});

test("policy:config-change 类型即使无类别也路由 owner", () => {
  const p = normalizeDelegationPolicy({ enabled: true }, null);
  assert.equal(routeForItem({ itemType: "config-change", severity: "low" }, p), "owner");
});

test("policy:舰队覆写只改自己写到的键", () => {
  const cell = { enabled: true, dailyBudget: 20, maxSeverity: "normal", routes: { "routine-ops": "deputy" } };
  const merged = normalizeDelegationPolicy(cell, { maxSeverity: "low" });
  assert.equal(merged.maxSeverity, "low");
  assert.equal(merged.dailyBudget, 20, "未覆写的键沿用 cell 默认");
  assert.equal(merged.routes["routine-ops"], "deputy");
});

// ── serve 路径：escalate 路由 + 归并 ────────────────────────────────────────

test("escalate:按策略路由，并把路由写进响应", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setCellSetting("delegationPolicy", { enabled: true, routes: { "routine-ops": "deputy" }, maxSeverity: "high" });
    ctx.currentPreset = "preset-worker";
    const r = await call("POST", "/api/fleets/escalate", {
      question: "本周视频是否提前发布",
      options: [{ value: "now", label: "立即发布" }, { value: "fri", label: "周五发布" }],
      severity: "normal",
      category: "routine-ops",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.route, "deputy");
    const item = fleetDb.getDecision(r.body.itemId);
    assert.equal(item.route, "deputy");
    assert.equal(item.category, "routine-ops");
  } finally {
    server.close();
  }
});

test("escalate:同岗位同主题重复升级被归并，不落新行", async () => {
  const { server, call } = await startServer();
  try {
    ctx.currentPreset = "preset-worker";
    const payload = {
      question: "电商部报告 fleet 服务端重复岗位注册导致 report_status 持续被拒",
      options: [{ value: "fix", label: "修" }, { value: "wait", label: "等" }],
      severity: "high",
      topicKey: "dup-post-registry",
    };
    const first = await call("POST", "/api/fleets/escalate", payload);
    assert.equal(first.status, 201);
    assert.equal(first.body.merged, undefined);
    const before = fleetDb.listDecisions({ fleetId: FLEET, state: "open", memberId: WORKER }).length;

    const second = await call("POST", "/api/fleets/escalate", {
      ...payload,
      // 措辞不同但 topicKey 相同 —— 归并的判据是声明主题，不是文本
      question: "重复岗位注册仍未修复，report_status 继续被拒（第三轮）",
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.merged, true);
    assert.equal(second.body.itemId, first.body.itemId, "归并指回既有条目");
    const after = fleetDb.listDecisions({ fleetId: FLEET, state: "open", memberId: WORKER }).length;
    assert.equal(after, before, "没有新行");
    assert.equal(fleetDb.getDecision(first.body.itemId).escalations, 1);
  } finally {
    server.close();
  }
});

test("escalate:不同主题不误并", async () => {
  const { server, call } = await startServer();
  try {
    ctx.currentPreset = "preset-worker";
    const a = await call("POST", "/api/fleets/escalate", {
      question: "本周视频是否提前发布", options: [{ value: "y", label: "是" }, { value: "n", label: "否" }],
      severity: "low", topicKey: "video-timing",
    });
    const b = await call("POST", "/api/fleets/escalate", {
      question: "客服排班是否改为两班制", options: [{ value: "y", label: "是" }, { value: "n", label: "否" }],
      severity: "low", topicKey: "support-shift",
    });
    assert.notEqual(a.body.itemId, b.body.itemId);
    assert.equal(b.body.merged, undefined);
  } finally {
    server.close();
  }
});

test("escalate:归并也计入每日防洪上限", async () => {
  const { server, call } = await startServer();
  try {
    const fleetId = "fleet_cap";
    fleetDb.createFleet({ id: fleetId, name: "上限舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_cap", fleetId, title: "闸岗", targetKind: "persona", targetId: "preset-cap",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.updateFleet(fleetId, { decisionPolicy: { expiryHours: 72, dailyCapPerMember: 2 } });
    ctx.currentPreset = "preset-cap";
    const p = (i) => ({
      question: `第 ${i} 次升级同一个阻塞问题`, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", topicKey: "same-blocker",
    });
    assert.equal((await call("POST", "/api/fleets/escalate", p(1))).status, 201);
    assert.equal((await call("POST", "/api/fleets/escalate", p(2))).status, 200, "第二次是归并");
    const third = await call("POST", "/api/fleets/escalate", p(3));
    assert.equal(third.status, 429, "第三次触顶——归并同样计入上限");
  } finally {
    server.close();
  }
});

// ── 服务端强制授权 ─────────────────────────────────────────────────────────

test("deputy:非常务岗调队列被拒（403）", async () => {
  const { server, call } = await startServer();
  try {
    ctx.currentPreset = "preset-worker";
    const r = await call("POST", "/api/fleets/deputy/queue", {});
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});

test("deputy:越出委托类别被服务端拒绝，条目原样保留", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    ctx.currentPreset = "preset-worker";
    // 手工造一条 config-change 但强行 route=deputy（模拟历史数据/被绕过）
    const item = fleetDb.appendDecision({
      id: "d_forbidden", fleetId: FLEET, memberId: WORKER,
      question: "把 defaultModel 改成 cheap-m", options: [{ value: "y", label: "批准" }, { value: "n", label: "驳回" }],
      severity: "low", itemType: "config-change", route: "deputy", category: "config-change",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: item.id, kind: "approve", choice: "y", evidence: "例行",
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /beyond delegation mandate/);
    const after = fleetDb.getDecision(item.id);
    assert.equal(after.state, "open", "条目原样保留");
  } finally {
    server.close();
  }
});

test("deputy:严重度超上限被拒", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "low", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_sev", fleetId: FLEET, memberId: WORKER, question: "一个 high 严重度的例行选择",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "high", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: item.id, kind: "approve", choice: "a", evidence: "x",
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /severity/);
  } finally {
    server.close();
  }
});

test("deputy:预算内的裁决生效并记录身份与依据", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_ok", fleetId: FLEET, memberId: WORKER, question: "例行运营选择：周报是否包含图表",
      options: [{ value: "yes", label: "包含" }, { value: "no", label: "不包含" }],
      severity: "normal", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: item.id, kind: "approve", choice: "yes",
      evidence: "主人 2026-10 判例：周报一律附图", model: "deepseek-v4.1-flash",
    });
    assert.equal(r.status, 200);
    const after = fleetDb.getDecision(item.id);
    assert.equal(after.state, "approved");
    assert.equal(after.resolvedBy, "deputy");
    assert.equal(after.resolvedByModel, "deepseek-v4.1-flash");
    assert.match(after.rulingEvidence, /判例/);
    assert.equal(after.resolution.choice, "yes");
  } finally {
    server.close();
  }
});

test("deputy:日预算用尽后拒绝", async () => {
  const { server, call } = await startServer();
  try {
    // 独立舰队：日预算是 per-fleet-per-day，共用舰队会被前序用例消耗。
    const fleetId = "fleet_budget";
    fleetDb.createFleet({ id: fleetId, name: "预算舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_budget_deputy", fleetId, title: "预算常务", targetKind: "persona", targetId: "preset-budget-deputy",
      cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.createMember({
      id: "m_budget_worker", fleetId, title: "预算岗", targetKind: "persona", targetId: "preset-budget-worker",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.setFleetDelegationPolicy(fleetId, {
      enabled: true, deputyMemberId: "m_budget_deputy", routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 1,
    });
    const mk = (id) => fleetDb.appendDecision({
      id, fleetId, memberId: "m_budget_worker", question: `预算用例 ${id}`,
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-budget-deputy";
    mk("d_b1");
    assert.equal((await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_b1", kind: "approve", choice: "a", evidence: "e",
    })).status, 200);
    mk("d_b2");
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_b2", kind: "approve", choice: "a", evidence: "e",
    });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /budget/);
  } finally {
    server.close();
  }
});

test("deputy:判不了可上报主人（转路由 owner）", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_esc", fleetId: FLEET, memberId: WORKER, question: "空缺岗位如何处置——需要主人偏好",
      options: [{ value: "a", label: "补岗" }, { value: "b", label: "撤销" }],
      severity: "normal", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/escalate-to-owner", {
      itemId: item.id, analysis: "两种处置都可行，取决于主人对这个岗位的投入意愿",
    });
    assert.equal(r.status, 200);
    const after = fleetDb.getDecision(item.id);
    assert.equal(after.route, "owner", "转回主人队列");
    assert.equal(after.state, "open", "仍待裁");
    assert.match(after.detail.deputyAnalysis.analysis, /投入意愿/);
  } finally {
    server.close();
  }
});

test("deputy:主人可收回委托条目", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_recall", fleetId: FLEET, memberId: WORKER, question: "先委托后来想自己裁的一条",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", route: "deputy", category: "routine-ops",
    });
    const r = await call("POST", `/api/fleets/${FLEET}/decisions/${item.id}/recall`, {});
    assert.equal(r.status, 200);
    assert.equal(fleetDb.getDecision(item.id).route, "owner");
  } finally {
    server.close();
  }
});

// ── 角标口径 ───────────────────────────────────────────────────────────────

test("角标只计 route=owner，deputy 的另计", async () => {
  const { server, call } = await startServer();
  try {
    const fleetId = "fleet_badge";
    fleetDb.createFleet({ id: fleetId, name: "角标舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_badge", fleetId, title: "角标岗", targetKind: "persona", targetId: "preset-badge",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    for (let i = 0; i < 3; i += 1) {
      fleetDb.appendDecision({
        id: `d_owner_${i}`, fleetId, memberId: "m_badge", question: `主人待裁 ${i}`,
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], severity: "low", route: "owner",
      });
    }
    for (let i = 0; i < 2; i += 1) {
      fleetDb.appendDecision({
        id: `d_deputy_${i}`, fleetId, memberId: "m_badge", question: `常务待裁 ${i}`,
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], severity: "low", route: "deputy",
      });
    }
    const r = await call("GET", "/api/fleets");
    const row = (r.body.fleets ?? []).find((f) => f.id === fleetId);
    assert.equal(row.openDecisions, 3, "「等你 N 件」只计 owner");
    assert.equal(row.deputyOpen, 2, "deputy 队列另计");
  } finally {
    server.close();
  }
});

// ── 执行事实 ───────────────────────────────────────────────────────────────

test("执行事实：送达即回填 executed_at，「批了没执行」可区分", () => {
  const fleetId = "fleet_exec";
  fleetDb.createFleet({ id: fleetId, name: "执行舰队", ownerEmail: OWNER });
  fleetDb.createMember({
    id: "m_exec", fleetId, title: "执行岗", targetKind: "persona", targetId: "preset-exec",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  });
  const item = fleetDb.appendDecision({
    id: "d_exec", fleetId, memberId: "m_exec", question: "批准后要确认执行",
    options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], severity: "low",
  });
  fleetDb.transitionDecision(item.id, "open", {
    state: "approved", resolvedAt: Date.now(), resolvedBy: "owner",
    resolution: { kind: "approve", choice: "a", note: null, by: OWNER, at: Date.now() },
  });
  const approved = fleetDb.getDecision(item.id);
  assert.equal(approved.state, "approved");
  assert.equal(approved.executedAt, null, "已批未送达 = 还没执行");

  fleetDb.markDelivered("m_exec", { sessionId: "sess-1" });
  const delivered = fleetDb.getDecision(item.id);
  assert.equal(delivered.state, "delivered");
  assert.ok(delivered.executedAt, "送达回合完成即执行事实");
  assert.equal(delivered.executedSessionId, "sess-1");
});
// ── 存量 triage（发布迁移路径） ──────────────────────────────────────────────

test("triage：重路由存量并按主题归并，第二次调用不再变化", async () => {
  const { server, call } = await startServer();
  try {
    const fleetId = "fleet_triage";
    fleetDb.createFleet({ id: fleetId, name: "迁移舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_triage", fleetId, title: "迁移岗", targetKind: "persona", targetId: "preset-triage",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.setCellSetting("delegationPolicy", { enabled: true, routes: { "routine-ops": "deputy" }, maxSeverity: "high" });
    // 三条存量：两条同主题（应归并），一条不同主题（保留）；全部还是 route=owner
    const mk = (id, q, topic) => fleetDb.appendDecision({
      id, fleetId, memberId: "m_triage", question: q, topicKey: topic,
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", category: "routine-ops",
    });
    mk("t1", "重复岗位注册导致报数被拒（第一轮）", "dup-post");
    mk("t2", "重复岗位注册导致报数被拒（第三轮）", "dup-post");
    mk("t3", "客服排班是否改两班制", "shift");

    const first = await call("POST", `/api/fleets/${fleetId}/decisions/triage`, {});
    assert.equal(first.status, 200);
    assert.equal(first.body.scanned, 3);
    assert.equal(first.body.rerouted, 3, "存量全部按策略重路由");
    assert.equal(first.body.merged, 1, "同主题的一条被归并");

    const open = fleetDb.listDecisions({ fleetId, state: "open" });
    assert.equal(open.length, 2, "归并后剩两条待裁");
    assert.ok(open.every((i) => i.route === "deputy"), "重路由生效");

    const second = await call("POST", `/api/fleets/${fleetId}/decisions/triage`, {});
    assert.equal(second.body.rerouted, 0, "幂等：无变化");
    assert.equal(second.body.merged, 0);
  } finally {
    server.close();
  }
});
