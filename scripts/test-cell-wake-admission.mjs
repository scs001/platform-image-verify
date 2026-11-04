#!/usr/bin/env node
// ── Cell wake admission tests (harden-cell-wake-admission) ──────────────────
//
// Stub-cell harness (test-cell-memory-gate lineage) with a MODEL sampler: the
// fake models the pod honestly enough to exercise the projection math —
// container used = cache + calibrated per-cell contributions of NON-parked
// cells (parked truth read from the durable registry, exactly what a real
// post-park cgroup reads). Covers:
//   1.2 park-time footprint archive (calibrated, cgroup-real, not RSS nominal)
//   2.1 wake projection admits when it fits; refuses when it doesn't
//   2.2 no footprint → current-only judgment, byte-for-byte (no warn spam)
//   2.3 sampler trouble → fail-open admits
//   3.1 eviction chain: idle-most first, one at a time, re-project each;
//       active residents and policy "always" are never candidates
//   3.2 a candidate that cannot be parked is skipped, the chain continues
//   4.1 refusal evidence carries projectedBytes/footprintBytes/evictedCellIds
//
//   node --test scripts/test-cell-wake-admission.mjs

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCellRegistry, userIdFor } from "../gateway/spawner.js";
import { createCellRegistryDb } from "../gateway/cell-registry.js";
import { newRegistryRow } from "../lib/cell-registry.js";
import { evaluateAdmission } from "../lib/proc-memory.js";

const LIMIT = 1_610_612_736; // 1536Mi — the §15.125 pod
const FLOOR = 0.15; // headroom floor: refuse below 15%
const GATEWAY_RSS = 200_000_000;
const CACHE_BYTES = 50_000_000;
const CAL = 0.6; // model's RSS→cgroup shrink (shared pages count once per container)

const STUB = `
import http from "node:http";
const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ pid: process.pid, port }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

// Model sampler: container used is a FUNCTION OF PARKED TRUTH — a cell's
// contribution counts only while its registry row is resident, so an eviction
// that parks a row frees its (calibrated) share on the next sample, the same
// way a real cgroup reads post-park water.
function makeModelSampler({ regDb, limitBytes = LIMIT } = {}) {
  const state = { cellTotals: new Map() }; // cellId → RSS-nominal total
  const sampler = {
    clearCache() { /* model is stateless */ },
    sample() {
      const parked = new Set((regDb.all() ?? []).filter((r) => r.state === "suspended").map((r) => r.cellId));
      const cells = [...state.cellTotals.entries()].map(([cellId, totalBytes]) => ({ cellId, totalBytes, processes: [] }));
      const used =
        CACHE_BYTES +
        cells.filter((c) => !parked.has(c.cellId)).reduce((s, c) => s + c.totalBytes * CAL, 0) +
        GATEWAY_RSS * CAL;
      const totalScan = cells.reduce((s, c) => s + c.totalBytes, 0) + GATEWAY_RSS;
      return { available: true, sampledAt: Date.now(), cells, gateway: { totalBytes: GATEWAY_RSS, processes: [] }, ungrouped: { totalBytes: 0, processes: [] }, container: { available: true, usedBytes: Math.round(used), limitBytes } };
    },
    admission(threshold, { projectedBytes = null } = {}) {
      return evaluateAdmission({ container: this.sample().container, threshold, projectedBytes });
    },
  };
  return { sampler, state };
}

// Expected archive value, computed with the same formula archiveFootprint uses.
function expectedFootprint(state, cellId) {
  const cells = [...state.cellTotals.entries()].map(([id, totalBytes]) => ({ cellId: id, totalBytes }));
  const cellRow = cells.find((c) => c.cellId === cellId);
  const totalScan = cells.reduce((s, c) => s + c.totalBytes, 0) + GATEWAY_RSS;
  const used =
    CACHE_BYTES +
    cells.filter((c) => c.cellId === cellId).reduce((s, c) => s + c.totalBytes * CAL, 0) + // only this cell resident
    GATEWAY_RSS * CAL;
  const ratio = Math.min(1, Math.max(0, used / totalScan));
  return Math.round(cellRow.totalBytes * ratio);
}

function makeHarness({ idleReapSecs = 3600, floor = FLOOR } = {}) {
  const harness = {};
  harness.ready = (async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "cell-wake-adm-")));
    const stub = path.join(root, "stub-cell.mjs");
    await writeFile(stub, STUB);
    harness.root = root;
    harness.regDb = createCellRegistryDb({ file: path.join(root, "cells-registry.db") });
    const { sampler, state } = makeModelSampler({ regDb: harness.regDb });
    harness.sampler = sampler;
    harness.state = state;
    harness.registry = createCellRegistry({
      dataRoot: path.join(root, "cells"),
      secret: "test-secret",
      startTimeoutMs: 15_000,
      idleReapSecs,
      serverEntry: stub,
      env: { ...process.env },
      registryDb: harness.regDb,
      procMemory: sampler,
      memoryFloor: floor,
    });
    return harness;
  })();
  return harness;
}

function cleanup(harness) {
  return async () => {
    await harness.registry.shutdown();
    await rm(harness.root, { recursive: true, force: true });
  };
}

const userA = { email: "waker@example.com" }; // the waking cell
const userB = { email: "resident@example.com" }; // a resident candidate
const idA = userIdFor(userA.email);
const idB = userIdFor(userB.email);

// Seed a parked waker with an archived footprint (deterministic T2-T8 setup).
function seedParkedWaker(harness, footprintBytes) {
  const row = { ...newRegistryRow({ cellId: idA, ownerEmail: userA.email }), state: "suspended", lastFootprintBytes: footprintBytes };
  harness.regDb.put(row);
}

test("1.2 park archives the calibrated cgroup-real footprint (not RSS nominal)", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  harness.state.cellTotals.set(idA, 300_000_000);
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
  harness.registry.stop(idA, "test park");
  await new Promise((r) => setTimeout(r, 300)); // exit handler parks the row
  const row = harness.regDb.get(idA);
  assert.equal(row.state, "suspended");
  assert.equal(row.lastFootprintBytes, expectedFootprint(harness.state, idA));
  // The calibration actually bites: a raw nominal sum would be 300MB.
  assert.ok(row.lastFootprintBytes < 300_000_000, "calibrated footprint must be below the RSS-nominal sum");
});

test("2.1 wake whose projection fits admits with zero behavior change", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 50_000_000);
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
});

test("2.1+4.1 wake projected over the floor refuses BEFORE materialization, evidence carries the projection", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  const footprint = 1_250_000_000; // current 170MB + this projects past the floor line
  seedParkedWaker(harness, footprint);
  await assert.rejects(
    () => harness.registry.ensure(userA),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.ok(err.memory.projectedBytes > LIMIT * (1 - FLOOR), "projected over the floor line");
      assert.equal(err.memory.footprintBytes, footprint);
      assert.deepEqual(err.memory.evictedCellIds, []);
      return true;
    },
  );
  // Nothing materialized, the row stays parked, the refusal is durable.
  assert.equal(harness.registry.record(userA), undefined);
  const row = harness.regDb.get(idA);
  assert.equal(row.state, "suspended");
  assert.equal(row.lastGateRefusal.footprintBytes, footprint);
  assert.ok(row.lastGateRefusal.projectedBytes > 0);
  assert.equal(row.lastGateRefusal.evictedCellIds, undefined);
});

test("3.1 projection short → idle resident evicted → wake admits (one eviction, minimal)", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  // Resident B: running, idle way past the reap window, calibrated share 120MB.
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 7200_000;
  harness.regDb.put({ ...harness.regDb.get(idB), lastUserTrafficAt: Date.now() - 7200_000 });
  const usedBefore = harness.sampler.sample().container.usedBytes;
  // Model check: current alone fits, the wake's projection does not.
  const headroomBefore = (LIMIT - usedBefore) / LIMIT;
  assert.ok(headroomBefore >= FLOOR, "precondition: current-only admission would allow");
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
  // B was parked (durable truth), its memory freed.
  assert.equal(harness.regDb.get(idB).state, "suspended");
  assert.ok(harness.sampler.sample().container.usedBytes < usedBefore);
});

test("3.1 active residents are never candidates → refusal with an empty eviction list", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB); // lastTraffic = now → active
  await assert.rejects(
    () => harness.registry.ensure(userA),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.deepEqual(err.memory.evictedCellIds, []);
      return true;
    },
  );
  assert.equal(harness.regDb.get(idB).state, "running"); // untouched
});

test("3.1 policy always resident is never a candidate", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 7200_000;
  harness.regDb.put({ ...harness.regDb.get(idB), lastUserTrafficAt: Date.now() - 7200_000, policy: "always" });
  await assert.rejects(() => harness.registry.ensure(userA), (err) => err.code === "memory_floor");
  assert.equal(harness.regDb.get(idB).state, "running");
});

test("3.2 a candidate that cannot be parked is skipped; the chain continues", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 1_100_000_000); // current(290MB w/ B resident) + this projects past the floor line
  // Sabotaged record: a child that cannot be terminated (kill is a no-op,
  // no exit event ever) — stop() survives, terminateChild throws, the chain
  // skips this candidate and continues to the next.
  harness.registry.cells.set("sabotaged000000", {
    userId: "sabotaged000000",
    email: "sabotage@example.com",
    state: "running",
    demo: false,
    startedAt: Date.now() - 9999_000,
    lastTraffic: Date.now() - 7200_000,
    port: 1,
    pid: 1,
    child: { exitCode: null, kill: () => false },
  });
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 3600_000 - 60_000; // idle past the window
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running"); // the chain reached B despite the sabotage
  assert.equal(harness.regDb.get(idB).state, "suspended");
});

test("3.3 an evicted resident re-waking converges: it may evict others or be refused — never loops", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  // Round 1: A (projected 1.1GB) evicts idle B and gets in.
  seedParkedWaker(harness, 1_100_000_000);
  harness.state.cellTotals.set(idB, 200_000_000);
  await harness.registry.ensure(userB);
  harness.registry.cells.get(idB).lastTraffic = Date.now() - 7200_000;
  await harness.registry.ensure(userA);
  // Round 2: B re-wakes with a big archive while A is ACTIVE (untouchable) →
  // refused, staying parked. Terminal state, no livelock: the refusal is the
  // convergence point the spec names (候选耗尽仍超限 SHALL 拒绝).
  harness.regDb.put({ ...harness.regDb.get(idB), lastFootprintBytes: 1_250_000_000 });
  await assert.rejects(
    () => harness.registry.ensure(userB),
    (err) => {
      assert.equal(err.code, "memory_floor");
      assert.deepEqual(err.memory.evictedCellIds, []); // A active — zero candidates
      return true;
    },
  );
  assert.equal(harness.regDb.get(idB).state, "suspended"); // terminal: parked, refused
  assert.equal(harness.regDb.get(idA).state, "running"); // A untouched
});

test("2.2 no footprint → current-only judgment, byte-for-byte legacy", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  // Parked row WITHOUT an archive (rolled in before this change): wake must
  // behave exactly like the pre-projection gate — the model's current fits.
  harness.regDb.put({ ...newRegistryRow({ cellId: idA, ownerEmail: userA.email }), state: "suspended" });
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
});

test("2.3 sampler trouble fails open and admits", async (t) => {
  const harness = makeHarness();
  t.after(cleanup(harness));
  await harness.ready;
  seedParkedWaker(harness, 900_000_000);
  harness.sampler.admission = () => { throw new Error("sampler exploded"); };
  const cell = await harness.registry.ensure(userA);
  assert.equal(cell.state, "running");
});
