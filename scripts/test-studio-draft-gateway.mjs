#!/usr/bin/env node
// ── Studio AI drafting gateway behavior (add-studio-ai-drafting 1.1/1.2) ─────
//
// Behavioral pins against the booted gateway:
//   - auth: an anonymous caller gets the family-standard 401
//   - whitelist: an off-whitelist kind is rejected by name (400)
//   - honesty: with no LLM lane configured the bridge answers 503 — never a
//     fabricated draft
//   - shape: a missing prompt is a 400 before any lane work
//
//   node --test scripts/test-studio-draft-gateway.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { signSession } from "../server/session.js";
import { spawnTestServer } from "./lib/test-server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_SECRET = "studio-draft-gateway-test-secret";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = netServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function cookieFor(email, groups = []) {
  const payload = { email, groups, exp: Math.floor(Date.now() / 1000) + 3600 };
  return `paas_session=${signSession(payload, SESSION_SECRET)}`;
}

async function startStubOidc() {
  const port = await freePort();
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${port}`;
    res.setHeader("content-type", "application/json");
    if (req.url.includes("openid-configuration")) {
      return res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/oidc/auth`,
        token_endpoint: `${base}/oidc/token`,
        jwks_uri: `${base}/oidc/jwks`,
        end_session_endpoint: `${base}/oidc/session/end`,
      }));
    }
    if (req.url.includes("jwks")) return res.end(JSON.stringify({ keys: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

let gatewayServer;
let gwPort;
let dataRoot;
let oidc;

const USER = { email: "drafter@example.com", groups: [] };

function api(body, { email } = {}) {
  const headers = {};
  if (email) headers.cookie = cookieFor(email);
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`http://127.0.0.1:${gwPort}/api/studio/draft`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

test.before(async () => {
  oidc = await startStubOidc();
  dataRoot = await mkdtemp(path.join(tmpdir(), "studio-draft-"));
  gwPort = await freePort();
  gatewayServer = spawnTestServer({
    cwd: REPO,
    args: [path.join(REPO, "gateway/index.js")],
    storeRoot: dataRoot,
    env: {
      ...process.env,
      GATEWAY_PORT: String(gwPort),
      GATEWAY_HOST: "127.0.0.1",
      CELL_DATA_ROOT: dataRoot,
      CELL_GATEWAY_SECRET: "gateway-test-secret",
      CELL_IDLE_REAP_SECS: "0",
      SESSION_SECRET,
      LOGTO_ENDPOINT: `http://127.0.0.1:${oidc.port}`,
      LOGTO_APP_ID: "test-app",
      LOGTO_APP_SECRET: "test-secret",
      LOGTO_CLIENT_TYPE: "confidential",
      PAAS_BASE_URL: "",
      AUTH_MODE: "none",
      CLOUD_MODE: "",
      LLM_API_KEY: "",
      LLM_BASE_URL: "",
    },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway boot timeout")), 20_000);
    gatewayServer.child.stdout.on("data", (c) => {
      if (String(c).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    gatewayServer.child.on("exit", (code) => reject(new Error(`gateway exited early: ${code}`)));
  });
});

test.after(async () => {
  await gatewayServer?.stop();
  await oidc?.close();
  await rm(dataRoot, { recursive: true, force: true });
});

test("auth: anonymous caller gets the family-standard 401", async () => {
  const r = await api({ kind: "agent-doc", prompt: "一个巡检助手" });
  assert.equal(r.status, 401);
  assert.match(r.body?.error ?? "", /Authentication required/);
});

test("whitelist: an off-whitelist kind is rejected by name (400)", async () => {
  const r = await api({ kind: "arbitrary-tool", prompt: "x" }, { email: USER.email });
  assert.equal(r.status, 400);
  assert.match(r.body?.error ?? "", /agent-doc, blueprint/);
});

test("shape: a missing prompt is a 400 before any lane work", async () => {
  const r = await api({ kind: "agent-doc" }, { email: USER.email });
  assert.equal(r.status, 400);
  assert.match(r.body?.error ?? "", /prompt is required/);
});

test("honesty: no lane configured → 503, never a fabricated draft", async () => {
  const r = await api({ kind: "agent-doc", prompt: "一个巡检助手，每小时报数" }, { email: USER.email });
  assert.equal(r.status, 503);
  assert.match(r.body?.error ?? "", /no LLM lane/);
  assert.equal(r.body?.draft, undefined, "no draft is ever fabricated");
});
