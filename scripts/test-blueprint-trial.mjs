#!/usr/bin/env node
// ── Blueprint trial executor tests (add-blueprint-studio task 4.1, design D8) ─
//
// 执行器单测走全注入的假宇宙：零真市场、零真任务引擎、零 cron。判绿的语义
// （断言闭集/证据三元组/未知 kind 不绿/超时如实标）与装配顺序在此钉住。
//
//   node --test scripts/test-blueprint-trial.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { evaluateTrial, runTrial } = await import("../server/blueprint-trial.js");
const { normalizeAcceptance } = await import("../server/blueprint-validate.js");

const content = (acceptance) => ({ boundary: { name: "政策盯梢" }, acceptance });

test("normalizeAcceptance：闭集解析；未知 kind 逐条指名；空清单零断言", () => {
  const ok = normalizeAcceptance([
    { id: "a1", kind: "post-materialized" },
    { id: "a2", kind: "escalate-bounded", expect: 2 },
  ]);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.assertions.map((a) => a.kind), ["post-materialized", "escalate-bounded"]);

  const bad = normalizeAcceptance([{ id: "x", kind: "llm-judged" }, { id: "y", kind: "escalate-bounded", expect: "two" }]);
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0].error, /unsupported assertion kind 'llm-judged'/);
  assert.match(bad.errors[1].error, /expect must be a number/);

  assert.deepEqual(normalizeAcceptance(undefined).assertions, []);
});

test("evaluateTrial：四类断言判绿/判红 + 证据三元组 + 未知 kind 不绿", () => {
  const since = 1000;
  const evidence = {
    members: [
      { memberId: "m1", title: "盯梢岗", targetId: "websearch" },
      { memberId: "m2", title: "简报岗", targetId: "" },
    ],
    turns: [{ memberId: "m1", at: 2000, jobId: "j1", turnId: "t-1" }],
    reports: [{ memberId: "m1", reportId: "r1", createdAt: 2100, turnId: "t-1" }],
    escalations: 2,
  };
  const [staffed, fired, reported, bounded, unknown] = evaluateTrial({
    assertions: [
      { id: "a1", kind: "post-materialized", target: null, expect: null },
      { id: "a2", kind: "first-round-fired", target: "盯梢岗", expect: null },
      { id: "a3", kind: "report-landed", target: "简报岗", expect: null },
      { id: "a4", kind: "escalate-bounded", target: null, expect: 3 },
      { id: "a5", kind: "made-up", target: null, expect: null },
    ],
    evidence,
    since,
  });
  // 简报岗未落位 → 全岗判红并指名。
  assert.equal(staffed.pass, false);
  assert.match(staffed.detail, /简报岗/);
  // 盯梢岗有回合（带 turnId 证据）。
  assert.equal(fired.pass, true);
  assert.deepEqual(fired.evidence.turnIds, ["t-1"]);
  // 简报岗无报数 → 判红。
  assert.equal(reported.pass, false);
  // 2 次升级 ≤ 3 的界。
  assert.equal(bounded.pass, true);
  // 未知 kind 永不静默通过。
  assert.equal(unknown.pass, false);
});

test("runTrial：无铸造版本/无断言 → 如实拒，不静默绿", async () => {
  const noCast = await runTrial({ blueprint: { ownerEmail: "a@x", content: content([{ id: "a1", kind: "report-landed" }]) }, deps: {} });
  assert.equal(noCast.green, false);
  assert.match(noCast.errors[0], /cast before running a trial/);

  const noAssertions = await runTrial({
    blueprint: { ownerEmail: "a@x", castPackId: "pk1", castPackVersion: 1, content: content([]) },
    deps: {},
  });
  assert.equal(noAssertions.green, false);
  assert.match(noAssertions.errors[0], /no acceptance assertions/);
});

test("runTrial：装配顺序 市场读→装作→装台→点火→跑一轮→收证，全绿落账", async () => {
  const order = [];
  let waited = null;
  const deps = {
    now: () => 5000,
    fetchManifest: async ({ packId, version, viewer }) => {
      order.push(["fetch", packId, version, viewer]);
      return { fleet: { name: "政策盯梢", members: [] } };
    },
    install: async ({ packId }) => order.push(["install", packId]),
    provision: async ({ packId, ownerEmail }) => {
      order.push(["provision", packId, ownerEmail]);
      return { ok: true, fleetId: "fleet_trial_1", deduped: false };
    },
    startFleet: async (fleetId) => order.push(["start", fleetId]),
    fireRound: async (fleetId) => {
      order.push(["fire", fleetId]);
      return [{ jobId: "job_1", memberId: "m1", at: 5100 }];
    },
    collectAndWait: async ({ fleetId, since, timeoutMs }) => {
      waited = { fleetId, since, timeoutMs };
      return {
        members: [{ memberId: "m1", title: "盯梢岗", targetId: "websearch::web_search" }],
        turns: [{ memberId: "m1", at: since + 10, jobId: "job_1", turnId: "turn_1" }],
        reports: [{ memberId: "m1", reportId: "report_1", createdAt: since + 20, turnId: "turn_1" }],
        escalations: 0,
      };
    },
  };
  const report = await runTrial({
    blueprint: { ownerEmail: "owner@x", castPackId: "pk_cast_1", castPackVersion: 1, content: content([{ id: "a1", kind: "report-landed", target: "盯梢岗" }]) },
    deps,
    timeoutMs: 1234,
    pollMs: 10,
  });
  assert.deepEqual(
    order.map(([step]) => step),
    ["fetch", "install", "provision", "start", "fire"],
  );
  assert.equal(waited.fleetId, "fleet_trial_1");
  assert.equal(waited.timeoutMs, 1234);
  assert.equal(report.fleetId, "fleet_trial_1");
  assert.equal(report.green, true);
  assert.equal(report.assertions[0].pass, true);
  assert.deepEqual(report.assertions[0].evidence.reportIds, ["report_1"]);
  assert.deepEqual(report.assertions[0].evidence.turnIds, ["turn_1"]);
});

test("runTrial：收证无报数（超时）→ 不绿且如实标；装台失败 → errors 不绿", async () => {
  const base = {
    now: () => 1000,
    fetchManifest: async () => ({ fleet: { name: "x", members: [] } }),
    install: async () => {},
    provision: async () => ({ ok: true, fleetId: "f1" }),
    startFleet: async () => {},
    fireRound: async () => [],
  };
  const timedOut = await runTrial({
    blueprint: { ownerEmail: "a@x", castPackId: "pk1", castPackVersion: 1, content: content([{ id: "a1", kind: "report-landed", target: "岗" }]) },
    deps: {
      ...base,
      collectAndWait: async () => ({ members: [{ memberId: "m1", title: "岗", targetId: "t" }], turns: [], reports: [], escalations: 0 }),
    },
  });
  assert.equal(timedOut.green, false);
  assert.equal(timedOut.assertions[0].pass, false);
  assert.match(timedOut.assertions[0].detail, /no report landed/);

  const provisionFailed = await runTrial({
    blueprint: { ownerEmail: "a@x", castPackId: "pk1", castPackVersion: 1, content: content([{ id: "a1", kind: "report-landed" }]) },
    deps: { ...base, provision: async () => ({ ok: false, error: "pack not installed" }) },
  });
  assert.equal(provisionFailed.green, false);
  assert.deepEqual(provisionFailed.errors, ["pack not installed"]);
});
test("实盘收证接 fired → turns：first-round-fired 可判绿（生产走查逮住的回归）", async () => {
  // 2026-10-28 生产：实盘 collectAndWait 恒返回空 turns，first-round-fired 永不绿。
  // 此处用「只注入收证层」的最小宇宙复现该形状并锁死修复。
  const { createLiveTrialDeps } = await import("../server/blueprint-trial.js");
  const deps = createLiveTrialDeps();
  // 不触真 cron/db：只验证 collectAndWait 对 fired 的映射（用空 fleetId 让 db 查询返回空集）。
  const evidence = await deps.collectAndWait({
    fleetId: "fleet_does_not_exist",
    since: Date.now() - 1000,
    assertions: [{ id: "a1", kind: "first-round-fired", target: null }],
    timeoutMs: 0,
    pollMs: 1,
    fired: [{ jobId: "j1", memberId: "m1", at: Date.now() }],
  });
  assert.equal(evidence.turns.length, 1);
  assert.equal(evidence.turns[0].jobId, "j1");
  assert.equal(evidence.turns[0].memberId, "m1");
  // 判绿环节单独验（成员集来自 db，此处手工给出同一个 m1）。
  const judged = evaluateTrial({
    assertions: [{ id: "a1", kind: "first-round-fired", target: null, expect: null }],
    evidence: { ...evidence, members: [{ memberId: "m1", title: "岗", targetId: "t" }] },
    since: Date.now() - 5000,
  });
  assert.equal(judged[0].pass, true);
});
