#!/usr/bin/env node
// ── Platform billing tests (add-agent-platform-ops, tasks 2.1–2.3, 5.1) ──────
//
// Module-level tests against injected sub2api stubs and the real deploy
// integration paths: client shapes (envelope unwrap, degraded mode, user-flow
// key minting), deployment-key bookkeeping + balance gate, and the internal
// key-distribution route's auth.
//
//   node --test scripts/test-platform-billing.mjs

import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "platform-billing-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const { createSub2apiClient } = await import("../lib/sub2api-admin.js");

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── client against a stub sub2api (envelope + admin-key + user-flow) ────────

function stubSub2api() {
  const users = new Map(); // email → {id, email, balance}
  const keys = [];
  const seen = [];
  let nextId = 100;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    seen.push({ method: req.method, path: req.path, key: req.headers["x-api-key"] ?? null });
    if (req.path.startsWith("/api/v1/admin") && req.headers["x-api-key"] !== "admin-k") {
      return res.status(401).json({ code: 401, message: "Authorization required" });
    }
    next();
  });
  const ok = (res, data) => res.json({ code: 0, message: "success", data });
  app.post("/api/v1/auth/login", (req, res) => {
    const u = users.get(req.body?.email);
    if (!u) return res.status(401).json({ code: 401, message: "bad credentials" });
    ok(res, { access_token: `jwt-${u.id}`, user: u });
  });
  app.get("/api/v1/admin/users", (req, res) => {
    const items = [...users.values()].filter((u) => !req.query.search || u.email.includes(req.query.search));
    ok(res, { items, total: items.length });
  });
  app.post("/api/v1/admin/users", (req, res) => {
    const id = ++nextId;
    const u = { id, email: req.body.email, username: req.body.username, balance: 0, status: "active" };
    users.set(u.email, u);
    ok(res, u);
  });
  app.get("/api/v1/admin/users/:id", (req, res) => {
    const u = [...users.values()].find((x) => String(x.id) === req.params.id);
    if (!u) return res.status(404).json({ code: 404, message: "not found" });
    ok(res, u);
  });
  app.post("/api/v1/admin/users/:id/balance", (req, res) => {
    const u = [...users.values()].find((x) => String(x.id) === req.params.id);
    if (!u) return res.status(404).json({ code: 404, message: "not found" });
    if (!req.headers["idempotency-key"]) return res.status(400).json({ code: 400, message: "idempotency key required" });
    u.balance += Number(req.body.balance || 0);
    ok(res, { balance: u.balance });
  });
  app.post("/api/v1/keys", (req, res) => {
    if (!String(req.headers.authorization).startsWith("Bearer jwt-")) {
      return res.status(401).json({ code: 401, message: "user auth required" });
    }
    const k = { id: ++nextId, key: `sk-agent-${nextId}`, ...req.body };
    keys.push(k);
    ok(res, k);
  });
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, users, keys, seen, port: server.address().port })
    );
  });
}

test("client: ensure/mint/read/adjust over the stub; degraded without key", async () => {
  const stub = await stubSub2api();
  try {
    const c = createSub2apiClient({
      baseUrl: `http://127.0.0.1:${stub.port}`,
      adminKey: "admin-k",
      fetchImpl: (p, i) => fetch(`http://127.0.0.1:${stub.port}${p}`, i),
    });
    assert.deepEqual(await c.selfCheck(), { ok: true });

    const first = await c.ensureDeployerUser("alice@x.test");
    assert.equal(first.existed, false);
    assert.match(first.username, /^paas-alice-x-test$/);
    assert.ok(first.password);
    const again = await c.ensureDeployerUser("alice@x.test");
    assert.equal(again.existed, true);
    assert.equal(again.userId, first.userId);
    assert.equal(again.password, null, "existing accounts return no password");

    const minted = await c.mintAgentKey({
      email: "alice@x.test", password: first.password, name: "pack-agent-x",
      quotaUsd: 5, rl5hUsd: 1, rl1dUsd: 3, rl7dUsd: 10,
    });
    assert.ok(minted.key.startsWith("sk-agent-"));
    assert.equal(stub.keys[0].quota, 5);
    assert.equal(stub.keys[0].rate_limit_7d, 10);

    await c.adjustBalance({ userId: first.userId, amountUsd: 2, idempotencyKey: "idem-1" });
    const u = await c.readUser(first.userId);
    assert.equal(u.balance, 2);

    // Degraded mode: no key → selfCheck explains, admin calls not attempted.
    const d = createSub2apiClient({ baseUrl: `http://127.0.0.1:${stub.port}`, adminKey: "" });
    assert.equal(d.degraded(), true);
    assert.match((await d.selfCheck()).reason, /SUB2API_ADMIN_KEY/);
  } finally {
    stub.server.close();
  }
});

// ── deploy integration (tasks 2.2/2.3): gate, mint, reference, distribution ──

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { listServingAgents } from "../lib/agent-serving.js";

function stubRegistryWire() {
  const skills = new Map();
  const agents = new Map();
  const calls = { skills: [], agents: [] };
  return {
    calls,
    async fetch(rawUrl, init = {}) {
      const url = String(rawUrl).split("?")[0];
      const body = init.body ? JSON.parse(init.body) : null;
      let m = url.match(/^\/api\/skills\/(.+)$/);
      if (m && init.method === "PUT") {
        calls.skills.push({ path: m[1], body });
        skills.set(body.name, { ...body, path: `/skills/${body.name}` });
        return { ok: true, status: 200, json: async () => ({ path: `/skills/${body.name}`, ...body }) };
      }
      if (url.startsWith("/api/skills/") && !init.method) {
        const name = url.split("/").pop();
        if (skills.has(name)) return { ok: true, status: 200, json: async () => ({ path: "/skills/" + name }) };
        return { ok: false, status: 404, json: async () => ({ detail: "nf" }) };
      }
      if (url === "/api/skills" && init.method === "POST") {
        calls.skills.push({ path: body.path, body });
        skills.set(body.name, { ...body, path: `/skills/${body.name}` });
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      m = url.match(/^\/api\/agents\/(.+)\/toggle$/);
      if (m && init.method === "POST") return { ok: true, status: 200, json: async () => ({ path: m[1] }) };
      m = url.match(/^\/api\/agents\/(.+)$/);
      if (m && !init.method) {
        if (agents.has(m[1])) return { ok: true, status: 200, json: async () => agents.get(m[1]) };
        return { ok: false, status: 404, json: async () => ({ detail: "nf" }) };
      }
      if (m && (init.method === "PUT" || init.method === "POST")) {
        calls.agents.push({ path: m[1], body });
        agents.set(m[1], body);
        return { ok: true, status: 200, json: async () => ({ path: m[1], ...body }) };
      }
      return { ok: false, status: 404, json: async () => ({ detail: "route" }) };
    },
  };
}

const MANIFEST = {
  name: "计费包",
  description: "billing e2e",
  skills: [{ name: "bill-skill", description: "d", content: "# c" }],
  mcpServers: [],
  agents: [{ id: "bill-agent", name: "B", persona: "p", serving: { protocol: "a2a" } }],
};

async function harness({ user, sub2api, getUser }) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest: MANIFEST });
  const app = express();
  const wire = stubRegistryWire();
  registerPackRoutes(app, {
    registry,
    resolveUser: getUser ?? (() => user),
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig: {
      registryUrl: "https://mcp.example.test", token: "runner-svc-token",
      runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test",
      fetchImpl: wire.fetch,
      sub2api: sub2api ? { baseUrl: sub2api.baseUrl, adminKey: "admin-k", fetchImpl: sub2api.fetchImpl } : null,
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    registry, packId: id, wire,
    close: () => new Promise((r) => server.close(r)),
    call: (method, p, { headers = {}, body } = {}) =>
      fetch(base + p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
        .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })),
  };
}

test("deploy: no sub2api config degrades to keyless (pre-③ behavior)", async () => {
  const h = await harness({ user: { email: "author@x", groups: [] } });
  try {
    const res = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    assert.equal(res.status, 200);
    assert.equal(res.body.billing.linked, false);
    assert.equal(res.body.deployed[0].billingKeyRef, undefined);
    assert.equal(h.wire.calls.agents[0].body.metadata.billing_key_ref, undefined);
  } finally {
    await h.close();
  }
});

test("deploy: balance gate 402; linked deploy mints, references, and distributes", async () => {
  // One harness (one registry), one stub sub2api; the deployer starts broke,
  // gets recharged, and redeploys — the account's stored password persists in
  // the SAME registry, exactly like the real flow.
  const stub = await stubSub2api();
  let user = { email: "broke@x", groups: ["creators"] };
  const h = await harness({ user, sub2api: { baseUrl: `http://127.0.0.1:${stub.port}`, fetchImpl: (p, i) => fetch(`http://127.0.0.1:${stub.port}${p}`, i) }, getUser: () => user });
  try {
    const refused = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    assert.equal(refused.status, 402, JSON.stringify(refused.body));
    assert.ok(refused.body.error.includes("balance"));

    const funded = await (await import("../lib/sub2api-admin.js")).createSub2apiClient({
      baseUrl: `http://127.0.0.1:${stub.port}`, adminKey: "admin-k",
      fetchImpl: (p, i) => fetch(`http://127.0.0.1:${stub.port}${p}`, i),
    });
    await funded.adjustBalance({ userId: stub.users.get("broke@x").id, amountUsd: 10, idempotencyKey: "fund-1" });

    const res = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.billing.linked, true);
    const ref = res.body.deployed[0].billingKeyRef;
    assert.ok(ref != null, "key reference returned");
    const meta = JSON.stringify(h.wire.calls.agents[0].body.metadata);
    assert.ok(meta.includes("billing_key_ref"));
    assert.ok(!meta.includes("sk-agent-"), "no key value on the registry");

    const noauth = await h.call("GET", `/api/packs/internal/llm-key/${ref}`);
    assert.equal(noauth.status, 401);
    const ok = await h.call("GET", `/api/packs/internal/llm-key/${ref}`, { headers: { Authorization: "Bearer runner-svc-token" } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.keyValue.startsWith("sk-agent-"));
    assert.equal(ok.body.agentId, "bill-agent");
  } finally {
    await h.close();
    stub.server.close();
  }
});

// ── private-pack visibility (task 3.1): viewer × visibility matrix ──────────

test("private pack: owner sees and deploys; strangers 404 everywhere; admin sees", async () => {
  const file = path.join(tmpRoot, `packs-vis-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const PRIVATE = { ...MANIFEST, name: "私有包", visibility: "private" };
  const PUBLIC = { ...MANIFEST, name: "公开包" };
  const { id: privId } = registry.publish({ email: "owner@x", manifest: PRIVATE });
  const { id: pubId } = registry.publish({ email: "owner@x", manifest: PUBLIC });
  assert.equal(registry.packRowPublic(privId).visibility, "private");
  assert.equal(registry.packRowPublic(pubId).visibility, "public");

  const wire = stubRegistryWire();
  let user = { email: "owner@x", groups: [] };
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => user,
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig: {
      registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790",
      packsPublicBase: "https://packs.example.test", fetchImpl: wire.fetch,
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  try {
    // Owner: private listed (badged via visibility field), detail ok, deploys.
    let list = await call("GET", "/api/packs");
    assert.ok(list.body.packs.some((x) => x.id === privId && x.visibility === "private"), "owner sees own private pack");
    assert.ok(list.body.packs.some((x) => x.id === pubId));
    let detail = await call("GET", `/api/packs/${privId}`);
    assert.equal(detail.status, 200);
    let dep = await call("POST", `/api/packs/${privId}/versions/1/deploy`);
    assert.equal(dep.status, 200, JSON.stringify(dep.body));

    // Stranger: private pack indistinguishable from nonexistent — list,
    // detail, version, subscribe, deploy ALL 404/absent; public still fine.
    user = { email: "stranger@x", groups: ["creators"] };
    list = await call("GET", "/api/packs");
    assert.ok(!list.body.packs.some((x) => x.id === privId), "stranger list hides private");
    assert.ok(list.body.packs.some((x) => x.id === pubId));
    for (const p of [`/api/packs/${privId}`, `/api/packs/${privId}/versions/1`]) {
      assert.equal((await call("GET", p)).status, 404, p);
    }
    assert.equal((await call("POST", `/api/packs/${privId}/subscribe`)).status, 404);
    assert.equal((await call("POST", `/api/packs/${privId}/versions/1/deploy`)).status, 404);
    assert.equal((await call("POST", `/api/packs/${pubId}/subscribe`)).status, 200, "public still subscribable");

    // Admin: sees the private pack and can deploy it.
    user = { email: "ops@x", groups: ["admin", "creators"] };
    detail = await call("GET", `/api/packs/${privId}`);
    assert.equal(detail.status, 200);
    dep = await call("POST", `/api/packs/${privId}/versions/1/deploy`);
    assert.equal(dep.status, 200, "admin may deploy a private pack");
    // The registry entry for a private deploy carries private visibility.
    const payload = wire.calls.agents.at(-1).body;
    assert.equal(payload.visibility, "private");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("billing board: token-or-admin auth; degraded shape without sub2api", async () => {
  const h = await harness({ user: { email: "author@x", groups: [] } });
  try {
    const anon = await h.call("GET", "/api/packs/billing/board");
    assert.equal(anon.status, 401);
    const authed = await h.call("GET", "/api/packs/billing/board", { headers: { Authorization: "Bearer runner-svc-token" } });
    assert.equal(authed.status, 200);
    assert.equal(authed.body.degraded, true, "no sub2api config ⇒ degraded board");
    assert.ok(Array.isArray(authed.body.keys));
  } finally {
    await h.close();
  }
});
