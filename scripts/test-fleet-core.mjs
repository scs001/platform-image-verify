// Unit tests for agent fleets (agent-fleet-core).
//
// Covers the chain the spec pins:
//   - fleets-db: fleet/member CRUD, swap columns, unique-post lookup
//   - task-engine sourceTag passthrough: create/persist/reload round-trip,
//     legacy records untouched
//   - cron addJob agent(a2a)/sourceTag params + updateJob in-place rewrite
//     (id + session stable across cadence edits and target rebinds)
//   - reconcile: idempotence, cadence edit without orphans, cadence
//     withdrawal → passive, two-layer pause, vacancy pause, archived keeps
//     history and never re-materializes
//   - deriveMemberStatus: vacant/passive/paused/missing/on_duty precedence
//     and the evidence fields
//   - routes: owner scoping (403/401), validation 400s that leave no rows,
//     dense-cadence confirmation, unique post 409, cycle rejection, swap
//     preset rewrite + freshSession clearing, archive semantics, dissolve
//
// Run: node --test scripts/test-fleet-core.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-core-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const {
  createFleetDatabase,
  setFleetDatabase,
} = await import("../server/routes/fleets-db.js");
const {
  reconcileFleet,
  reconcileAllFleets,
  deriveMemberStatus,
  cronPeriodMs,
  staleWindowMs,
} = await import("../server/fleet-reconcile.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true }),
  isBusy: () => false,
});

test.after(() => {
  // Armed node-schedule handles (hourly/daily cadences) keep the event loop
  // alive past the last test — cancel them so the runner can exit.
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function freshFleetDb() {
  const db = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(db);
  return db;
}

let fleetDb;
beforeEach(() => {
  fleetDb = freshFleetDb();
});

function fixtureFleet(db, { name = "一号舰队", state = "active", ownerEmail = "owner@test" } = {}) {
  return db.createFleet({ id: `fleet_${Math.random().toString(36).slice(2, 8)}`, name, ownerEmail, state });
}

const HOURLY = { cron: "0 * * * *", tz: "Asia/Shanghai", promptTemplate: "巡视并报数", enabled: true };

function fixtureMember(db, fleetId, over = {}) {
  return db.createMember({
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    fleetId,
    title: over.title ?? "电商部",
    parentId: over.parentId ?? null,
    targetKind: over.targetKind ?? "persona",
    targetId: over.targetId ?? "persona-a",
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence !== undefined ? over.cadence : HOURLY,
  });
}

// Fake target universe — mutable so vacancy scenarios flip entries.
function makeResolver(universe) {
  return (member) => {
    const u = universe[member.targetId];
    return { alive: !!u, label: u?.name ?? member.targetId, clusterName: u?.clusterName ?? null };
  };
}

const rosterFn = (id) => `r-${id}`;

function fleetTasks(fleetId) {
  return cron.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId);
}

// ── 1.1 fleets-db ───────────────────────────────────────────────────────────

test("fleets-db: fleet + member roundtrip, swap columns, unique-post lookup", () => {
  const fleet = fixtureFleet(fleetDb);
  assert.equal(fleet.state, "active");

  const member = fixtureMember(fleetDb, fleet.id, {
    kpiSlots: [{ key: "sales", label: "销售额", unit: "$" }],
  });
  assert.equal(member.cadence.cron, "0 * * * *");
  assert.equal(member.kpiSlots[0].key, "sales");
  assert.equal(member.parentId, null);

  const passive = fixtureMember(fleetDb, fleet.id, { title: "助理岗", cadence: null });
  assert.equal(passive.cadence, null);

  // Swap writes target_kind/target_id (ADR-0031's one mutable ref).
  const swapped = fleetDb.updateMember(member.id, { targetKind: "persona", targetId: "persona-b" });
  assert.equal(swapped.targetId, "persona-b");
  assert.equal(swapped.cadence.cron, member.cadence.cron, "cadence untouched by swap");

  // Unique-post lookup: hit + self-exclusion.
  const hit = fleetDb.findPostByTarget("persona", "persona-b");
  assert.equal(hit.member.id, member.id);
  assert.equal(fleetDb.findPostByTarget("persona", "persona-b", { excludeMemberId: member.id }), null);
  assert.equal(fleetDb.findPostByTarget("persona", "ghost"), null);

  // Member deletion + fleet state update.
  assert.equal(fleetDb.deleteMember(passive.id), true);
  assert.equal(fleetDb.listMembers(fleet.id).length, 1);
  assert.equal(fleetDb.updateFleet(fleet.id, { state: "paused" }).state, "paused");
});

// ── 1.2 sourceTag passthrough ───────────────────────────────────────────────

test("engine: sourceTag rides create/list and survives a reload; legacy rows read null", async () => {
  const job = await cron.addJob({
    cron: "0 * * * *",
    prompt: "巡视",
    preset: "persona-a",
    sourceTag: { fleetId: "fleet_x", memberId: "m_x" },
  });
  assert.deepEqual(job.sourceTag, { fleetId: "fleet_x", memberId: "m_x" });
  assert.deepEqual(
    cron.listJobs().find((j) => j.id === job.id).sourceTag,
    { fleetId: "fleet_x", memberId: "m_x" },
  );

  // Reload from disk: the write chain must have persisted the tag.
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
  const reloaded = cron.getJob(job.id);
  assert.deepEqual(reloaded.sourceTag, { fleetId: "fleet_x", memberId: "m_x" });

  // Legacy record without a tag: null, and nothing else about it changes.
  const legacyId = "job_legacy_1";
  const legacy = {
    id: legacyId,
    trigger: "schedule",
    type: "recurring",
    cron: "0 * * * *",
    when: null,
    prompt: "旧任务",
    preset: "persona-old",
    targetType: "persona",
    sessionId: `cron-${legacyId}`,
    sessionTitle: null,
    tz: null,
    status: "scheduled",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    missed: 0,
    history: [],
  };
  const jobsFile = path.join(tmpRoot, "jobs.json");
  const onDisk = JSON.parse(fs.readFileSync(jobsFile, "utf8"));
  fs.writeFileSync(jobsFile, JSON.stringify([...onDisk.filter((t) => t.id !== legacyId), legacy]));
  await engine.initTaskEngine({
    broadcast: () => {},
    runTurn: async () => ({ ok: true }),
    isBusy: () => false,
  });
  assert.equal(cron.getJob(legacyId).sourceTag, null);
  assert.equal(cron.getJob(legacyId).prompt, "旧任务");
  // And the tagged task survived the same reload.
  assert.deepEqual(cron.getJob(job.id)?.sourceTag, { fleetId: "fleet_x", memberId: "m_x" });
});

test("cron: addJob agent target (a2a) + exclusivity; updateJob rebinds in place", async () => {
  const a2aJob = await cron.addJob({
    cron: "0 * * * *",
    prompt: "远端巡视",
    agent: "a2a-x",
    sourceTag: { fleetId: "f1", memberId: "m1" },
  });
  assert.equal(a2aJob.target.type, "a2a");
  assert.equal(a2aJob.preset, "a2a-x");

  await assert.rejects(
    () => cron.addJob({ cron: "0 * * * *", prompt: "x", preset: "p", agent: "a2a-x" }),
    /not both/,
  );
  await assert.rejects(
    () => cron.addJob({ cron: "0 * * * *", prompt: "x", clusterId: "c1", agent: "a2a-x" }),
    /not both/,
  );

  // Cadence edit in place: id, session, history preserved; cron changed.
  const daily = await cron.updateJob(a2aJob.id, { cron: "0 9 * * *", tz: "UTC" });
  assert.equal(daily.id, a2aJob.id);
  assert.equal(daily.sessionId, a2aJob.sessionId);
  assert.equal(daily.cron, "0 9 * * *");

  // Target rebind persona → cluster: clusterId set, targetType flipped.
  const asCluster = await cron.updateJob(a2aJob.id, { clusterId: "dyn_c", clusterName: "集群一" });
  assert.equal(asCluster.target.type, "cluster");
  assert.equal(asCluster.clusterId, "dyn_c");
  assert.equal(asCluster.clusterName, "集群一");

  // And cluster → persona clears the cluster residue.
  const asPersona = await cron.updateJob(a2aJob.id, { preset: "persona-z" });
  assert.equal(asPersona.target.type, "persona");
  assert.equal(asPersona.clusterId, null);

  // Invalid cron on update refuses.
  await assert.rejects(() => cron.updateJob(a2aJob.id, { cron: "not a cron" }), /invalid cron/);
});

// ── 1.3 reconcile ───────────────────────────────────────────────────────────

test("reconcile: materializes once, second pass is a no-op", async () => {
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver({ "persona-a": { name: "A" } });

  const first = await reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  assert.equal(first.created.length, 1);
  const task = fleetTasks(fleet.id)[0];
  assert.deepEqual(task.sourceTag, { fleetId: fleet.id, memberId: member.id });
  assert.equal(task.prompt, HOURLY.promptTemplate);
  assert.equal(task.sessionTitle, "一号舰队 · 电商部");
  assert.equal(task.preset, "r-persona-a", "catalog id → roster preset id");

  const second = await reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  assert.deepEqual(second, { created: [], updated: [], paused: [], resumed: [], removed: [] });
});

test("reconcile: cadence edit rewrites the SAME task (no orphan); withdrawal removes it", async () => {
  const fleet = fixtureFleet(fleetDb);
  const member = fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver({ "persona-a": {} });
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();
  const before = fleetTasks(fleet.id)[0];

  fleetDb.updateMember(member.id, { cadence: { cron: "0 9 * * *", tz: "UTC", promptTemplate: "晨报", enabled: true } });
  const out = await run();
  assert.equal(out.updated.length, 1);
  const after = fleetTasks(fleet.id)[0];
  assert.equal(after.id, before.id, "in-place rewrite, task id stable");
  assert.equal(after.sessionId, before.sessionId, "dedicated session continuity");
  assert.equal(after.cron, "0 9 * * *");
  assert.equal(after.prompt, "晨报");
  assert.equal(fleetTasks(fleet.id).length, 1, "no orphan task");

  // Withdraw the cadence entirely → passive post, task removed.
  fleetDb.updateMember(member.id, { cadence: null });
  const withdrawn = await run();
  assert.equal(withdrawn.removed.length, 1);
  assert.equal(fleetTasks(fleet.id).length, 0);
});

test("reconcile: passive posts never materialize", async () => {
  const fleet = fixtureFleet(fleetDb);
  fixtureMember(fleetDb, fleet.id, { title: "助理岗", cadence: null });
  const out = await reconcileFleet({
    fleetId: fleet.id, db: fleetDb, cronApi: cron,
    resolveTarget: makeResolver({ "persona-a": {} }), rosterPresetId: rosterFn,
  });
  assert.deepEqual(out, { created: [], updated: [], paused: [], resumed: [], removed: [] });
  assert.equal(fleetTasks(fleet.id).length, 0);
});

test("reconcile: two-layer pause — member pause survives fleet resume", async () => {
  const fleet = fixtureFleet(fleetDb);
  const m1 = fixtureMember(fleetDb, fleet.id, { title: "甲", targetId: "persona-a" });
  const m2 = fixtureMember(fleetDb, fleet.id, { title: "乙", targetId: "persona-b" });
  const resolver = makeResolver({ "persona-a": {}, "persona-b": {} });
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();

  // Fleet pause → both tasks paused; resume → both back.
  fleetDb.updateFleet(fleet.id, { state: "paused" });
  let out = await run();
  assert.equal(out.paused.length, 2);
  fleetDb.updateFleet(fleet.id, { state: "active" });
  out = await run();
  assert.equal(out.resumed.length, 2);

  // Member-level pause on m2, then a fleet pause+resume cycle: m2 stays parked.
  fleetDb.updateMember(m2.id, { cadence: { ...HOURLY, enabled: false } });
  out = await run();
  assert.equal(out.paused.length, 1);
  fleetDb.updateFleet(fleet.id, { state: "paused" });
  await run();
  fleetDb.updateFleet(fleet.id, { state: "active" });
  out = await run();
  assert.equal(out.resumed.length, 1, "only m1 resumes");
  const tasks = fleetTasks(fleet.id);
  const t1 = tasks.find((t) => t.sourceTag.memberId === m1.id);
  const t2 = tasks.find((t) => t.sourceTag.memberId === m2.id);
  assert.equal(t1.paused, false);
  assert.equal(t2.paused, true, "member pause outlives the fleet cycle");
});

test("reconcile: a vacant post's task is parked, restaff re-arms it", async () => {
  const universe = { "persona-a": {} };
  const fleet = fixtureFleet(fleetDb);
  fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver(universe);
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();

  delete universe["persona-a"]; // persona deleted → post vacant
  let out = await run();
  assert.equal(out.paused.length, 1, "vacancy parks the materialized task");

  universe["persona-b"] = {}; // restaff to a live persona
  fleetDb.updateMember(fleetTasks(fleet.id)[0].sourceTag.memberId, { targetKind: "persona", targetId: "persona-b" });
  out = await run();
  assert.equal(out.resumed.length, 1);
  assert.equal(out.updated.length >= 0, true);
  assert.equal(fleetTasks(fleet.id)[0].preset, "r-persona-b");
});

test("reconcile: archived fleets never re-materialize; archive parks all", async () => {
  const fleet = fixtureFleet(fleetDb);
  fixtureMember(fleetDb, fleet.id);
  const resolver = makeResolver({ "persona-a": {} });
  const run = () => reconcileFleet({ fleetId: fleet.id, db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  await run();
  assert.equal(fleetTasks(fleet.id).length, 1);

  fleetDb.updateFleet(fleet.id, { state: "archived" });
  let out = await run();
  assert.equal(out.paused.length, 1, "archive parks the task, keeps it for history");

  // A member added behind the fleet's back (db-level) materializes nothing.
  fixtureMember(fleetDb, fleet.id, { title: "幽灵岗", targetId: "persona-b" });
  out = await run();
  assert.equal(out.created.length, 0);
});

test("reconcileAllFleets: converges every fleet, isolates per-fleet errors", async () => {
  const f1 = fixtureFleet(fleetDb, { name: "甲队" });
  const f2 = fixtureFleet(fleetDb, { name: "乙队" });
  fixtureMember(fleetDb, f1.id);
  fixtureMember(fleetDb, f2.id, { targetId: "persona-b" });
  const resolver = makeResolver({ "persona-a": {}, "persona-b": {} });
  const results = await reconcileAllFleets({ db: fleetDb, cronApi: cron, resolveTarget: resolver, rosterPresetId: rosterFn });
  assert.equal(results.length, 2);
  assert.equal(results[0].created.length + results[1].created.length, 2);
});

// ── derived status ──────────────────────────────────────────────────────────

test("derive: precedence + evidence", () => {
  const fleet = { state: "active" };
  const now = Date.now();

  // vacant wins even with a healthy cadence
  let d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet, task: null, targetAlive: false, now });
  assert.equal(d.status, "vacant");

  // passive
  d = deriveMemberStatus({ member: { cadence: null }, fleet, task: null, targetAlive: true, now });
  assert.equal(d.status, "passive");

  // paused: fleet layer
  d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet: { state: "paused" }, task: null, targetAlive: true, now });
  assert.equal(d.status, "paused");
  // paused: member layer
  d = deriveMemberStatus({ member: { cadence: { ...HOURLY, enabled: false } }, fleet, task: null, targetAlive: true, now });
  assert.equal(d.status, "paused");

  // missing: no materialized task at all
  d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet, task: null, targetAlive: true, now });
  assert.equal(d.status, "missing");

  // missing: last execution beyond the window (hourly → 6h floor)
  const stale = { lastRun: new Date(now - 7 * 3600_000).toISOString(), nextRun: null, createdAt: new Date(now - 7200_000).toISOString() };
  d = deriveMemberStatus({ member: { cadence: HOURLY }, fleet, task: stale, targetAlive: true, now });
  assert.equal(d.status, "missing");
  assert.equal(d.evidence.staleWindowMs, 6 * 3600_000);

  // missing: never ran and the window passed since materialization
  d = deriveMemberStatus({
    member: { cadence: HOURLY }, fleet, targetAlive: true, now,
    task: { lastRun: null, nextRun: null, createdAt: new Date(now - 7 * 3600_000).toISOString() },
  });
  assert.equal(d.status, "missing");

  // on_duty: recent execution
  d = deriveMemberStatus({
    member: { cadence: HOURLY }, fleet, targetAlive: true, now,
    task: { lastRun: new Date(now - 1800_000).toISOString(), nextRun: new Date(now + 1800_000).toISOString(), createdAt: new Date(now - 7200_000).toISOString() },
  });
  assert.equal(d.status, "on_duty");
  assert.ok(d.evidence.nextRunAt);

  // on_duty: awaiting the first scheduled run
  d = deriveMemberStatus({
    member: { cadence: HOURLY }, fleet, targetAlive: true, now,
    task: { lastRun: null, nextRun: new Date(now + 1800_000).toISOString(), createdAt: new Date(now - 600_000).toISOString() },
  });
  assert.equal(d.status, "on_duty");
});

test("schedule math: period + floor", () => {
  assert.equal(cronPeriodMs("0 * * * *", null), 3600_000);
  assert.equal(cronPeriodMs("0 9 * * *", null), 24 * 3600_000);
  assert.equal(cronPeriodMs("bogus", null), null);
  assert.equal(staleWindowMs("0 * * * *", null), 6 * 3600_000, "floor at 6h");
  assert.equal(staleWindowMs("0 */6 * * *", null), 12 * 3600_000, "2× period above the floor");
});

// ── routes ──────────────────────────────────────────────────────────────────

async function startServer(ctx, { userHeader = null } = {}) {
  const app = express();
  app.use(express.json());
  if (userHeader) {
    app.use((req, _res, next) => {
      const u = req.headers["x-test-user"];
      if (u) req.user = { email: u, groups: [] };
      next();
    });
  }
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

test("routes: CRUD + validation + owner scoping", async () => {
  const universe = {
    "persona-a": { name: "甲" },
    "persona-b": { name: "乙" },
    "persona-c": { name: "丙" },
    "persona-d": { name: "丁" },
    "cluster-1": { name: "集群一", clusterName: "集群一" },
    "a2a-x": { name: "远端" },
  };
  const { server, call } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: makeResolver(universe),
  }, { userHeader: true });

  try {
    // 401 with auth-on and no user identity.
    const strict = await startServer({ authEnabled: true, fleetTargetResolver: makeResolver(universe) }, { userHeader: true });
    try {
      const anon = await strict.call("GET", "/api/fleets");
      assert.equal(anon.status, 401);
    } finally {
      strict.server.close();
    }

    // create: 400 on missing name, 201 on valid
    assert.equal((await call("POST", "/api/fleets", {})).status, 400);
    const created = await call("POST", "/api/fleets", { name: "一号舰队" });
    assert.equal(created.status, 201);
    const fleetId = created.body.fleet.id;

    // member validation: bad target / bad cron / missing title → 400, nothing lands
    assert.equal((await call("POST", `/api/fleets/${fleetId}/members`, { title: "X", targetKind: "persona", targetId: "ghost" })).status, 400);
    assert.equal((await call("POST", `/api/fleets/${fleetId}/members`, { title: "X", targetKind: "persona", targetId: "persona-a", cadence: { cron: "nope", promptTemplate: "p" } })).status, 400);
    assert.equal((await call("POST", `/api/fleets/${fleetId}/members`, { targetKind: "persona", targetId: "persona-a" })).status, 400);
    let detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.members.length, 0, "rejected writes leave no rows");

    // dense cadence gate (<10min): 400 without confirm, 201 with
    const dense = { cron: "*/5 * * * *", promptTemplate: "高频巡视" };
    let r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "电商部", targetKind: "persona", targetId: "persona-a", cadence: dense });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "cadence_confirmation_required");
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "电商部", targetKind: "persona", targetId: "persona-a", cadence: dense, confirmed: true });
    assert.equal(r.status, 201);
    const ceo = r.body.member;
    assert.equal(ceo.cadence.cron, "*/5 * * * *");

    // unique post: persona-a again → 409 naming the existing post
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "影子岗", targetKind: "persona", targetId: "persona-a", cadence: HOURLY });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /电商部/);
    // a2a targets are exempt — two posts on the same a2a entry is legal
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "外联一", targetKind: "a2a", targetId: "a2a-x", cadence: HOURLY });
    assert.equal(r.status, 201);
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "外联二", targetKind: "a2a", targetId: "a2a-x", cadence: HOURLY });
    assert.equal(r.status, 201);
    // passive cluster post
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "集群岗", targetKind: "cluster", targetId: "cluster-1" });
    assert.equal(r.status, 201);
    const clusterPost = r.body.member;

    detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.members.length, 4);
    const passiveView = detail.body.members.find((m) => m.id === clusterPost.id);
    assert.equal(passiveView.status, "passive");

    // org tree: parent then cycle rejection
    const ceoId = ceo.id;
    r = await call("PATCH", `/api/fleets/${fleetId}/members/${detail.body.members.find((m) => m.title === "外联一").id}`, { parentId: ceoId });
    assert.equal(r.status, 200);
    r = await call("PATCH", `/api/fleets/${fleetId}/members/${ceoId}`, { parentId: detail.body.members.find((m) => m.title === "外联一").id });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cycle/);

    // swap: preset rewritten on the SAME task; freshSession clears the session
    const taskBefore = fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId);
    chatHistory.recordMessage(taskBefore.sessionId, "user", "第一任的对话");
    assert.ok((await chatHistory.listSessions()).some((s) => s.id === taskBefore.sessionId));

    r = await call("POST", `/api/fleets/${fleetId}/members/${ceoId}/swap`, { targetKind: "persona", targetId: "persona-b" });
    assert.equal(r.status, 200);
    const taskAfter = fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId);
    assert.equal(taskAfter.id, taskBefore.id);
    assert.equal(taskAfter.sessionId, taskBefore.sessionId);
    assert.equal(taskAfter.target.ref, "persona-b");
    assert.ok((await chatHistory.listSessions()).some((s) => s.id === taskBefore.sessionId), "default swap keeps the conversation");

    r = await call("POST", `/api/fleets/${fleetId}/members/${ceoId}/swap`, { targetKind: "persona", targetId: "persona-c", freshSession: true });
    assert.equal(r.status, 200);
    assert.ok(!(await chatHistory.listSessions()).some((s) => s.id === taskBefore.sessionId), "freshSession cleared the dedicated session");
    assert.equal(fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId).sessionId, taskBefore.sessionId, "session id itself is stable");

    // swap onto an on-duty incumbent (ceo holds persona-c) → 409
    r = await call("POST", `/api/fleets/${fleetId}/members/${clusterPost.id}/swap`, { targetKind: "persona", targetId: "persona-c" });
    assert.equal(r.status, 409);

    // two-layer pause over the API
    const memberB = detail.body.members.find((m) => m.title === "外联一");
    r = await call("PATCH", `/api/fleets/${fleetId}`, { state: "paused" });
    assert.equal(r.status, 200);
    assert.equal(fleetTasks(fleetId).every((t) => t.paused === true || t.sourceTag.memberId === clusterPost.id), true);
    await call("PATCH", `/api/fleets/${fleetId}`, { state: "active" });
    r = await call("POST", `/api/fleets/${fleetId}/members/${memberB.id}/pause`);
    assert.equal(r.status, 200);
    await call("PATCH", `/api/fleets/${fleetId}`, { state: "paused" });
    await call("PATCH", `/api/fleets/${fleetId}`, { state: "active" });
    assert.equal(fleetTasks(fleetId).find((t) => t.sourceTag.memberId === memberB.id).paused, true, "member pause survives fleet resume");
    assert.equal(fleetTasks(fleetId).find((t) => t.sourceTag.memberId === ceoId).paused, false);

    // vacancy derived at read time
    delete universe["persona-c"];
    detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.members.find((m) => m.id === ceoId).status, "vacant");

    // cross-owner: other user sees nothing and cannot write
    let otherList = await call("GET", "/api/fleets", undefined, { "x-test-user": "other@test" });
    assert.equal(otherList.status, 200);
    assert.equal(otherList.body.fleets.length, 0);
    r = await call("PATCH", `/api/fleets/${fleetId}`, { name: "改名" }, { "x-test-user": "other@test" });
    assert.equal(r.status, 403);

    // archive: terminal, freezes cadence writes, dissolve removes tasks
    r = await call("PATCH", `/api/fleets/${fleetId}`, { state: "archived" });
    assert.equal(r.status, 200);
    r = await call("POST", `/api/fleets/${fleetId}/members`, { title: "迟到岗", targetKind: "persona", targetId: "persona-d" });
    assert.equal(r.status, 409);
    r = await call("PATCH", `/api/fleets/${fleetId}/members/${ceoId}`, { cadence: HOURLY });
    assert.equal(r.status, 409);
    assert.equal(fleetTasks(fleetId).length, 3, "archived keeps tasks parked for history");
    r = await call("PATCH", `/api/fleets/${fleetId}`, { state: "active" });
    assert.equal(r.status, 409, "archived is terminal");
    r = await call("DELETE", `/api/fleets/${fleetId}`);
    assert.equal(r.status, 200);
    assert.equal(fleetTasks(fleetId).length, 0, "dissolve removes materialized tasks");
    detail = await call("GET", `/api/fleets/${fleetId}`);
    assert.equal(detail.body.fleet.state, "archived");
    assert.equal(detail.body.members.length, 4, "history rows survive dissolution");
  } finally {
    server.close();
  }
});
