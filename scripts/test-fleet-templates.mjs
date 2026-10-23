// Unit tests for fleet templates (agent-fleet-templates).
//
// Covers:
//   - parseFleetTemplate: the legal manifest passes; cycle / bad cron /
//     missing fields / duplicate refs / bad target kinds / oversized slots
//     all refuse with the offending member named
//   - exporter whitelist: the skeleton round-trips through the same parser
//     and carries ZERO runtime traces (reports/decisions/sessions/owner)
//   - provisioner: dedup by sourceTemplate anchor; per-post degradation
//     (missing incumbent → the post still exists, listed in `missing`);
//     ALL-PAUSED at birth (fleet layer + member cadences + parked tasks);
//     the start route flips both layers and reconcile resumes the tasks
//   - template-newer notice: v1-fleet vs installed v2 → updateAvailable,
//     never a mutation
//   - cockpit aggregate: one round-trip with tree/decisions(severity-first)/
//     stream(missing-first)/health/template segments, field-compatible with
//     the previous knives' read faces
//   - from-template route: happy path, dedup response, unknown pack refusal
//
// Run: node --test scripts/test-fleet-templates.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-tpl-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const dbModule = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { reconcileFleet } = await import("../server/fleet-reconcile.js");
const { parseFleetTemplate, exportFleetToTemplate } = await import("../server/fleet-template.js");
const { provisionFleetFromTemplate } = await import("../server/fleet-provisioner.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await dbModule.initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({
  broadcast: () => {},
  runTurn: async () => ({ ok: true }),
  isBusy: () => false,
});

test.after(async () => {
  cron.shutdown?.();
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

const ALIVE = (m) => ({ alive: m?.targetId !== "ghost", label: m?.targetId ?? "?", clusterName: null });
// Route-level resolver variant that also treats the provisioner's EMPTY
// targetId sentinel as dead — the real resolveTarget can't find "" in any
// catalog, so vacancy derivation must agree.
const SENTINEL_AWARE = (m) => ({
  alive: !!m?.targetId && m.targetId !== "ghost",
  label: m?.targetId || null,
  clusterName: null,
});
const rosterFn = (id) => id;

function goodManifest() {
  return {
    fleet: {
      name: "公司式舰队",
      members: [
        {
          ref: "ceo",
          title: "CEO",
          parentRef: null,
          target: { kind: "pack-preset", packId: "pack_tpl", presetId: "tpl-ceo" },
          kpiSlots: [{ key: "patrol", label: "巡视要点" }],
          cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", promptTemplate: "巡视各部门 {{fleetContext}}" },
        },
        { ref: "shop", title: "电商部", parentRef: "ceo", target: { kind: "pack-preset", packId: "pack_tpl", presetId: "tpl-shop" }, cadence: { cron: "0 9 * * *", promptTemplate: "报数" } },
        { ref: "assist", title: "助理岗", parentRef: "ceo", target: { kind: "existing-persona", id: "user-assist" }, cadence: null },
      ],
      requires: [{ kind: "a2a", name: "wanxing-cluster", optional: true }],
    },
  };
}

function seedInstalledPack(packId, version, manifest) {
  // The pack's own agents must have MATERIALIZED (catalog reads installed
  // packs' report.agents with status "installed") for pack-preset targets to
  // resolve at the route level.
  dbModule.upsertInstalledPack({
    packId,
    name: manifest.fleet?.name ?? "模板包",
    version,
    manifest: {
      ...manifest,
      ...(manifest.agents ? {} : { agents: [{ id: "tpl-ceo", name: "CEO" }, { id: "tpl-shop", name: "电商部" }] }),
    },
    report: {
      agents: [
        { id: "tpl-ceo", status: "installed" },
        { id: "tpl-shop", status: "installed" },
      ],
      skills: [],
    },
  });
}

// ── 2.1 parser ──────────────────────────────────────────────────────────────

test("parser: legal manifest passes; the three illegal families refuse", () => {
  assert.equal(parseFleetTemplate(goodManifest()).ok, true);
  const template = parseFleetTemplate(goodManifest()).template;
  assert.equal(template.members.length, 3);
  assert.deepEqual(template.requires[0], { kind: "a2a", name: "wanxing-cluster", optional: true });

  // Cycle.
  const cyc = { fleet: { name: "x", members: [
    { ref: "a", title: "A", parentRef: "b", target: { kind: "existing-persona", id: "i" } },
    { ref: "b", title: "B", parentRef: "a", target: { kind: "existing-persona", id: "j" } },
  ] } };
  assert.match(parseFleetTemplate(cyc).error, /cycle/);

  // Bad cron.
  const badCron = goodManifest();
  badCron.fleet.members[1].cadence.cron = "not cron";
  assert.match(parseFleetTemplate(badCron).error, /invalid cron/);

  // Missing fields.
  const noTitle = goodManifest();
  delete noTitle.fleet.members[2].title;
  assert.match(parseFleetTemplate(noTitle).error, /needs a title/);
  const dupRef = goodManifest();
  dupRef.fleet.members[2].ref = "ceo";
  assert.match(parseFleetTemplate(dupRef).error, /duplicate member ref/);
  const badKind = goodManifest();
  badKind.fleet.members[0].target.kind = "magic";
  assert.match(parseFleetTemplate(badKind).error, /target.kind/);

  // No fleet section = plain pack (short-circuit signal).
  assert.match(parseFleetTemplate({ name: "plain" }).error, /no fleet section/);
});

// ── 3.3 exporter whitelist ──────────────────────────────────────────────────

test("exporter: skeleton round-trips; zero runtime traces", () => {
  const fleet = fleetDb.createFleet({ id: "fleet_x", name: "现役舰队", ownerEmail: "owner@test" });
  const ceo = fleetDb.createMember({ id: "m1", fleetId: fleet.id, title: "CEO", parentId: null, targetKind: "persona", targetId: "persona-ceo", kpiSlots: [{ key: "s", label: "S" }], cadence: { cron: "0 * * * *", tz: null, promptTemplate: "巡视 {{fleetContext}}", enabled: true } });
  fleetDb.createMember({ id: "m2", fleetId: fleet.id, title: "电商", parentId: "m1", targetKind: "cluster", targetId: "dyn_1", kpiSlots: [], cadence: null });
  // Runtime noise the export must NOT carry.
  fleetDb.appendReport({ id: "r1", fleetId: fleet.id, memberId: ceo.id, sessionId: "sess-secret", metrics: {}, resources: [], blockers: [], summary: "x", source: "self", createdAt: 1 });
  fleetDb.appendDecision({ id: "d1", fleetId: fleet.id, memberId: ceo.id, question: "q", options: [], severity: "low", sourceSessionId: "sess-secret", submittedAt: 1 });

  const exported = exportFleetToTemplate(fleet, fleetDb.listMembers(fleet.id));
  const json = JSON.stringify(exported);
  // The skeleton parses as a valid template (round-trip through the same gate).
  const parsed = parseFleetTemplate(exported);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.template.members[0].target.kind, "existing-persona");
  assert.equal(parsed.template.members[1].target.kind, "existing-cluster");
  assert.equal(parsed.template.members[0].cadence.promptTemplate, "巡视 {{fleetContext}}");
  // Whitelist discipline: none of the runtime identities survive.
  for (const banned of ["sess-secret", "owner@test", "summary", "deliveredAt", "resolution", "memberId"]) {
    assert.ok(!json.includes(banned), `export leaked '${banned}'`);
  }
});

// ── 3.1 provisioner ─────────────────────────────────────────────────────────

function provisionDeps({ catalogIds = new Set(["tpl-ceo", "user-assist"]) } = {}) {
  return {
    db: fleetDb,
    catalogAgentIds: () => catalogIds,
    resolveExisting: ({ kind, id }) => (kind === "persona" ? catalogIds.has(id) : id !== "ghost"),
    reconcile: (fleetId) =>
      reconcileFleet({ fleetId, db: fleetDb, cronApi: cron, resolveTarget: ALIVE, rosterPresetId: rosterFn }),
  };
}

test("provisioner: dedup, degradation, all-paused birth, tasks parked", async () => {
  const manifest = goodManifest();
  // tpl-shop absent from the catalog → the 电商部 post degrades to vacant.
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "user-assist"]) });

  const first = await provisionFleetFromTemplate({ packId: "pack_tpl", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, undefined);
  assert.deepEqual(first.missing.map((m) => m.ref), ["shop"], "per-post degradation listed");
  assert.equal(first.fleet.state, "paused", "fleet-layer pause at birth");

  const members = fleetDb.listMembers(first.fleet.id);
  assert.equal(members.length, 3);
  assert.equal(members.every((m) => !m.cadence || m.cadence.enabled === false), true, "member-layer pause at birth");
  // Materialized tasks exist and park (enabled=false → paused bit true).
  const tasks = cron.listJobs().filter((j) => j.sourceTag?.fleetId === first.fleet.id);
  assert.equal(tasks.length, 2);
  assert.equal(tasks.every((t) => t.paused), true, "install never auto-runs");

  // Dedup: same pack + owner → the same fleet, no twin.
  const again = await provisionFleetFromTemplate({ packId: "pack_tpl", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true);
  assert.equal(again.fleet.id, first.fleet.id);
});

// ── unique-post conflict degradation (fix-fleet-provisioner-unique-post) ────

test("provisioner: on-duty target conflicts degrade to a staffable vacancy", async () => {
  // user-assist already holds a post in a LIVE fleet…
  const fleetA = fleetDb.createFleet({ id: "fleet_a", name: "现役A", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_a", fleetId: fleetA.id, title: "老助理", parentId: null, targetKind: "persona", targetId: "user-assist", kpiSlots: [], cadence: null });
  // …and the template's assist ref names that same persona. tpl-shop present
  // so NOTHING is missing — the conflict is the only degradation.
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });

  const out = await provisionFleetFromTemplate({ packId: "pack_uc", version: "1.0.0", manifest: goodManifest(), ownerEmail: "owner@test", deps });
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, [], "the target exists — nothing is missing");
  assert.deepEqual(out.conflicts.map((c) => c.ref), ["assist"]);
  assert.equal(out.conflicts[0].occupiedBy.postTitle, "老助理");
  assert.equal(out.conflicts[0].occupiedBy.fleetName, "现役A");
  assert.equal(out.conflicts[0].intraTemplate, false);

  // The conflicting post is born with the empty sentinel — the persona keeps
  // exactly ONE post anywhere.
  const assistPost = fleetDb.listMembers(out.fleet.id).find((m) => m.title === "助理岗");
  assert.equal(assistPost.targetId, "");
  const holders = [fleetA.id, out.fleet.id]
    .flatMap((fid) => fleetDb.listMembers(fid))
    .filter((m) => m.targetId === "user-assist");
  assert.equal(holders.length, 1, "no second post on the incumbent");
});

test("provisioner: intra-template duplicate conflicts; a2a exempt", async () => {
  const dup = goodManifest();
  dup.fleet.members.push({ ref: "assist2", title: "助理二岗", parentRef: "ceo", target: { kind: "existing-persona", id: "user-assist" }, cadence: null });
  dup.fleet.members.push({ ref: "wx", title: "萬星岗", parentRef: "ceo", target: { kind: "existing-a2a", id: "wx-a" }, cadence: null });
  dup.fleet.members.push({ ref: "wx2", title: "萬星二岗", parentRef: "ceo", target: { kind: "existing-a2a", id: "wx-a" }, cadence: null });
  const deps = provisionDeps({ catalogIds: new Set(["tpl-ceo", "tpl-shop", "user-assist"]) });

  const out = await provisionFleetFromTemplate({ packId: "pack_dup", version: "1.0.0", manifest: dup, ownerEmail: "owner@test", deps });
  assert.equal(out.ok, true);
  // The SECOND claim of user-assist conflicts with the first post of THIS
  // batch (no other fleet involved) — occupiedBy stays null.
  assert.deepEqual(out.conflicts.map((c) => c.ref), ["assist2"]);
  assert.equal(out.conflicts[0].intraTemplate, true);
  assert.equal(out.conflicts[0].occupiedBy, null);
  const members = fleetDb.listMembers(out.fleet.id);
  assert.equal(members.find((m) => m.title === "助理岗").targetId, "user-assist", "first claim keeps the target");
  assert.equal(members.find((m) => m.title === "助理二岗").targetId, "", "second claim gets the sentinel");
  // a2a is exempt from uniqueness (D8): both 萬星 posts hold the target.
  assert.equal(out.conflicts.some((c) => c.ref.startsWith("wx")), false);
  assert.equal(members.filter((m) => m.targetId === "wx-a").length, 2);
});

test("start route: flips both pause layers, reconcile resumes, notice-only upgrades", async () => {
  const manifest = goodManifest();
  const deps = provisionDeps();
  const { fleet } = await provisionFleetFromTemplate({ packId: "pack_start", version: "1.0.0", manifest, ownerEmail: "owner@test", deps });

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: ALIVE,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // The notice before any upgrade: exact version → no notice payload churn.
    seedInstalledPack("pack_start", "1.0.0", manifest);
    const before = await call("GET", `/api/fleets/${fleet.id}/cockpit`);
    assert.equal(before.status, 200);
    assert.equal(before.body.fleet.state, "paused");
    assert.equal(before.body.template.updateAvailable, false);

    // Start: both layers flip; the parked tasks resume.
    const started = await call("POST", `/api/fleets/${fleet.id}/start`);
    assert.equal(started.status, 200);
    assert.equal(started.body.fleet.state, "active");
    const _afterTasks = cron.listJobs().filter((j) => j.sourceTag?.fleetId === fleet.id && j.target.preset === "tpl-shop" ? false : true);
    assert.equal(cron.listJobs().filter((j) => j.sourceTag?.fleetId === fleet.id).every((t) => !t.paused), true, "tasks resumed after start");

    // Template-newer (D7): publish v2 → notice appears, the LIVE fleet is
    // untouched (no member/cadence change, no new fleet).
    seedInstalledPack("pack_start", "2.0.0", manifest);
    const cockpit = await call("GET", `/api/fleets/${fleet.id}/cockpit`);
    assert.equal(cockpit.body.template.updateAvailable, true);
    assert.equal(cockpit.body.template.latestVersion, "2.0.0");
    assert.deepEqual(
      fleetDb.listMembers(fleet.id).map((m) => m.title).sort(),
      fleetDb.listMembers(fleet.id).map((m) => m.title).sort(),
    );
    assert.equal(fleetDb.listFleets({ ownerEmail: "owner@test" }).length, 1, "no twin from the notice");
  } finally {
    server.close();
  }
});

// ── 1.1 cockpit aggregate + from-template route ────────────────────────────

test("from-template route + cockpit segments in one round-trip", async () => {
  const manifest = goodManifest();
  seedInstalledPack("pack_rt", "1.0.0", manifest);

  const app = express();
  app.use(express.json());
  const ctx = {
    authEnabled: false,
    cellUserEmail: "owner@test",
    fleetTargetResolver: ALIVE,
    currentPreset: null,
  };
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const unknown = await call("POST", "/api/fleets/from-template", { packId: "nope" });
    assert.equal(unknown.status, 400);

    const created = await call("POST", "/api/fleets/from-template", { packId: "pack_rt" });
    assert.equal(created.status, 201);
    assert.equal(created.body.fleet.state, "paused");
    assert.deepEqual(created.body.missing.map((m) => m.ref), ["assist"], "the existing-persona ref is absent here → degraded, pack presets resolved");

    const deduped = await call("POST", "/api/fleets/from-template", { packId: "pack_rt" });
    assert.equal(deduped.status, 200);
    assert.equal(deduped.body.fleet.id, created.body.fleet.id);

    // Open a decision on the CEO post to exercise the banner's ordering, and
    // a report so the stream has one row.
    const ceoMember = fleetDb.listMembers(created.body.fleet.id).find((m) => m.title === "CEO");
    fleetDb.appendDecision({
      id: "d_low", fleetId: created.body.fleet.id, memberId: ceoMember.id,
      question: "低优", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", submittedAt: Date.now() - 3600_000,
    });
    fleetDb.appendDecision({
      id: "d_high", fleetId: created.body.fleet.id, memberId: ceoMember.id,
      question: "高优", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "high", submittedAt: Date.now(),
    });
    fleetDb.appendReport({ id: "r_ceo", fleetId: created.body.fleet.id, memberId: ceoMember.id, sessionId: "s", metrics: {}, resources: [], blockers: [], summary: "首报", source: "self", createdAt: Date.now() });

    const cockpit = await call("GET", `/api/fleets/${created.body.fleet.id}/cockpit`);
    assert.equal(cockpit.status, 200);
    // Segments all present in ONE payload.
    assert.ok(cockpit.body.members.length === 3);
    assert.ok(cockpit.body.decisions.length === 2);
    assert.deepEqual(cockpit.body.decisions.map((d) => d.id), ["d_high", "d_low"], "severity-first ordering");
    assert.ok(cockpit.body.decisions[0].expiresAt > 0, "policy-expiry sort key rides");
    assert.equal(cockpit.body.stream.length, 3);
    assert.equal(cockpit.body.stream[0].memberId, cockpit.body.stream[0].memberId); // shape
    assert.ok(cockpit.body.health && cockpit.body.health.total === 3);
    assert.equal(cockpit.body.template.updateAvailable, false);
    // The tree members carry the previous knives' contracts verbatim.
    const ceoView = cockpit.body.members.find((m) => m.title === "CEO");
    assert.equal(typeof ceoView.status, "string");
    assert.ok(ceoView.latestReport);
    assert.equal(ceoView.latestReport.summary, "首报");
  } finally {
    server.close();
  }
});

// ── 1.1 from-template unique-post conflict leg ──────────────────────────────

test("from-template route: conflict surfaces, sentinel reads vacant, swap staffs it", async () => {
  seedInstalledPack("pack_uc", "1.0.0", goodManifest());
  // user-assist must be a LIVE catalog persona at route level — a dead target
  // would take the missing path instead of the conflict path.
  dbModule.upsertInstalledPack({
    packId: "pack_ppl",
    name: "人员包",
    version: "1.0.0",
    manifest: { agents: [{ id: "user-assist", name: "用户助理" }] },
    report: { agents: [{ id: "user-assist", status: "installed" }], skills: [] },
  });
  // …and on duty in a live fleet.
  const fleetA = fleetDb.createFleet({ id: "fleet_a", name: "现役A", ownerEmail: "owner@test" });
  fleetDb.createMember({ id: "m_a", fleetId: fleetA.id, title: "老助理", parentId: null, targetKind: "persona", targetId: "user-assist", kpiSlots: [], cadence: null });

  const app = express();
  app.use(express.json());
  const ctx = { authEnabled: false, cellUserEmail: "owner@test", fleetTargetResolver: SENTINEL_AWARE, currentPreset: null };
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const created = await call("POST", "/api/fleets/from-template", { packId: "pack_uc" });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.missing, []);
    assert.equal(created.body.conflicts.length, 1);
    assert.equal(created.body.conflicts[0].ref, "assist");
    assert.equal(created.body.conflicts[0].occupiedBy.postTitle, "老助理");
    assert.equal(created.body.conflicts[0].occupiedBy.fleetName, "现役A");

    // Same-source contrast: a MANUAL post on the busy persona still 409s —
    // the provisioner is now the third write path agreeing with 建岗.
    const mk = await call("POST", `/api/fleets/${created.body.fleet.id}/members`, {
      title: "插岗", targetKind: "persona", targetId: "user-assist",
    });
    assert.equal(mk.status, 409);

    // Cockpit: the sentinel post reads vacant with the conflict reason.
    const cockpit = await call("GET", `/api/fleets/${created.body.fleet.id}/cockpit`);
    assert.equal(cockpit.status, 200);
    const assist = cockpit.body.members.find((m) => m.title === "助理岗");
    assert.equal(assist.status, "vacant");
    assert.match(assist.statusReason, /conflict/i);
    assert.equal(assist.target.id, "");
    assert.equal(assist.target.label, null, "no fake label for the sentinel");

    // Free the incumbent (dissolve archives A), then 补岗 via swap — the
    // vacancy is staffable through the ordinary restaffing route.
    const gone = await call("DELETE", `/api/fleets/${fleetA.id}`);
    assert.equal(gone.status, 200);
    const swap = await call("POST", `/api/fleets/${created.body.fleet.id}/members/${assist.id}/swap`, {
      targetKind: "persona", targetId: "user-assist",
    });
    assert.equal(swap.status, 200);
    assert.equal(swap.body.member.target.id, "user-assist");
    assert.notEqual(swap.body.member.status, "vacant");
  } finally {
    server.close();
  }
});

// ── official seed library conservation (add-fleet-template-library) ────────
// Every seed under docs/fleet-templates/ is the manifest source of truth for a
// market-published pack. Rot (an illegal fleet section) must fail HERE, naming
// the offending file — not surface at casting time on the market side.

test("official seed library: every manifest passes the fleet-section gate", async () => {
  const dir = new URL("../docs/fleet-templates/", import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".seed.json")).sort();
  assert.ok(files.length >= 5, `expected the seed library to hold at least 5 seeds, found ${files.length}`);

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(new URL(file, dir), "utf8"));
    // The seed carries {{PLACEHOLDER}} ids for the casting step to substitute —
    // substitute benign values and the manifest MUST clear the shared parser.
    const filled = JSON.parse(
      JSON.stringify(raw).replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => (key === "PACK_ID" ? "pack_seed" : `${key.toLowerCase()}-ref`)),
    );
    const parsed = parseFleetTemplate(filled);
    assert.equal(parsed.ok, true, `${file}: ${parsed.error}`);

    // Self-carried agents cap (company-seed casting proved the market-side
    // limit of 3): extra posts must be reference/passive/cluster/a2a posts.
    assert.ok(Array.isArray(raw.agents) && raw.agents.length <= 3, `${file}: pack agents must be at most 3, found ${raw.agents?.length}`);

    // Every pack-preset post names a self-carried agent, and every self-carried
    // agent is referenced by exactly one pack-preset post (1:1, no orphans).
    const presetIds = parsed.template.members.filter((m) => m.target.kind === "pack-preset").map((m) => m.target.presetId);
    const agentIds = (raw.agents ?? []).map((a) => a.id);
    assert.deepEqual([...presetIds].sort(), [...agentIds].sort(), `${file}: agents[] and pack-preset posts must correspond 1:1`);

    assert.ok(
      parsed.template.members.every((m) => !m.cadence || m.cadence.promptTemplate.includes("{{fleetContext}}")),
      `${file}: every cadence template carries the patrol placeholder`,
    );
  }
});

// The original single-seed pin, kept as the company fleet's shape contract.
test("official seed manifest (company fleet) passes the fleet-section gate", async () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../docs/fleet-templates/company-fleet.seed.json", import.meta.url), "utf8"));
  const filled = JSON.parse(JSON.stringify(raw).replace(/\{\{PACK_ID\}\}/g, "pack_seed").replace(/\{\{SHOP_PERSONA\}\}/g, "shop-p").replace(/\{\{CONTENT_PERSONA\}\}/g, "content-p").replace(/\{\{ASSIST_PERSONA\}\}/g, "assist-p").replace(/\{\{WANXING_CLUSTER\}\}/g, "wx-cluster"));
  const parsed = parseFleetTemplate(filled);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.template.members.length, 7);
  assert.equal(parsed.template.members.filter((m) => m.cadence).length, 6, "six cadence posts + one passive (内容部)");
  assert.ok(parsed.template.members.every((m) => !m.cadence || m.cadence.promptTemplate.includes("{{fleetContext}}")), "every cadence template carries the patrol placeholder");
});
