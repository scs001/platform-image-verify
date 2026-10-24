// Unit tests — server/line-token-renewal (add-line-credential-renewal D2/D3/D5).
// Run: node --test scripts/test-line-token-renewal.mjs
//
// Covers: refresh success + rotation landing atomically, single-flight,
// rejected-grant → stale (never clear), transient failure keeps the row, the
// pre-round window predicate, the DB-scanned sweep, the cron pre-round hook,
// and the patch Authorization diff helpers dshUpdateMcp keys its
// restart-vs-HMR decision on.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "line-renew-")), "data.db");
process.env.DB_PATH = DB_PATH;

const db = await import("../db.js");
await db.initDb();
const lc = await import("../line-credentials.js");
const renewal = await import("../server/line-token-renewal.js");
const cronRunner = await import("../server/cron-runner.js");

const EMAIL = "renewal@test.example";
const TARGETS = { "wire-customer": { configUrl: "https://wire.test/auth/config" }, lex: { configUrl: "https://lex.test/auth/config" } };

const idToken = (expOffsetSec) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({
    sub: "u1", email: EMAIL, exp: Math.floor(Date.now() / 1000) + expOffsetSec,
  })).toString("base64url");
  return `${h}.${p}.sig`;
};

const jsonResponse = (doc, status = 200) =>
  new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });

const configResponse = () =>
  jsonResponse({ configured: true, issuer: "https://auth.test", client_id: "spa-test", scopes: ["openid"] });

// One mutable token-endpoint behavior per test; the config endpoint is static.
let tokenHandler = null;
const fetchImpl = async (url, options) => {
  if (String(url).includes("/auth/config")) return configResponse();
  if (String(url).includes("/oidc/token")) return tokenHandler(String(url), options);
  throw new Error(`unexpected fetch ${url}`);
};

const seeded = (line, refreshToken) => {
  lc.store({ email: EMAIL, line, token: idToken(600), ...(refreshToken !== undefined ? { refreshToken } : {}) });
};

test("renewLineCredential: success stores the new ID token + new rotator in one row, then re-applies (3.1)", async () => {
  lc.disconnect(EMAIL, "wire-customer");
  seeded("wire-customer", "rt-old");
  const order = [];
  tokenHandler = (_url, options) => {
    assert.ok(String(options.body).includes("grant_type=refresh_token"), "refresh grant");
    assert.ok(String(options.body).includes("refresh_token=rt-old"), "stored rotator sent");
    assert.ok(String(options.body).includes("client_id=spa-test"), "client_id from the live config, no secret");
    return jsonResponse({ id_token: idToken(3600), refresh_token: "rt-new" });
  };
  const out = await renewal.renewLineCredential({
    email: EMAIL, line: "wire-customer", targets: TARGETS, fetchImpl,
    onRenewed: async () => { order.push("re-applied"); },
  });
  assert.equal(out.renewed, true);
  const row = db.getLineCredentialWithRefresh(EMAIL, "wire-customer");
  assert.equal(row.refreshToken, "rt-new", "rotation: the NEW rotator lands");
  assert.equal(row.stale, 0);
  assert.equal(lc.liveToken(EMAIL, "wire-customer"), row.token, "live token is the renewed one");
  assert.deepEqual(order, ["re-applied"], "profile re-apply awaited inside the renewal");
});

test("renewLineCredential: single-flight — concurrent triggers cost one token request (3.1)", async () => {
  lc.disconnect(EMAIL, "lex");
  seeded("lex", "rt-sf");
  let calls = 0;
  tokenHandler = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 25));
    return jsonResponse({ id_token: idToken(3600), refresh_token: "rt-sf-2" });
  };
  const [a, b] = await Promise.all([
    renewal.renewLineCredential({ email: EMAIL, line: "lex", targets: TARGETS, fetchImpl }),
    renewal.renewLineCredential({ email: EMAIL, line: "lex", targets: TARGETS, fetchImpl }),
  ]);
  assert.equal(calls, 1, "exactly one refresh POST");
  assert.deepEqual([a.renewed, b.renewed], [true, true], "both callers share the result");
});

test("renewLineCredential: rejected grant flips stale, keeps the row, never throws (3.1)", async () => {
  lc.disconnect(EMAIL, "wire-customer");
  seeded("wire-customer", "rt-dead");
  tokenHandler = () => jsonResponse({ error: "invalid_grant" }, 400);
  const out = await renewal.renewLineCredential({ email: EMAIL, line: "wire-customer", targets: TARGETS, fetchImpl });
  assert.deepEqual(out, { renewed: false, stale: true });
  const row = db.getLineCredentialWithRefresh(EMAIL, "wire-customer");
  assert.ok(row, "row survives as the reconnect target");
  assert.equal(row.stale, 1);
  assert.equal(row.refreshToken, "rt-dead", "rotator kept for audit; reconnect overwrites it");
});

test("renewLineCredential: transient failure leaves the row untouched (3.1)", async () => {
  lc.disconnect(EMAIL, "lex");
  seeded("lex", "rt-keep");
  tokenHandler = () => jsonResponse({}, 500);
  const out = await renewal.renewLineCredential({ email: EMAIL, line: "lex", targets: TARGETS, fetchImpl });
  assert.equal(out.renewed, false);
  const row = db.getLineCredentialWithRefresh(EMAIL, "lex");
  assert.equal(row.stale, 0, "not staled — the next trigger retries");
  assert.equal(row.refreshToken, "rt-keep");
});

test("renewDueCredentials: the window predicate (trigger ①, 3.1)", async () => {
  const E = "due@test.example";
  lc.disconnect(E, "wire-customer");
  lc.disconnect(E, "lex");
  // Due (exp in 10min < 30min window).
  lc.store({ email: E, line: "wire-customer", token: idToken(600), refreshToken: "rt-due" });
  // Not due (exp in 55min).
  lc.store({ email: E, line: "lex", token: idToken(3300), refreshToken: "rt-far" });
  tokenHandler = () => jsonResponse({ id_token: idToken(3600), refresh_token: "rt-due-2" });
  const out = await renewal.renewDueCredentials({ email: E, targets: TARGETS, fetchImpl });
  assert.deepEqual(out.renewed, ["wire-customer"], "only the due line renewed");
  assert.equal(db.getLineCredentialWithRefresh(E, "lex").refreshToken, "rt-far", "far line untouched");
  // Rows without a refresh token and stale rows are skipped entirely.
  lc.store({ email: E, line: "wire-customer", token: idToken(600), refreshToken: "rt-st" });
  db.markLineCredentialStale(E, "wire-customer");
  const out2 = await renewal.renewDueCredentials({ email: E, targets: TARGETS, fetchImpl });
  assert.deepEqual(out2.renewed, [], "stale row waits for a human");
});

test("sweepRenewableCredentials: DB-selected expired row recovers through the refresh chain (trigger ②, 3.1)", async () => {
  const E = "sweep@test.example";
  lc.disconnect(E, "wire-customer");
  db.setLineCredential({
    email: E, line: "wire-customer",
    token: idToken(-600), tokenExp: Date.now() - 600_000, refreshToken: "rt-sweep",
  });
  tokenHandler = () => jsonResponse({ id_token: idToken(3600), refresh_token: "rt-sweep-2" });
  const out = await renewal.sweepRenewableCredentials({ targets: TARGETS, fetchImpl });
  assert.ok(out.renewed.includes(`${E}:wire-customer`), "the expired row was recovered");
  assert.equal(lc.status(E, "wire-customer").connected, true, "back to connected without any browser");
});

test("cron pre-round hook: runs before the executor; a renewal failure never fails the turn (3.2)", async () => {
  const order = [];
  const ctx = {
    renewLineCredentialsForTurn: async () => { order.push("renew"); },
  };
  cronRunner.attachCronRunner(ctx, {
    runTool: async () => { order.push("tool"); return { ok: true }; },
  });
  const out = await ctx.runCronJobTurn({ id: "j1", targetType: "tool", prompt: "x" });
  assert.deepEqual(order, ["renew", "tool"], "renewal precedes the turn");
  assert.equal(out.ok, true);
  // Degrade open: a throwing hook is contained, the turn still runs.
  const ctx2 = { renewLineCredentialsForTurn: async () => { throw new Error("config down"); } };
  cronRunner.attachCronRunner(ctx2, { runTool: async () => ({ ok: true, text: "ran" }) });
  const out2 = await ctx2.runCronJobTurn({ id: "j2", targetType: "tool", prompt: "x" });
  assert.equal(out2.ok, true, "turn survives a renewal failure");
});

test("patch Authorization helpers: snapshot + change detection (5.1)", async () => {
  const dshProfile = await import("../dsh-profile.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-auth-"));
  const patchPath = path.join(dir, "mcp.patch.yml");
  const write = (auth) =>
    fs.writeFileSync(
      patchPath,
      yaml.dump([{ insert: [
        { config: { serverName: "wire-customer", transport: "streamable-http", url: "https://wire.test/mcp", headers: { Authorization: auth } } },
        { config: { serverName: "plain-stdio", command: "node" } },
      ] }]),
    );
  write("Bearer t1");
  const prev = dshProfile.readPatchAuthorizations(patchPath);
  assert.deepEqual(prev, { "wire-customer": "Bearer t1" }, "only Authorization-carrying servers snapshot");
  write("Bearer t1");
  assert.equal(
    dshProfile.authorizationHeadersChanged(prev, dshProfile.readPatchAuthorizations(patchPath)),
    false, "same value → no credential change (HMR path keeps working)",
  );
  write("Bearer t2");
  assert.equal(
    dshProfile.authorizationHeadersChanged(prev, dshProfile.readPatchAuthorizations(patchPath)),
    true, "renewed value → restart delivery",
  );
  // A ref-carrying server appearing/disappearing also counts (omission flips).
  fs.writeFileSync(patchPath, yaml.dump([{ insert: [{ config: { serverName: "plain-stdio", command: "node" } }] }]));
  assert.equal(
    dshProfile.authorizationHeadersChanged(prev, dshProfile.readPatchAuthorizations(patchPath)),
    true, "credential server dropped → restart delivery",
  );
  assert.equal(dshProfile.readPatchAuthorizations(path.join(dir, "missing.patch.yml")), null, "absent patch → null");
  assert.equal(dshProfile.authorizationHeadersChanged(null, {}), false, "no previous snapshot → no diff");
});
