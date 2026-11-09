#!/usr/bin/env node
// ── Personal-data export (privacy: portability half) ────────────────────────
//
// The audit's privacy finding was "no export/erase/minimisation implementation
// point". Erase is a product decision (what a delete MAY destroy is not the
// implementation's to choose); export destroys nothing, so it lands first and
// these tests pin the properties that make it trustworthy:
//   • it answers for the authenticated identity only, never for a named one
//   • credential-shaped values are masked, not copied
//   • deployment-global state is excluded (it is not an individual's data)
//   • session ownership rides as facts, never as message bodies
//   • an unused lane (absent table) degrades to [] instead of failing
//
//   node --test scripts/test-personal-export.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "personal-export-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const { listPersonalRows } = db;
const express = (await import("express")).default;
const { registerUserBindingRoutes } = await import("../server/routes/user-bindings.js");

await db.initDb();

const ALICE = { email: "alice@corp.com" };
const BOB = { email: "bob@corp.com" };

function appFor(who, { ready = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = who;
    next();
  });
  registerUserBindingRoutes({
    app,
    db: { ...db, isDbReady: () => ready },
    getUserBindings: () => ({ model: null, mcp: [] }),
    pushUserBindingsTo: () => {},
    applyUserBindings: async () => ({ ok: true }),
    dshModels: [],
    extensionStore: { listMcpServers: () => [], getMcpServer: () => null },
    defaultModel: null,
  });
  return app;
}

async function get(app, url) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + url);
  const body = await res.json().catch(() => null);
  await new Promise((r) => server.close(r));
  return { status: res.status, body };
}

test("the export is scoped to the caller and carries only their rows", async () => {
  db.setUserModelBinding(ALICE.email, "provider-x", "model-y");
  db.setUserModelBinding(BOB.email, "provider-b", "model-b");

  const out = await get(appFor(ALICE), "/api/users/me/export");
  assert.equal(out.status, 200);
  assert.equal(out.body.identity.email, ALICE.email);
  const rows = out.body.data.user_model_bindings;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, ALICE.email);
  assert.equal(rows[0].model_id, "model-y");
});

test("credential-shaped values are masked, never copied", async () => {
  // The registry credential row stores a token; the export must record that
  // something is held without becoming a second copy of the secret.
  db.setUserRegistryCredential?.(ALICE.email, "tok_live_abcdef", "paste");
  const out = await get(appFor(ALICE), "/api/users/me/export");
  const rows = out.body.data.user_registry_credentials;
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (/token|secret|key|password|credential/i.test(k) && typeof v === "string" && v) {
        assert.equal(v, "<held>", `${k} must be masked in the export`);
      }
    }
  }
  assert.ok(!JSON.stringify(out.body).includes("tok_live_abcdef"), "the secret itself must not appear");
});

test("deployment-global state is excluded — it is not an individual's data", async () => {
  db.setPreference("agent.preset", "standard");
  const out = await get(appFor(ALICE), "/api/users/me/export");
  assert.deepEqual(
    Object.keys(out.body.data).filter((t) => ["user_preferences", "user_presets", "chart_bindings"].includes(t)),
    [],
    "global tables must not be presented as personal data",
  );
  assert.ok(out.body.scope.excludes.includes("user_preferences"));
  assert.equal(out.body.scope.secrets, "masked");
});

test("session ownership rides as facts, never as message bodies", async () => {
  const id = "export-sess-1";
  db.upsertSession(id, "Owned session", new Date().toISOString(), new Date().toISOString());
  db.stampSessionOwner(id, ALICE.email);
  db.appendMessage(id, "user", "SECRET BODY TEXT", new Date().toISOString(), "[]");

  const out = await get(appFor(ALICE), "/api/users/me/export");
  const mine = out.body.sessions.find((s) => s.id === id);
  assert.ok(mine, "the owned session must be listed");
  assert.equal(mine.title, "Owned session");
  assert.equal(mine.messageCount, 1);
  assert.ok(!JSON.stringify(out.body).includes("SECRET BODY TEXT"), "message bodies must not be exported");
});

test("an unused lane degrades to [] instead of failing the export", async () => {
  const out = await get(appFor(ALICE), "/api/users/me/export");
  assert.equal(out.status, 200);
  for (const rows of Object.values(out.body.data)) assert.ok(Array.isArray(rows));
});

test("no identity is a hard 401, and a closed database is a 503", async () => {
  const anon = await get(appFor(null), "/api/users/me/export");
  assert.equal(anon.status, 401);
  const down = await get(appFor(ALICE, { ready: false }), "/api/users/me/export");
  assert.equal(down.status, 503);
});

test("the reader refuses a table outside the personal allowlist", () => {
  // Two different behaviours, asserted separately: an allow-listed table that
  // this deployment never populated degrades to [] (the loop's contract), while
  // a table that is NOT personal data must be refused outright — including the
  // deployment-global ones (user_preferences/user_presets/chart_bindings), which
  // are the tempting mistakes for a future caller.
  for (const global of ["user_preferences", "user_presets", "chart_bindings", "chat_sessions"]) {
    assert.throws(() => listPersonalRows(global, ALICE.email), /not a personal table/, global);
  }
  // Allow-listed but absent in this deployment → empty, not an error.
  assert.deepEqual(listPersonalRows("user_ciyuan_account", "nobody@example.com"), []);
});
