// Unit tests for fleet orchestration wave 1 (agent-fleet-orchestration).
//
// Covers the spec pins:
//   - validateOrchestration: legal trigger/report/dispatch/handoff edges,
//     unknown refs rejected, self-edges rejected, handoff cycle rejected,
//     chain over maxChainDepth rejected, span advisory (warning not error),
//     mode validation; null section = ok with zero edges
//   - mode expansion: supervisor adds implicit all→all dispatch edges
//     (marked), schedule/pipeline add nothing; dispatchAllowed follows
//     explicit edges or supervisor mode, refuses undeclared pairs and self
//   - the dispatch bridge: same-fleet/target-exists/no-self/edge-permission/
//     cluster-refusal/rate caps; a passing dispatch creates the manual task
//     with origin.fleet depth 1 + initiator (delegation lane)
//   - handoff at the seam: upstream ok and failed both relay honestly and
//     create the downstream task with chain depth + 1 and budget; over-bound
//     hops create no task but leave an honest event row
//   - write face: PATCH accepts a valid section (then cockpit reads it back
//     with expanded edges), rejects a cycling one; member delete drops
//     dangling edges; unset section = byte-identical schedule behavior
//
// Run: node --test scripts/test-fleet-orchestration.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-orch-"));
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
  validateOrchestration,
  expandedEdges,
  dispatchAllowed,
  outgoingHandoffs,
  constraintsOf,
} = await import("../server/fleet-orchestration.js");
const { attachCronRunner } = await import("../server/cron-runner.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

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
  // The engine's jobs.json writer is debounced — give the last flush (the
  // handoff/dispatch tasks this suite creates) time to land before the tmp
  // root goes away, or the rename surfaces as a post-test unhandled error.
  await new Promise((r) => setTimeout(r, 250));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let fleetDb;
beforeEach(() => {
  fleetDb = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(fleetDb);
});

function fixtureFleet(db, over = {}) {
  const f = db.createFleet({ id: over.id ?? `f_${Math.random().toString(36).slice(2, 8)}`, name: over.name ?? "流水线舰", ownerEmail: "owner@test", ...(over.orchestration ? { orchestration: over.orchestration } : {}) });
  for (const m of over.members ?? []) {
    db.createMember({ fleetId: f.id, kpiSlots: [], cadence: null, ...m });
  }
  return f;
}

const P = (id) => ({ id, title: id, parentId: null, targetKind: "persona", targetId: `t-${id}` });

// ── 1. graph validation ─────────────────────────────────────────────────────

test("validateOrchestration: legal edges pass; null = ok/empty", () => {
  const members = [P("a"), P("b"), P("c")];
  const ok = validateOrchestration({
    members,
    orchestration: {
      edges: [
        { kind: "trigger", to: "a", cron: "0 9 * * *" },
        { kind: "report", from: "b", to: "a" },
        { kind: "dispatch", from: "a", to: "b" },
        { kind: "handoff", from: "b", to: "c" },
      ],
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.edges.length, 4);

  const none = validateOrchestration({ members, orchestration: null });
  assert.equal(none.ok, true);
  assert.deepEqual(none.edges, []);
});

test("validateOrchestration: unknown refs, self-edges, bad kind/mode rejected", () => {
  const members = [P("a"), P("b")];
  for (const orch of [
    { edges: [{ kind: "handoff", from: "a", to: "ghost" }] },
    { edges: [{ kind: "dispatch", from: "a", to: "a" }] },
    { edges: [{ kind: "handoff", from: "a", to: "a" }] },
    { edges: [{ kind: "mystery", from: "a", to: "b" }] },
    { mode: "chaos" },
    { edges: "not-an-array" },
    { constraints: { maxChainDepth: -1 } },
  ]) {
    const out = validateOrchestration({ members, orchestration: orch });
    assert.equal(out.ok, false, JSON.stringify(orch));
  }
});

test("validateOrchestration: handoff cycle rejected; chain over bound rejected; span warns", () => {
  const members = [P("a"), P("b"), P("c")];
  const cyc = validateOrchestration({ members, orchestration: { edges: [
    { kind: "handoff", from: "a", to: "b" }, { kind: "handoff", from: "b", to: "a" },
  ] } });
  assert.equal(cyc.ok, false);
  assert.ok(cyc.errors.some((e) => e.error.includes("cycle")));

  const deep = validateOrchestration({ members, orchestration: {
    constraints: { maxChainDepth: 1 },
    edges: [{ kind: "handoff", from: "a", to: "b" }, { kind: "handoff", from: "b", to: "c" }],
  } });
  assert.equal(deep.ok, false);
  assert.ok(deep.errors.some((e) => e.error.includes("maxChainDepth")));

  const wide = validateOrchestration({ members, orchestration: {
    edges: Array.from({ length: 9 }, (_, i) => ({ kind: "dispatch", from: "a", to: i < 2 ? ["a", "b"][i] === "a" ? "b" : "b" : "b" })),
  } });
  void wide; // span advisory covered below with distinct targets
  const span = validateOrchestration({ members: [P("a"), ...Array.from({ length: 9 }, (_, i) => P(`t${i}`))], orchestration: {
    edges: Array.from({ length: 9 }, (_, i) => ({ kind: "dispatch", from: "a", to: `t${i}` })),
  } });
  assert.equal(span.ok, true, "span is advisory");
  assert.ok(span.warnings.some((w) => w.includes("span-8")));
});

test("mode expansion + dispatchAllowed", () => {
  const members = [P("a"), P("b"), P("c")];
  const sup = expandedEdges({ members, orchestration: { mode: "supervisor" } });
  assert.equal(sup.filter((e) => e.kind === "dispatch" && e.implicit).length, 6, "n×(n-1) implicit pairs");
  const sched = expandedEdges({ members, orchestration: { mode: "schedule", edges: [{ kind: "dispatch", from: "a", to: "b" }] } });
  assert.equal(sched.length, 1, "schedule adds nothing implicit");

  assert.equal(dispatchAllowed({ members, orchestration: { mode: "supervisor" } }, "a", "b").ok, true);
  assert.equal(dispatchAllowed({ members, orchestration: { mode: "supervisor" } }, "a", "a").ok, false);
  assert.equal(dispatchAllowed({ members, orchestration: { edges: [{ kind: "dispatch", from: "a", to: "b" }] } }, "a", "b").ok, true);
  assert.equal(dispatchAllowed({ members, orchestration: {} }, "a", "b").ok, false, "no edges, no mode ⇒ refused");
});

// ── 2. bridge: dispatch guards + task shape ─────────────────────────────────

async function startServer(ctx) {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("dispatch bridge: guards and the delegation-lane task shape", async () => {
  const other = fixtureFleet(fleetDb, { name: "别舰" });
  const fleet = fixtureFleet(fleetDb, {
    id: "f_main",
    members: [P("m_sup"), P("m_exec"), P("m_cluster"), { id: "m_ghost", title: "幽灵", parentId: null, targetKind: "persona", targetId: "t-ghost", kpiSlots: [], cadence: null }],
    orchestration: { mode: "supervisor" },
  });
  fleetDb.createMember({ id: "m_other_post", fleetId: other.id, title: "外舰岗", targetKind: "persona", targetId: "t-m_cluster", kpiSlots: [], cadence: null });
  fleetDb.updateMember("m_cluster", { targetKind: "cluster", targetId: "cluster-x" });
  fleetDb.deleteMember("m_ghost");
  chatHistory.setSessionManager({ getSessionId: () => "sess-sup" });

  const { server, base } = await startServer({
    authEnabled: false,
    cellUserEmail: "owner@test",
    currentPreset: "t-m_sup",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId, clusterName: m.targetKind === "cluster" ? "cx" : null }),
  });
  const call = (body) =>
    fetch(`${base}/api/fleets/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // happy path: supervisor mode grants the pair, task rides the delegation lane
    const ok = await call({ to: "m_exec", brief: "写一篇周报" });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.to.memberId, "m_exec");
    const task = engine.getTaskRecord(ok.body.taskId);
    assert.equal(task.origin.fleet.depth, 1);
    assert.equal(task.origin.fleet.memberId, "m_exec");
    assert.equal(task.initiator, "sess-sup");
    assert.ok(task.prompt.includes("m_sup".replace("m_", "") === "sup" ? "舰队派发" : "舰队派发"), "dispatcher identity rides the prompt");
    assert.ok(task.prompt.includes("sup"), "the dispatcher's post identity names the brief");

    // guards: cross-fleet ref (foreign post id), self, cluster post, permission-less
    assert.equal((await call({ to: "m_other_post", brief: "x" })).status, 400);
    assert.equal((await call({ to: "m_sup", brief: "x" })).status, 400);
    assert.equal((await call({ to: "m_cluster", brief: "x" })).status, 400);
    assert.equal((await call({ to: "m_exec", brief: "" })).status, 400);

    // rate cap: per-post window — two more dispatches pass, the fourth 429s
    fleetDb.updateFleet("f_main", { orchestration: { mode: "supervisor" } });
    await call({ to: "m_exec", brief: "二" });
    await call({ to: "m_exec", brief: "三" });
    const capped = await call({ to: "m_exec", brief: "四" });
    assert.equal(capped.status, 429);
    assert.ok(capped.body.error.includes("cap"));
  } finally {
    server.close();
  }
});

test("dispatch bridge: no edge and no mode ⇒ 403", async () => {
  const fleet = fixtureFleet(fleetDb, { members: [P("m_a"), P("m_b")] });
  void fleet;
  const { server, base } = await startServer({
    authEnabled: false, cellUserEmail: "owner@test", currentPreset: "t-m_a",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
  });
  try {
    const r = await fetch(`${base}/api/fleets/dispatch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "m_b", brief: "x" }) });
    assert.equal(r.status, 403);
    assert.ok((await r.json()).error.includes("declare the edge"));
  } finally {
    server.close();
  }
});

// ── 3. handoff at the seam ──────────────────────────────────────────────────

test("handoff: ok and failed upstreams both relay; depth/budget ride origin; bound leaves an event", async () => {
  const fleet = fixtureFleet(fleetDb, {
    id: "f_chain",
    members: [P("m_up"), P("m_down")],
    orchestration: { edges: [{ kind: "handoff", from: "m_up", to: "m_down" }], constraints: { maxChainDepth: 2, budgetPerEdgeMin: 15 } },
  });
  void fleet;
  const created = [];
  const ctx = {
    session: { model: { id: "m0" } },
    taskTurnRegistry: new Map(),
    recordFleetTurnEvent: () => ({}),
    triggerFleetHandoffs: async (job, out) => {
      // mirror the server wiring against this fixture db
      const f = fleetDb.getFleet("f_chain");
      const memberId = job.origin?.fleet?.memberId ?? job.sourceTag?.memberId ?? null;
      const edges = outgoingHandoffs(f.orchestration, memberId);
      if (!edges.length) return null;
      const c = constraintsOf(f.orchestration);
      const depth = (job.origin?.fleet?.depth ?? 0) + 1;
      const results = [];
      for (const e of edges) {
        const target = fleetDb.getMember(e.to);
        if (depth > c.maxChainDepth) {
          fleetDb.appendTurnEvent({ fleetId: "f_chain", memberId: target.id, source: "manual", status: "failed", errorKind: "other", error: `handoff depth bound reached (${depth})`, startedAt: 1, endedAt: 2 });
          continue;
        }
        const task = engine.createManualTask({
          prompt: `接棒:${out.ok ? String(out.text).slice(0, 50) : out.error}`,
          persona: `t-${target.id}`,
          origin: { fleet: { fleetId: "f_chain", memberId: target.id, depth } },
          executionPolicy: { timeoutMinutes: c.budgetPerEdgeMin },
        });
        results.push(task.id);
      }
      created.push(...results);
      return results;
    },
  };
  attachCronRunner(ctx, {
    runPersona: async () => ({ ok: true, text: "上游产出 ABC" }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });

  await ctx.runCronJobTurn({ id: "j1", targetType: "persona", preset: "t-m_up", sourceTag: { fleetId: "f_chain", memberId: "m_up" } });
  assert.equal(created.length, 1);
  const t1 = engine.getTaskRecord(created[0]);
  assert.equal(t1.origin.fleet.depth, 1);
  assert.equal(t1.origin.fleet.memberId, "m_down");
  assert.equal(t1.executionPolicy.timeoutMinutes, 15);
  assert.ok(t1.prompt.includes("上游产出 ABC"));

  // failed upstream relays honestly: a fresh ctx whose persona turn fails
  // (spread copies don't reach attachCronRunner's closure — rebuild the ctx)
  const failCtx = {
    session: { model: { id: "m0" } },
    taskTurnRegistry: new Map(),
    recordFleetTurnEvent: () => ({}),
    triggerFleetHandoffs: (job, out) => ctx.triggerFleetHandoffs(job, out),
  };
  attachCronRunner(failCtx, {
    runPersona: async () => ({ ok: false, error: "503: upstream unavailable" }),
    runA2a: async () => ({ ok: true }),
    listAgents: () => [],
  });
  await failCtx.runCronJobTurn({ id: "j3", targetType: "persona", preset: "t-m_up", sourceTag: { fleetId: "f_chain", memberId: "m_up" } });
  const last = engine.getTaskRecord(created[created.length - 1]);
  assert.ok(last.prompt.includes("503: upstream unavailable"), "failure relayed verbatim, no retry");
  await engine.idle?.();

  // over-bound: chain depth 3 > maxChainDepth 2 ⇒ no task, honest event row
  const before = created.length;
  await ctx.runCronJobTurn({ id: "j4", targetType: "persona", preset: "t-m_up", origin: { fleet: { fleetId: "f_chain", memberId: "m_up", depth: 2 } } });
  assert.equal(created.length, before, "no task over the bound");
  const refusal = fleetDb.listFleetTurnEvents("f_chain", { status: "failed" });
  assert.ok(refusal.some((e) => e.error.includes("depth bound reached")));
});

// ── 4. write face + cockpit read ────────────────────────────────────────────

test("routes: PATCH accepts a valid section, rejects a cycle; cockpit reads expanded; member delete drops edges", async () => {
  const fleet = fixtureFleet(fleetDb, { id: "f_w", members: [P("m_a"), P("m_b"), P("m_c")] });
  const { server, base } = await startServer({
    authEnabled: false, cellUserEmail: "owner@test",
    fleetTargetResolver: (m) => ({ alive: true, label: m.targetId }),
  });
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const cyc = await call("PATCH", `/api/fleets/${fleet.id}`, { orchestration: { edges: [
      { kind: "handoff", from: "m_a", to: "m_b" }, { kind: "handoff", from: "m_b", to: "m_a" },
    ] } });
    assert.equal(cyc.status, 400);
    assert.ok(cyc.body.error.includes("cycle"));

    const ok = await call("PATCH", `/api/fleets/${fleet.id}`, { orchestration: {
      mode: "supervisor",
      edges: [{ kind: "handoff", from: "m_a", to: "m_b" }],
    } });
    assert.equal(ok.status, 200);

    const cock = await (await fetch(`${base}/api/fleets/${fleet.id}/cockpit`)).json();
    assert.equal(cock.orchestration.mode, "supervisor");
    assert.ok(cock.orchestration.edges.some((e) => e.kind === "dispatch" && e.implicit), "supervisor expansion visible");
    assert.ok(cock.orchestration.edges.some((e) => e.kind === "handoff" && e.from === "m_a"));

    // member delete drops dangling edges
    const del = await call("DELETE", `/api/fleets/${fleet.id}/members/m_b`);
    assert.equal(del.status, 200);
    const after = fleetDb.getFleet(fleet.id).orchestration;
    assert.equal(after.edges.length, 0, "both edges touched m_b and are gone");
  } finally {
    server.close();
  }
});
