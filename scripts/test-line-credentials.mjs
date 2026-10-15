// Unit tests — line-credentials (add-line-credential-refs).
// Run: node --test scripts/test-line-credentials.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "line-cred-")), "data.db");
process.env.DB_PATH = DB_PATH;

const db = await import("../db.js");
await db.initDb();
const lc = await import("../line-credentials.js");

const EMAIL = "lines@test.example";

const idToken = (expOffsetSec) => {
  const h = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({
    sub: "u1", email: EMAIL, exp: Math.floor(Date.now() / 1000) + expOffsetSec,
  })).toString("base64url");
  return `${h}.${p}.sig`;
};

test("unknown line is rejected at store", () => {
  assert.equal(lc.store({ email: EMAIL, line: "nope", token: "x" }), null);
});

test("ID token line: store → live → expire → omit → 401 clears → browser re-mint recovers", () => {
  const status = lc.store({ email: EMAIL, line: "wire-customer", token: idToken(3600) });
  assert.equal(status.connected, true);
  assert.equal(typeof lc.liveToken(EMAIL, "wire-customer"), "string");

  // expired token ⇒ liveToken null (server omitted), but row remains
  db.setLineCredential({ email: EMAIL, line: "wire-customer",
    token: idToken(-60), tokenExp: Date.now() - 60_000, stale: 0 });
  assert.equal(lc.liveToken(EMAIL, "wire-customer"), null);
  assert.equal(lc.status(EMAIL, "wire-customer").connected, false);

  // 401 clears the cache; browser re-mint restores
  assert.equal(lc.markInvalid(EMAIL, "wire-customer"), true);
  const again = lc.store({ email: EMAIL, line: "wire-customer", token: idToken(3600) });
  assert.equal(again.connected, true);
  assert.equal(typeof lc.liveToken(EMAIL, "wire-customer"), "string");
});

test("ID token line: stale is never set (re-mint, not re-paste)", () => {
  lc.store({ email: EMAIL, line: "lex", token: idToken(3600) });
  assert.equal(lc.markInvalid(EMAIL, "lex"), true); // cleared
  const s = lc.status(EMAIL, "lex");
  assert.equal(s.stale, false); // stale semantics NOT used for ID-token lines
  assert.equal(lc.markInvalid(EMAIL, "lex"), false); // nothing to clear
});

test("wanxing-caller: sk- paste, 401 flips stale once, re-paste recovers", () => {
  assert.equal(lc.store({ email: EMAIL, line: "wanxing-caller", token: "sk-abc123" }).connected, true);
  assert.equal(typeof lc.liveToken(EMAIL, "wanxing-caller"), "string");
  assert.equal(lc.markInvalid(EMAIL, "wanxing-caller"), true);
  assert.equal(lc.markInvalid(EMAIL, "wanxing-caller"), false);
  assert.equal(lc.liveToken(EMAIL, "wanxing-caller"), null);
  assert.equal(lc.status(EMAIL, "wanxing-caller").stale, true);
  assert.equal(lc.store({ email: EMAIL, line: "wanxing-caller", token: "sk-fresh" }).connected, true);
  assert.equal(lc.status(EMAIL, "wanxing-caller").stale, false);
});

test("projections never carry the token", () => {
  lc.store({ email: EMAIL, line: "wanxing-caller", token: "sk-secret-value" });
  const s = JSON.stringify(lc.status(EMAIL, "wanxing-caller"));
  assert.ok(!s.includes("sk-secret-value"));
});

test("credential-refs knows all three refs and forwards per line", async () => {
  const refs = await import("../credential-refs.js");
  for (const ref of ["wire-customer", "lex", "wanxing-caller"]) {
    assert.equal(refs.knownRef(ref), true);
    const entry = refs.refFor({ credentialRef: ref });
    assert.equal(entry.refName, ref);
  }
  // wire ref resolves the wire-customer line's token
  const entry = refs.refFor({ credentialRef: "wire-customer" });
  assert.equal(typeof entry.liveToken(EMAIL), "string");
});
