// Unit tests for cluster task scheduling + execution (agent-cluster-platform).
//
// Covers the reconciliation's biggest acceptance hole: cluster tasks were
// schema-only (cron-mcp advertised clusterId, every layer below dropped it).
// These tests pin the now-real chain:
//   - addJob: cluster target shape, preset/cluster exclusivity, policy
//     validation, clientShape carrying cluster fields
//   - resolveClusterMembers: catalog resolution, persona readiness, skips,
//     targetAgents filtering
//   - buildClusterDigest: all/first aggregation, failure/skip footer,
//     honest parallel-degradation note
//   - runClusterTurn orchestration (fake executors, real clusters.db +
//     chat-history): member fan-out, sequential vs parallel, summary turn,
//     stats update, preset restore, all-failed error
//
// Run: node --test scripts/test-cluster-tasks.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-tasks-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
// Persona presets the fake pack agents get: entries keyed by catalog id.
fs.writeFileSync(
  path.join(process.env.DSH_HOME, ".agent-presets.defs.json"),
  JSON.stringify([
    { id: "pack-alpha-analyst", entryId: "pack-alpha-analyst", name: "Alpha Analyst" },
    { id: "pack-beta-writer", entryId: "pack-beta-writer", name: "Beta Writer" },
  ]),
);

const cron = await import("../cron.js");
const cronRunner = await import("../server/cron-runner.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const { createClusterDatabase, setClusterDatabase } = await import("../server/routes/clusters-db.js");
const { resolveClusterMembers, buildClusterDigest } = cronRunner;

// chat-history's mirror silently drops rows while the DB is not ready;
// initDb() is what server.js runs at boot.
await initDb();
await chatHistory.initChatHistory();

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset the engine singleton's in-memory map between tests (initTaskEngine
  // reloads from the fixture file).
  await cron.shutdown?.();
  await cronRunnerAttachReset();
});

let lastRunnerCtx = null;
async function cronRunnerAttachReset() {
  if (lastRunnerCtx?.abortCronTurns) lastRunnerCtx.abortCronTurns("test-reset");
}

// ── fixtures ────────────────────────────────────────────────────────────────

function freshClusterDb() {
  const db = createClusterDatabase({ file: path.join(tmpRoot, `clusters-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`) });
  setClusterDatabase(db);
  return db;
}

const CATALOG_AGENTS = [
  { id: "pack-alpha-analyst", packId: "packA", mode: "chat", name: "Alpha 分析师" },
  { id: "pack-beta-writer", packId: "packB", mode: "chat", name: "Beta 写手" },
  { id: "pack-gone-agent", packId: "packZ", mode: "chat", name: "Ghost" },
  { id: "remote-svc", packId: "packR", mode: "a2a", name: "远端服务" },
];

function fixtureCluster(db, { agents } = {}) {
  const cluster = {
    id: `dyn_test_${Math.random().toString(36).slice(2, 8)}`,
    name: "测试集群",
    description: "",
    tags: [],
    agents:
      agents ?? [
        { packId: "packA", agentId: "pack-alpha-analyst", version: "1", status: "active" },
        { packId: "packB", agentId: "pack-beta-writer", version: "1", status: "active" },
      ],
    activateAll: false,
    bindToSession: false,
    sessionId: null,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    totalExecutions: 0,
    totalTokensUsed: 0,
    status: "ready",
  };
  db.create(cluster);
  return cluster;
}

// Fake member executors. The persona fake mirrors the real one's observable
// contract: it moves the shared runtime to its preset and returns text+usage.
function makeCtx({ preset = "standard" } = {}) {
  const switches = [];
  const ctx = {
    currentPreset: preset,
    isStreaming: false,
    sessionCollectors: new Map(),
    sessionVersion: 1,
    broadcast: () => {},
    onRuntimeIdle: () => {},
    reserveRuntime: () => () => {},
    dshBridge: { isReady: () => true },
    switchPresetTo: async (p) => {
      switches.push(p);
      ctx.currentPreset = p;
      return { ok: true };
    },
    switches,
  };
  return ctx;
}

function fakeExecutors(ctx, { personaText, a2aOut = { ok: true, text: "remote reply" }, personaDelayMs = 0 } = {}) {
  const calls = { persona: [], a2a: [], personaStart: [], personaEnd: [] };
  // Mirrors runPersonaTurn's persistence contract: the exchange lands in the
  // job's own session (the summary regression below keys off exactly-once).
  const runPersona = async (_c, job) => {
    calls.personaStart.push(Date.now());
    calls.persona.push(job);
    ctx.currentPreset = job.preset;
    if (personaDelayMs) await new Promise((r) => setTimeout(r, personaDelayMs));
    calls.personaEnd.push(Date.now());
    const text = personaText ? personaText(job) : `${job.preset} 的输出`;
    chatHistory.recordMessage(job.sessionId, "user", job.prompt);
    chatHistory.recordMessage(job.sessionId, "assistant", text);
    return { ok: true, text, usage: { input: 10, output: 5 } };
  };
  const runA2a = async (_c, job) => {
    calls.a2a.push({ at: Date.now(), job });
    return { ...a2aOut };
  };
  return { calls, runPersona, runA2a };
}

async function attachAndRun(ctx, job, executors, { listAgents = () => CATALOG_AGENTS } = {}) {
  cronRunner.attachCronRunner(ctx, {
    runPersona: executors.runPersona,
    runA2a: executors.runA2a,
    listAgents,
  });
  lastRunnerCtx = ctx;
  return ctx.runCronJobTurn(job, { turnTimeoutMs: 5_000 });
}

// ── A. addJob shape & validation ───────────────────────────────────────────

test("addJob: cluster task carries target type, ref and cluster fields", async () => {
  const job = await cron.addJob({
    when: new Date(Date.now() + 3600_000).toISOString(),
    prompt: "汇总今日要闻",
    clusterId: "dyn_x1",
    clusterName: "快讯集群",
    agentCount: 3,
    executionPolicy: { allowParallel: true, resultAggregation: "summary" },
    targetAgents: ["a1", "a2"],
  });
  assert.equal(job.target.type, "cluster");
  assert.equal(job.preset, "dyn_x1");
  assert.equal(job.clusterId, "dyn_x1");
  assert.equal(job.clusterName, "快讯集群");
  assert.equal(job.agentCount, 3);
  assert.equal(job.executionPolicy.allowParallel, true);
  assert.deepEqual(job.targetAgents, ["a1", "a2"]);
  await cron.removeJob(job.id);
});

test("addJob: preset and cluster are mutually exclusive", async () => {
  await assert.rejects(
    cron.addJob({ when: new Date(Date.now() + 3600_000).toISOString(), prompt: "p", preset: "standard", clusterId: "dyn_x1" }),
    /not both/,
  );
});

test("addJob: rejects malformed executionPolicy and targetAgents", async () => {
  const base = { when: new Date(Date.now() + 3600_000).toISOString(), prompt: "p", clusterId: "dyn_x1" };
  await assert.rejects(cron.addJob({ ...base, executionPolicy: { allowParallel: "yes" } }), /allowParallel/);
  await assert.rejects(cron.addJob({ ...base, executionPolicy: { timeoutMinutes: -1 } }), /timeoutMinutes/);
  await assert.rejects(cron.addJob({ ...base, executionPolicy: { resultAggregation: "best" } }), /resultAggregation/);
  await assert.rejects(cron.addJob({ ...base, targetAgents: [] }), /targetAgents/);
  await assert.rejects(cron.addJob({ ...base, targetAgents: [42] }), /targetAgents/);
});

// ── B. member resolution ───────────────────────────────────────────────────

test("resolveClusterMembers: chat/a2a runnable, missing catalog entry and unready persona skipped", () => {
  const cluster = {
    agents: [
      { packId: "packA", agentId: "pack-alpha-analyst" },
      { packId: "packZ", agentId: "pack-gone-agent-uninstalled" }, // not in catalog
      { packId: "packR", agentId: "remote-svc" },
    ],
  };
  const out = resolveClusterMembers(cluster, null, CATALOG_AGENTS);
  assert.equal(out.length, 3);
  assert.equal(out[0].entry.mode, "chat");
  assert.ok(out[1].skip, "unlisted agent must be skipped");
  assert.equal(out[2].entry.mode, "a2a");
});

test("resolveClusterMembers: chat agent without a ready persona preset is skipped", () => {
  const cluster = { agents: [{ packId: "packZ", agentId: "pack-gone-agent" }] }; // in catalog, no preset def
  const out = resolveClusterMembers(cluster, null, CATALOG_AGENTS);
  assert.ok(out[0].skip.includes("persona"), out[0].skip);
});

test("resolveClusterMembers: targetAgents filters without reordering", () => {
  const cluster = {
    agents: [
      { packId: "packB", agentId: "pack-beta-writer" },
      { packId: "packA", agentId: "pack-alpha-analyst" },
    ],
  };
  const out = resolveClusterMembers(cluster, ["pack-alpha-analyst"], CATALOG_AGENTS);
  assert.equal(out.length, 1);
  assert.equal(out[0].member.agentId, "pack-alpha-analyst");
});

// ── C. digest rendering ────────────────────────────────────────────────────

const DIGEST_RESULTS = [
  { name: "甲", kind: "persona", status: "ok", text: "甲的结论" },
  { name: "乙", kind: "a2a", status: "failed", error: "超时" },
  { name: "丙", kind: "skip", status: "skipped", reason: "未安装" },
];

test("buildClusterDigest: all — every ok output plus failure/skip footer", () => {
  const d = buildClusterDigest({ clusterName: "三员组", results: DIGEST_RESULTS, policy: {} });
  assert.ok(d.includes("甲的结论"));
  assert.ok(d.includes("## 未产出成员"));
  assert.ok(d.includes("乙：失败——超时"));
  assert.ok(d.includes("丙：跳过——未安装"));
});

test("buildClusterDigest: first — only the first ok output", () => {
  const d = buildClusterDigest({
    clusterName: "三员组",
    results: [...DIGEST_RESULTS, { name: "丁", kind: "persona", status: "ok", text: "丁的结论" }],
    policy: { resultAggregation: "first" },
  });
  assert.ok(d.includes("甲的结论"));
  assert.ok(!d.includes("丁的结论"));
  assert.ok(d.includes("first 策略"));
});

test("buildClusterDigest: parallel policy annotates the persona degradation honestly", () => {
  const d = buildClusterDigest({
    clusterName: "组",
    results: [{ name: "甲", kind: "persona", status: "ok", text: "x" }],
    policy: { allowParallel: true },
  });
  assert.ok(d.includes("仍按序执行"), "parallel note must be present for persona members");
});

// ── D. orchestration (fake executors, real clusters.db + chat-history) ─────

test("runClusterTurn: sequential fan-out records per-member turns and an aggregate digest", async () => {
  const db = freshClusterDb();
  const cluster = fixtureCluster(db);
  const ctx = makeCtx();
  const ex = fakeExecutors(ctx, { personaText: (job) => `${job.preset} 的输出` });
  const job = { id: "job_t1", prompt: "各自分析", preset: cluster.id, targetType: "cluster", sessionId: "cron-job_t1", executionPolicy: {} };

  const out = await attachAndRun(ctx, job, ex);

  assert.equal(out.ok, true);
  assert.equal(ex.calls.persona.length, 2, "both persona members run");
  assert.notEqual(ex.calls.persona[0].sessionId, ex.calls.persona[1].sessionId, "own sub-session per member");
  const session = await chatHistory.getSession("cron-job_t1");
  const texts = JSON.stringify(session);
  assert.ok(texts.includes("pack-alpha-analyst 的输出"));
  assert.ok(texts.includes("pack-beta-writer 的输出"));
  assert.ok(texts.includes("集群「测试集群」任务完成"));
  // Stats and preset restore
  assert.equal(db.get(cluster.id).totalExecutions, 1);
  assert.equal(ctx.currentPreset, "standard", "runtime restored to the original preset");
});

test("runClusterTurn: allowParallel overlaps remote turns with the persona loop; sequential does not", async () => {
  const db = freshClusterDb();
  const cluster = fixtureCluster(db, {
    agents: [
      { packId: "packA", agentId: "pack-alpha-analyst", status: "active" },
      { packId: "packR", agentId: "remote-svc", status: "active" },
    ],
  });

  const runWithPolicy = async (allowParallel) => {
    const ctx = makeCtx();
    const ex = fakeExecutors(ctx, { personaDelayMs: 40 });
    const job = {
      id: `job_${allowParallel}`, prompt: "p", preset: cluster.id, targetType: "cluster",
      sessionId: `cron-job_${allowParallel}`,
      executionPolicy: { allowParallel, resultAggregation: "all" },
    };
    await attachAndRun(ctx, job, ex);
    return ex;
  };

  const par = await runWithPolicy(true);
  assert.ok(par.calls.a2a[0].at < par.calls.personaEnd[0], "parallel: a2a starts before the persona turn ends");
  const seq = await runWithPolicy(false);
  assert.ok(seq.calls.a2a[0].at >= seq.calls.personaEnd[0], "sequential: a2a starts only after the persona turn ends");
});

test("runClusterTurn: summary policy adds a synthesis turn under the lead persona in the bound session", async () => {
  const db = freshClusterDb();
  const cluster = fixtureCluster(db);
  const ctx = makeCtx();
  const ex = fakeExecutors(ctx, { personaText: (job) => (job.sessionId === "cron-job_t3" ? "综合结论：一切正常" : `${job.preset} 的输出`) });
  const job = {
    id: "job_t3", prompt: "各自分析再汇总", preset: cluster.id, targetType: "cluster",
    sessionId: "cron-job_t3", executionPolicy: { resultAggregation: "summary" },
  };

  const out = await attachAndRun(ctx, job, ex);

  assert.equal(out.ok, true);
  assert.equal(ex.calls.persona.length, 3, "2 members + 1 synthesis turn");
  const synth = ex.calls.persona[2];
  assert.equal(synth.sessionId, "cron-job_t3", "synthesis lands in the BOUND session");
  assert.equal(synth.preset, "pack-alpha-analyst", "first successful persona leads the synthesis");
  assert.ok(synth.prompt.includes("综合以上成员输出"));
  const session = await chatHistory.getSession("cron-job_t3");
  const assistantRows = (session?.messages ?? []).filter((m) => m.role === "assistant");
  assert.ok(JSON.stringify(session).includes("综合结论：一切正常"));
  assert.equal(assistantRows.filter((m) => String(m.content).includes("综合结论：一切正常")).length, 1,
    "a successful synthesis must land exactly once (no duplicate digest row)");
});

test("runClusterTurn: partial failure still succeeds and the digest names the failure", async () => {
  const db = freshClusterDb();
  const cluster = fixtureCluster(db, {
    agents: [
      { packId: "packA", agentId: "pack-alpha-analyst", status: "active" },
      { packId: "packR", agentId: "remote-svc", status: "active" },
    ],
  });
  const ctx = makeCtx();
  const ex = fakeExecutors(ctx, { a2aOut: { ok: false, error: "503" } });
  const job = { id: "job_t4", prompt: "p", preset: cluster.id, targetType: "cluster", sessionId: "cron-job_t4", executionPolicy: {} };

  const out = await attachAndRun(ctx, job, ex);

  assert.equal(out.ok, true, "one ok member is enough");
  const session = await chatHistory.getSession("cron-job_t4");
  assert.ok(JSON.stringify(session).includes("失败——503"));
});

test("runClusterTurn: every member failed/skipped → ok:false with the per-member reasons", async () => {
  const db = freshClusterDb();
  const cluster = fixtureCluster(db, {
    agents: [
      { packId: "packR", agentId: "remote-svc", status: "active" },
      { packId: "packZ", agentId: "pack-gone-agent-uninstalled", status: "active" },
    ],
  });
  const ctx = makeCtx();
  const ex = fakeExecutors(ctx, { a2aOut: { ok: false, error: "503" } });
  const job = { id: "job_t5", prompt: "p", preset: cluster.id, targetType: "cluster", sessionId: "cron-job_t5", executionPolicy: {} };

  const out = await attachAndRun(ctx, job, ex);

  assert.equal(out.ok, false);
  assert.match(out.error, /503/);
  assert.match(out.error, /不在当前 catalog/);
});

test("runClusterTurn: deleted cluster → honest error", async () => {
  freshClusterDb();
  const ctx = makeCtx();
  const ex = fakeExecutors(ctx);
  const job = { id: "job_t6", prompt: "p", preset: "dyn_deleted", targetType: "cluster", sessionId: "cron-job_t6", executionPolicy: {} };
  const out = await attachAndRun(ctx, job, ex);
  assert.equal(out.ok, false);
  assert.match(out.error, /no longer exists/);
});

test("runClusterTurn: targetAgents subsetting reaches only the selected member", async () => {
  const db = freshClusterDb();
  const cluster = fixtureCluster(db);
  const ctx = makeCtx();
  const ex = fakeExecutors(ctx);
  const job = {
    id: "job_t7", prompt: "p", preset: cluster.id, targetType: "cluster", sessionId: "cron-job_t7",
    executionPolicy: {}, targetAgents: ["pack-beta-writer"],
  };
  const out = await attachAndRun(ctx, job, ex);
  assert.equal(out.ok, true);
  assert.equal(ex.calls.persona.length, 1);
  assert.equal(ex.calls.persona[0].preset, "pack-beta-writer");
});
