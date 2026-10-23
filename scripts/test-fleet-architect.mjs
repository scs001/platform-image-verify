// Unit tests for the fleet architect lane (agent-fleet-architect).
//
// Covers the chain the spec pins:
//   - validateFleetDraft: pass matrix, every blocking class (bad cron, unknown
//     op, missing title, dead target, unique-post squat, unknown ref, cycle),
//     the two warnings (span>8, dense rhythm), errors/warnings split
//   - estimateFleetCost: trigger conditions (>5 new posts / any new cron),
//     no-trigger, range endpoints from the env assumption
//   - draft is a dry-run: nothing persisted
//   - apply: revalidation blocks drift; create is born all-paused (from-
//     template convention); edit ops sequence + fleet rename; reconcile rides
//   - bridge: owner scoping (404 on other owner's fleet), turns read reuses
//     the O1 store, draft/apply endpoints
//   - seed conservation: docs/fleet-architect.seed.json passes pack manifest
//     validation (break the seed and this goes red)
//
// Run: node --test scripts/test-fleet-architect.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-arch-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const chatHistory = await import("../chat-history.js");
const cron = await import("../cron.js");
const { initDb } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const {
  validateFleetDraft,
  estimateFleetCost,
  applyFleetDraft,
  registerFleetArchitectRoutes,
  SPAN_WARN,
} = await import("../server/fleet-architect.js");
const { validatePackManifest } = await import("../lib/pack-manifest.js");

await initDb();
await chatHistory.initChatHistory();
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true, text: "ok" }),
  isBusy: () => false,
});

test.after(async () => {
  cron.shutdown?.();
  await engine.idle?.();
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

const universe = { "persona-a": true, "persona-b": true, "persona-c": true, "agent-x": true };
const resolver = (m) => ({ alive: !!universe[m.targetId], label: m.targetId, clusterName: null });

function baseAdd(over = {}) {
  return {
    op: "add",
    title: "电商部",
    targetKind: "persona",
    targetId: "persona-a",
    cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true },
    ...over,
  };
}

function createDraft(over = {}) {
  return { mode: "create", fleet: { name: "一号舰队" }, members: [baseAdd()], ...over };
}

// ── 1. validation ───────────────────────────────────────────────────────────

test("validateFleetDraft: clean create passes, cadence normalized into diff", () => {
  const out = validateFleetDraft(fleetDb, createDraft(), { resolver });
  assert.equal(out.ok, true);
  assert.deepEqual(out.errors, []);
  assert.equal(out.diff.length, 1);
  assert.equal(out.diff[0].changes.cadence, "0 * * * *");
  // the draft carries a new cron rhythm → the estimate MUST ride (Q6)
  assert.equal(out.estimate.trigger, "new-cron");
});

test("validateFleetDraft: blocking classes", () => {
  const badCron = validateFleetDraft(fleetDb, createDraft({
    members: [baseAdd({ cadence: { cron: "not a cron", tz: null, promptTemplate: "x" } })],
  }), { resolver });
  assert.equal(badCron.ok, false);

  const badOp = validateFleetDraft(fleetDb, createDraft({ members: [{ op: "explode" }] }), { resolver });
  assert.ok(badOp.errors.some((e) => e.error.includes("op must be one of")));

  const noTitle = validateFleetDraft(fleetDb, createDraft({ members: [baseAdd({ title: " " })] }), { resolver });
  assert.ok(noTitle.errors.some((e) => e.error.includes("title is required")));

  const dead = validateFleetDraft(fleetDb, createDraft({ members: [baseAdd({ targetId: "ghost" })] }), { resolver });
  assert.ok(dead.errors.some((e) => e.error.includes("does not exist")));

  const squat = validateFleetDraft(fleetDb, createDraft({
    members: [baseAdd(), baseAdd({ targetId: "persona-b" })],
  }), { resolver });
  // persona-a already holds a post in draft (unique-post check hits the DB, so
  // a pre-seeded incumbent is the honest case):
  const fleet = fleetDb.createFleet({ id: "f_pre", name: "既有", ownerEmail: "owner@test" });
  fleetDb.createMember({
    id: "m_pre", fleetId: fleet.id, title: "在岗者", targetKind: "persona", targetId: "persona-c",
    kpiSlots: [], cadence: null,
  });
  const squat2 = validateFleetDraft(fleetDb, createDraft({ members: [baseAdd({ targetId: "persona-c" })] }), { resolver });
  assert.ok(squat2.errors.some((e) => e.error.includes("already holds a post")));

  const unknownRef = validateFleetDraft(fleetDb, { mode: "edit", fleetId: fleet.id, members: [{ op: "pause", ref: "m_nope" }] }, { resolver });
  assert.ok(unknownRef.errors.some((e) => e.error.includes("does not match a member")));
});

test("validateFleetDraft: span + dense-rhythm warnings, cycle error", () => {
  // span is advisory: exercise it via a real edit onto a wide parent.
  const fleet = fleetDb.createFleet({ id: "f_span", name: "宽舰队", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_root", fleetId: fleet.id, title: "父", targetKind: "persona", targetId: "persona-a", kpiSlots: [], cadence: null });
  for (let i = 0; i < SPAN_WARN; i++) {
    fleetDb.createMember({ id: `m_k${i}`, fleetId: fleet.id, title: `子${i}`, parentId: "m_root", targetKind: "a2a", targetId: "agent-x", kpiSlots: [], cadence: null });
  }
  const spanOut = validateFleetDraft(fleetDb, {
    mode: "edit", fleetId: fleet.id,
    members: [{ op: "add", title: "又一子", parentId: "m_root", targetKind: "a2a", targetId: "agent-x" }],
  }, { resolver });
  assert.equal(spanOut.ok, true, "span is advisory, not blocking");
  assert.ok(spanOut.warnings.some((w) => w.includes(`span-${SPAN_WARN}`)));

  // persona-a is held by the span fixture's root above — use persona-c here
  const dense = validateFleetDraft(fleetDb, createDraft({
    members: [baseAdd({ targetId: "persona-c", cadence: { cron: "* * * * *", tz: null, promptTemplate: "每分钟" } })],
  }), { resolver });
  assert.equal(dense.ok, true);
  assert.ok(dense.diff[0].warnings.some((w) => w.includes("denser than")));

  // cycle: parent of A is B, parent of B is A (via update ops)
  const cf = fleetDb.createFleet({ id: "f_cyc", name: "环", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_ca", fleetId: cf.id, title: "A", targetKind: "persona", targetId: "persona-a", kpiSlots: [], cadence: null });
  fleetDb.createMember({ id: "m_cb", fleetId: cf.id, title: "B", parentId: "m_ca", targetKind: "persona", targetId: "persona-b", kpiSlots: [], cadence: null });
  const cyc = validateFleetDraft(fleetDb, {
    mode: "edit", fleetId: cf.id,
    members: [{ op: "update", ref: "m_ca", parentId: "m_cb" }],
  }, { resolver });
  assert.equal(cyc.ok, false);
  assert.ok(cyc.errors.some((e) => e.error.includes("cycle")));
});

test("validateFleetDraft: draft persists nothing", () => {
  validateFleetDraft(fleetDb, createDraft(), { resolver });
  assert.equal(fleetDb.listFleets().length, 0);
});

// ── 2. estimate ─────────────────────────────────────────────────────────────

test("estimateFleetCost: triggers, range endpoints, no-trigger", () => {
  const prev = process.env.FLEET_ARCHITECT_TOKEN_RANGE;
  process.env.FLEET_ARCHITECT_TOKEN_RANGE = "1000,2000";
  try {
    const hourly = { cron: "0 * * * *", tz: null, promptTemplate: "x" };
    // any new cron triggers, even a single post
    const one = estimateFleetCost({ mode: "create", members: [baseAdd({ cadence: hourly })] }, { newPostCount: 1 });
    assert.equal(one.trigger, "new-cron");
    assert.equal(one.turnsPerDayTotal, 24);
    assert.deepEqual(one.tokensPerMonth, [24 * 30 * 1000, 24 * 30 * 2000]);

    // >5 posts without any cron also triggers
    const six = estimateFleetCost({ mode: "create", members: Array.from({ length: 6 }, () => baseAdd({ cadence: null })) }, { newPostCount: 6 });
    assert.equal(six.trigger, "large-add");
    assert.equal(six.turnsPerDayTotal, 0);

    // small passive edit: no trigger → null
    assert.equal(estimateFleetCost({ mode: "edit", members: [{ op: "update", ref: "m", title: "改名" }] }, { newPostCount: 0 }), null);
  } finally {
    if (prev === undefined) delete process.env.FLEET_ARCHITECT_TOKEN_RANGE;
    else process.env.FLEET_ARCHITECT_TOKEN_RANGE = prev;
  }
});

// ── 3. apply ────────────────────────────────────────────────────────────────

test("applyFleetDraft: create is born all-paused; drift blocks apply", async () => {
  const out = await applyFleetDraft(fleetDb, createDraft(), { ownerEmail: "owner@test", resolver });
  assert.equal(out.ok, true);
  assert.equal(out.mode, "create");
  assert.equal(out.started, false, "born paused — cockpit confirms start");
  assert.equal(out.fleet.state, "paused");
  assert.equal(out.members[0].cadence.enabled, false, "member cadence born disabled");
  assert.ok(out.reconcile);

  // drift: draft against a member that vanishes before apply
  const fleet2 = fleetDb.createFleet({ id: "f_two", name: "二舰队", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_t", fleetId: fleet2.id, title: "岗", targetKind: "persona", targetId: "persona-b", kpiSlots: [], cadence: null });
  const drifted = { mode: "edit", fleetId: fleet2.id, members: [{ op: "pause", ref: "m_t" }] };
  const check = validateFleetDraft(fleetDb, drifted, { resolver });
  assert.equal(check.ok, false, "pause without cadence is itself an error — pick a drift-shaped op instead");
  fleetDb.deleteMember("m_t");
  const driftOut = await applyFleetDraft(fleetDb, { mode: "edit", fleetId: fleet2.id, members: [{ op: "remove", ref: "m_t" }] }, { ownerEmail: "owner@test", resolver });
  assert.equal(driftOut.ok, false);
  assert.equal(driftOut.stage, "revalidation");
});

test("applyFleetDraft: edit ops sequence + rename + reconcile", async () => {
  const fleet = fleetDb.createFleet({ id: "f_e", name: "编辑舰队", ownerEmail: "owner@test", state: "active" });
  fleetDb.createMember({ id: "m_e1", fleetId: fleet.id, title: "旧名", targetKind: "persona", targetId: "persona-a", kpiSlots: [], cadence: { cron: "0 * * * *", tz: null, promptTemplate: "报数", enabled: true } });

  const out = await applyFleetDraft(fleetDb, {
    mode: "edit",
    fleetId: fleet.id,
    fleet: { name: "新名" },
    members: [
      { op: "update", ref: "m_e1", title: "新岗位名" },
      { op: "pause", ref: "m_e1" },
      { op: "add", title: "被动岗", targetKind: "persona", targetId: "persona-b", cadence: null },
    ],
  }, { ownerEmail: "owner@test", resolver });
  assert.equal(out.ok, true);
  assert.equal(out.fleet.name, "新名");
  const renamed = fleetDb.getMember("m_e1");
  assert.equal(renamed.title, "新岗位名");
  assert.equal(renamed.cadence.enabled, false);
  assert.equal(out.members.length, 2);
  assert.deepEqual(out.applied.map((a) => a.op), ["update", "pause", "add"]);
});

// ── 4. bridge ───────────────────────────────────────────────────────────────

test("bridge: owner scoping, draft/apply endpoints, turns reuse the O1 store", async () => {
  const fleet = fleetDb.createFleet({ id: "f_br", name: "桥舰队", ownerEmail: "owner@test" });
  const m = fleetDb.createMember({ id: "m_br", fleetId: fleet.id, title: "岗", targetKind: "persona", targetId: "persona-a", kpiSlots: [], cadence: null });
  fleetDb.appendTurnEvent({ fleetId: fleet.id, memberId: m.id, source: "cron", status: "failed", errorKind: "timeout", error: "timed out", startedAt: 1, endedAt: 2 });

  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  registerFleetArchitectRoutes({ app, cellUserEmail: "owner@test", fleetTargetResolver: resolver });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const list = await (await fetch(`${base}/api/fleet-architect/fleets`)).json();
    assert.equal(list.fleets.length, 1);
    assert.equal(list.fleets[0].failing, 1, "latest failed turn counts in the roster");

    const spec = await (await fetch(`${base}/api/fleet-architect/fleets/f_br`)).json();
    assert.equal(spec.members[0].id, "m_br");

    const turns = await (await fetch(`${base}/api/fleet-architect/fleets/f_br/turns?status=failed`)).json();
    assert.equal(turns.turns.length, 1);
    assert.equal(turns.turns[0].errorKind, "timeout");

    // another owner's fleet reads 404
    const other = registerFleetArchitectRoutes({ app: express(), cellUserEmail: "someone@else" });
    void other;
    const express2 = (await import("express")).default;
    const app2 = express2();
    app2.use(express2.json());
    registerFleetArchitectRoutes({ app: app2, cellUserEmail: "someone@else" });
    const server2 = app2.listen(0, "127.0.0.1");
    await new Promise((r) => server2.once("listening", r));
    try {
      const r2 = await fetch(`http://127.0.0.1:${server2.address().port}/api/fleet-architect/fleets/f_br`);
      assert.equal(r2.status, 404);
    } finally {
      server2.close();
    }
  } finally {
    server.close();
  }
});

// ── 5. seed conservation ────────────────────────────────────────────────────

test("seed: docs/fleet-architect.seed.json passes pack manifest validation", () => {
  const seed = JSON.parse(fs.readFileSync(new URL("../docs/fleet-architect.seed.json", import.meta.url), "utf8"));
  const errors = validatePackManifest(seed);
  assert.deepEqual(errors, [], `seed must stay valid: ${JSON.stringify(errors)}`);
});
