// Runner fleet bridge (openspec: add-fleet-bridge-endpoint-for-agent-runner 3.1–3.3).
//
// Three things have to hold, and each one fails in a different, quiet way:
//
//   1. the runner door authenticates the RUNNER with its own bearer, and refuses
//      in a distinguishable posture (503 unconfigured / 401 wrong) — a door that
//      answered 401 for "nobody configured me" is how an inert deployment reads
//      like a wrong token;
//   2. the runner mount is NARROWER than the cell mount: only the bridge verbs
//      reachable there (a runner token must not be able to create a fleet or
//      pause a member), and the architect face is read-only (no draft/apply);
//   3. a report that arrives through the prefixed mount still attributes by
//      `turn_token` — the prefix must not lose the body path, because identity
//      is the ONE thing this lane cannot afford to lose.
//
// Run: node --test scripts/test-runner-fleet-bridge.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runner-fleet-bridge-"));
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
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const { registerFleetArchitectRoutes } = await import("../server/fleet-architect.js");
const { registerAuth, runnerFleetGate, FLEET_BRIDGE_PATHS } = await import("../server/auth.js");
const { fleetBridgeMcpRows, FLEET_BRIDGE_SERVERS } = await import("../agent-runner/fleet-bridge-rows.js");
const { startRunnerFleetBridge, fleetBridgeStatusPath } = await import("../agent-runner/fleet-bridge.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

test.after(() => {
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const TOKEN = "test-runner-token-7f3a";

function freshFleetDb() {
  const db = createFleetDatabase({
    file: path.join(tmpRoot, `fleets-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(db);
  return db;
}

// Attribution that the route will accept, without standing up a real turn: the
// prefixed mount is what this file judges, and the turn table itself is covered
// by the fleets suite.
const TURN = { turnId: "turn_test", fleetId: "fleet_test", memberId: "member_test" };

async function startServer({ authMode = "logto" } = {}) {
  const db = freshFleetDb();
  const fleet = db.createFleet({ id: "fleet_test", name: "测试舰队", ownerEmail: "owner@test" });
  db.createMember({
    id: "member_test",
    fleetId: fleet.id,
    title: "值班岗",
    targetKind: "persona",
    targetId: "reception",
    cadence: { enabled: true, everyMinutes: 60 },
  });

  // registerAuth derives ctx.cellUserEmail from CLOUD_MODE + CELL_USER_EMAIL
  // (auth.js:517), so a harness that leaves CLOUD_MODE unset gets "no cell
  // owner" and every architect assertion would 500 — a fixture artifact that
  // would also hide a real regression. Mirror the hosted shape.
  process.env.CLOUD_MODE = "1";
  process.env.CELL_USER_EMAIL = "owner@test";

  const app = express();
  app.use(express.json());
  const ctx = {
    app,
    authMode,
    authEnabled: true,
    // auth.js:517 keys off ctx.CLOUD_MODE, not the env var — a harness that sets
    // only the env still gets "no cell owner" on every architect route.
    CLOUD_MODE: true,
    cellUserEmail: "owner@test",
    db,
    fleetTargetResolver: () => ({ alive: false, label: "" }),
    // The route reads the ledger, not ctx: mirror the production shape rather
    // than adding a test-only branch to the route.
    fleetTurnLedger: { openTurns: () => [], lookupByToken: (t) => (t === "tk_ok" ? TURN : null) },
    currentPreset: null,
    openTurns: () => [],
    recordReportRejection: () => {},
    recordFleetAttribution: () => {},
  };
  // Same order as production: gate first, then the mounts.
  registerAuth(ctx);
  createFleetRoutes(app, ctx);
  createFleetRoutes(app, ctx, {
    mount: "/api/runner-fleet/fleets",
    guard: (req, res, next) => {
      if (!FLEET_BRIDGE_PATHS.has(`/api/fleets${req.path}`)) return res.status(404).json({ error: "not found" });
      return next();
    },
  });
  registerFleetArchitectRoutes(ctx);
  registerFleetArchitectRoutes(ctx, { mount: "/api/runner-fleet/architect", readOnly: true });

  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call, db };
}

const bearer = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

// ── 3.1 the door's three postures ────────────────────────────────────────────

test("door: unconfigured answers 503, wrong bearer 401, right bearer passes", async () => {
  const prev = process.env.FLEET_RUNNER_BRIDGE_TOKEN;

  process.env.FLEET_RUNNER_BRIDGE_TOKEN = "";
  {
    const { server, call } = await startServer();
    try {
      const r = await call("GET", "/api/runner-fleet/architect/fleets", undefined, bearer());
      assert.equal(r.status, 503, `unconfigured must be distinguishable from a wrong token: ${JSON.stringify(r.body)}`);
      assert.match(String(r.body.error), /not configured/i);
    } finally {
      server.close();
    }
  }

  process.env.FLEET_RUNNER_BRIDGE_TOKEN = TOKEN;
  {
    const { server, call } = await startServer();
    try {
      assert.equal((await call("GET", "/api/runner-fleet/architect/fleets")).status, 401, "no bearer");
      assert.equal(
        (await call("GET", "/api/runner-fleet/architect/fleets", undefined, bearer("nope"))).status,
        401,
        "wrong bearer",
      );
      assert.equal(
        (
          await call("GET", "/api/runner-fleet/architect/fleets", undefined, {
            ...bearer(),
            "x-forwarded-email": "someone@else",
          })
        ).status,
        401,
        "a bearer-authenticated runner never also carries a proxied user",
      );
      // Two arms on the cell's own mount, which is loopback-credentialed: this
      // harness IS loopback, so it answers — and it answers identically with a
      // WRONG bearer, proving the bearer plays no part there. The runner door
      // therefore widens nothing; it only adds a second, narrower entrance.
      const withRight = await call("GET", "/api/fleet-architect/fleets", undefined, bearer());
      const withWrong = await call("GET", "/api/fleet-architect/fleets", undefined, bearer("nope"));
      assert.equal(withRight.status, 200, JSON.stringify(withRight.body));
      assert.equal(withWrong.status, 200, "the cell mount never reads the runner bearer");
      const out = await call("GET", "/api/runner-fleet/architect/fleets", undefined, bearer());
      assert.equal(
        out.status,
        200,
        `right bearer reaches the read-only face: ${JSON.stringify(out.body)}`,
      );
    } finally {
      server.close();
    }
  }

  if (prev === undefined) delete process.env.FLEET_RUNNER_BRIDGE_TOKEN;
  else process.env.FLEET_RUNNER_BRIDGE_TOKEN = prev;
});

test("door: the bearer only opens the runner prefix, not the cell's own api", async () => {
  const prev = process.env.FLEET_RUNNER_BRIDGE_TOKEN;
  process.env.FLEET_RUNNER_BRIDGE_TOKEN = TOKEN;
  const { server, call } = await startServer();
  try {
    // Same bearer, a path outside the prefix — the gate must still 401. This is
    // the half that keeps the door from becoming a general-purpose bypass.
    assert.equal((await call("GET", "/api/fleets", undefined, bearer())).status, 401);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.FLEET_RUNNER_BRIDGE_TOKEN;
    else process.env.FLEET_RUNNER_BRIDGE_TOKEN = prev;
  }
});

test("door: runnerFleetGate is the single decision (unit, no HTTP)", () => {
  const req = (p, headers = {}) => ({ path: p, headers });
  assert.equal(runnerFleetGate(req("/api/fleets"), { FLEET_RUNNER_BRIDGE_TOKEN: TOKEN }), null);
  assert.equal(runnerFleetGate(req("/api/runner-fleet/fleets/report"), {}), "unconfigured");
  assert.equal(
    runnerFleetGate(req("/api/runner-fleet/fleets/report", { authorization: "Bearer x" }), {
      FLEET_RUNNER_BRIDGE_TOKEN: TOKEN,
    }),
    "denied",
  );
  assert.equal(
    runnerFleetGate(req("/api/runner-fleet/fleets/report", { authorization: `Bearer ${TOKEN}` }), {
      FLEET_RUNNER_BRIDGE_TOKEN: TOKEN,
    }),
    "allow",
  );
});

// ── 3.2 the runner mount is narrower than the cell mount ─────────────────────

test("narrowing: owner-facing fleet routes are NOT reachable through the runner mount", async () => {
  const prev = process.env.FLEET_RUNNER_BRIDGE_TOKEN;
  process.env.FLEET_RUNNER_BRIDGE_TOKEN = TOKEN;
  const { server, call } = await startServer();
  try {
    // Each of these exists on /api/fleets and must be refused here.
    for (const [method, p, body] of [
      ["POST", "/api/runner-fleet/fleets", { name: "偷偷建一个" }],
      ["POST", "/api/runner-fleet/fleets/fleet_test/batch", { action: "pause", ids: ["fleet_test"] }],
      ["PATCH", "/api/runner-fleet/fleets/fleet_test", { state: "archived" }],
    ]) {
      const r = await call(method, p, body, bearer());
      assert.equal(r.status, 404, `${method} ${p} must not be reachable by a runner token`);
    }
    // …while the bridged verb is reached (409 here: no attribution, which is the
    // honest refusal this lane produces without a turn token).
    const bridged = await call("POST", "/api/runner-fleet/fleets/report", { summary: "x" }, bearer());
    assert.notEqual(bridged.status, 404, "the report verb must reach its handler");
    assert.equal(bridged.status, 409, "no identity ⇒ honest refusal, never a guess");
  } finally {
    server.close();
    if (prev === undefined) delete process.env.FLEET_RUNNER_BRIDGE_TOKEN;
    else process.env.FLEET_RUNNER_BRIDGE_TOKEN = prev;
  }
});

test("narrowing: the architect face on the runner mount is read-only", async () => {
  const prev = process.env.FLEET_RUNNER_BRIDGE_TOKEN;
  process.env.FLEET_RUNNER_BRIDGE_TOKEN = TOKEN;
  const { server, call } = await startServer();
  try {
    assert.equal((await call("POST", "/api/runner-fleet/architect/draft", { draft: {} }, bearer())).status, 404);
    assert.equal((await call("POST", "/api/runner-fleet/architect/apply", { draft: {} }, bearer())).status, 404);
    // The cell's own mount still has them (unchanged behaviour).
    assert.notEqual((await call("POST", "/api/fleet-architect/draft", { draft: {} })).status, 404);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.FLEET_RUNNER_BRIDGE_TOKEN;
    else process.env.FLEET_RUNNER_BRIDGE_TOKEN = prev;
  }
});

// ── 3.3 attribution survives the prefix ─────────────────────────────────────

test("attribution: a report through the runner prefix still resolves by turn_token", async () => {
  const prev = process.env.FLEET_RUNNER_BRIDGE_TOKEN;
  process.env.FLEET_RUNNER_BRIDGE_TOKEN = TOKEN;
  const { server, call, db } = await startServer();
  try {
    const refused = await call("POST", "/api/runner-fleet/fleets/report", { summary: "无令牌" }, bearer());
    assert.equal(refused.status, 409, "no turn token ⇒ server refuses rather than guessing");

    const ok = await call(
      "POST",
      "/api/runner-fleet/fleets/report",
      { summary: "本轮做完了", turnToken: "tk_ok" },
      bearer(),
    );
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const rows = db.listReports("member_test", { limit: 5 });
    assert.equal(rows.length, 1, "the report landed on the member the token named");
    assert.equal(rows[0].summary, "本轮做完了");
  } finally {
    server.close();
    if (prev === undefined) delete process.env.FLEET_RUNNER_BRIDGE_TOKEN;
    else process.env.FLEET_RUNNER_BRIDGE_TOKEN = prev;
  }
});

// ── the rows the runner composes ────────────────────────────────────────────

test("rows: both servers, a per-request mount, and no identity coordinates", () => {
  const rows = fleetBridgeMcpRows("http://127.0.0.1:12345", { token: "tok-abc" });
  assert.deepEqual(
    rows.map((r) => r.config.serverName),
    [...FLEET_BRIDGE_SERVERS],
  );
  for (const row of rows) {
    assert.equal(row.config.transport, "streamable-http");
    assert.match(row.config.url, /^http:\/\/127\.0\.0\.1:12345\/[a-z-]+\/mcp$/);
    // The mount + the runner's bearer ride per request in headers (the host
    // turns them into the reserved `__fleetBridge` argument). This is NOT an
    // identity: no fleet/member/persona may appear here, because one patch
    // serves every home in the pack.
    assert.equal(row.config.headers["x-fleet-bridge-base"], "http://127.0.0.1:12345");
    assert.equal(row.config.headers["x-fleet-bridge-token"], "tok-abc");
    for (const key of Object.keys(row.config.headers)) {
      assert.doesNotMatch(key, /fleet-id|member|persona/i, `identity-shaped header ${key}`);
    }
    // And nothing identity-shaped or secret lives in the child's env.
    assert.equal(row.config.env, undefined, "a shared satellite must not read its secret from env");
  }
  // No token configured (a caller that only has a mount) → no token header.
  const bare = fleetBridgeMcpRows("http://127.0.0.1:1", {});
  assert.equal(bare[0].config.headers["x-fleet-bridge-token"], undefined);
  assert.deepEqual(fleetBridgeMcpRows(null), [], "no host ⇒ no row (never a dead one)");
});

test("rows: the runner composes them at BOTH composition sites", () => {
  // Source-level because both call sites are deep inside #spawnPod; the shape
  // assertions above prove the builder, this proves the wiring. Without it a
  // future refactor can drop one site and every unit test above still passes.
  const src = fs.readFileSync(new URL("../agent-runner/manager.js", import.meta.url), "utf8");
  assert.equal(
    (src.match(/#withFleetBridge\(/g) ?? []).length,
    3,
    "one definition + two call sites (per-key compose and per-pod compose)",
  );
});

// ── boot probe + status file (design 1.3) ───────────────────────────────────

test("boot: no config is inert and recorded as such", async () => {
  const home = fs.mkdtempSync(path.join(tmpRoot, "home-off-"));
  const out = await startRunnerFleetBridge({ url: "", token: "", homeRoot: home, log: { log() {}, warn() {} } });
  assert.equal(out.origin, null);
  assert.equal(out.status.state, "off");
  const recorded = JSON.parse(fs.readFileSync(fleetBridgeStatusPath(home), "utf8"));
  assert.equal(recorded.state, "off");
});

test("boot: a failing probe yields NO origin and a judgeable status", async () => {
  const home = fs.mkdtempSync(path.join(tmpRoot, "home-bad-"));
  const out = await startRunnerFleetBridge({
    url: "http://platform.invalid",
    token: "t",
    homeRoot: home,
    log: { log() {}, warn() {} },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "Authentication required" }) }),
  });
  assert.equal(out.origin, null, "a dead endpoint must never become an MCP row");
  assert.equal(out.status.state, "missing");
  assert.match(out.status.reason, /401/);
  assert.equal(JSON.parse(fs.readFileSync(fleetBridgeStatusPath(home), "utf8")).state, "missing");
});

// ── 接线层：header → 主机注入 → 子进程 → 平台 HTTP（三跳实测） ───────────────
//
// 规则层（rows 形状、门三态）绿不代表接线绿：`__fleetBridge` 可能没人读、
// header 可能没被主机读到、或者子进程仍走环回。这条用例真的起一个假平台
// HTTP 服务 + 真 `server/fleet-mcp.js` 子进程 + 真主机，断言请求**落到了哪里、
// 带了什么凭据**；同一轮还断言调用方伪造的保留键被剥掉。
test("wiring: a header-borne mount reaches the platform call, and reserved keys cannot be forged", async () => {
  const { createServer } = await import("node:http");
  const { createMcpSatelliteHost } = await import("../server/mcp-satellite-host.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  const seen = [];
  const platform = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: null });
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen[seen.length - 1].body = Buffer.concat(chunks).toString();
      res.writeHead(201, { "content-type": "application/json" });
      // The real route's 201 body (verified live 2026-11-14); the child renders
      // it, so a shape-incomplete stub would fail inside the tool instead of
      // exercising the transport.
      res.end(
        JSON.stringify({
          ok: true,
          memberTitle: "值班岗",
          fleetName: "测试舰队",
          reportId: "r_wiring",
          declaredSlots: [],
          slotsAccepted: [],
          slotsUnrecognized: [],
          windowResetsAt: 0,
        }),
      );
    });
  });
  await new Promise((r) => platform.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${platform.address().port}/api/runner-fleet`;

  const host = createMcpSatelliteHost({
    satellites: [
      {
        name: "fleet",
        command: process.execPath,
        // 真子进程，不是桩：只有它能证明 base 与 bearer 真的到了 HTTP 调用。
        args: [new URL("../server/fleet-mcp.js", import.meta.url).pathname],
        env: process.env,
      },
    ],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });

  const connect = async (headers) => {
    const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${host.port}/fleet/mcp`), {
        requestInit: { headers },
      }),
    );
    return client;
  };
  const forgedArgs = {
    summary: "接线实测",
    turn_token: "tk_wiring", // the schema's real name (server/fleet-mcp-hints.js)
    // 调用方自带的保留键：两个都必须被剥掉（模型既改不了通道，也改不了归属）。
    __fleetBridge: { base: "http://127.0.0.1:1/nope", token: "stolen" },
    __fleetIdentity: { fleetId: "x", memberId: "y" },
  };

  let runnerShaped = null;
  let cellShaped = null;
  try {
    await host.start();

    // ① runner 形态：只有 mount + bearer，没有任何身份 header —— rows 就是这个形状。
    runnerShaped = await connect({ "x-fleet-bridge-base": base, "x-fleet-bridge-token": "tok-wiring" });
    const out = await runnerShaped.callTool({ name: "report_status", arguments: { ...forgedArgs } });
    assert.ok(!out.isError, JSON.stringify(out).slice(0, 200));

    assert.equal(seen.length, 1, "exactly one platform call");
    assert.equal(seen[0].url, "/api/runner-fleet/fleets/report", "mounted path, not the cell's own");
    assert.equal(seen[0].auth, "Bearer tok-wiring", "the runner bearer rides the request");
    const sent = JSON.parse(seen[0].body);
    assert.equal(sent.turnToken, "tk_wiring", "the turn token rides the body untouched");
    assert.equal(sent.__fleetBridge, undefined, "a forged reserved key never reaches the handler");
    assert.equal(sent.__fleetIdentity, undefined);
    assert.equal(
      sent.selfIdentity,
      undefined,
      "no identity header ⇒ no self-report; the runner lane attributes by turn_token alone",
    );

    // ② cell 形态：身份 header 是**规范**通道（不是伪造）。它必须被主机注入，
    //    并且压过 arguments 里那个伪造的同名键 —— 这正是这条协议要防的形态。
    cellShaped = await connect({
      "x-fleet-bridge-base": base,
      "x-fleet-bridge-token": "tok-wiring",
      "x-fleet-fleet-id": "fleet_from_header",
      "x-fleet-member-id": "member_from_header",
      "x-fleet-persona": "persona_from_header",
    });
    const out2 = await cellShaped.callTool({ name: "report_status", arguments: { ...forgedArgs } });
    assert.ok(!out2.isError, JSON.stringify(out2).slice(0, 200));

    assert.equal(seen.length, 2);
    const sent2 = JSON.parse(seen[1].body);
    assert.deepEqual(
      sent2.selfIdentity,
      { fleetId: "fleet_from_header", memberId: "member_from_header", persona: "persona_from_header" },
      "身份只来自 header，arguments 里的伪造值被丢弃",
    );
    assert.equal(sent2.turnToken, "tk_wiring");
  } finally {
    await runnerShaped?.close().catch(() => {});
    await cellShaped?.close().catch(() => {});
    await host.stop().catch(() => {});
    await new Promise((r) => platform.close(r));
  }
});
