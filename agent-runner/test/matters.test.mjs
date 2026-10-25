// ── Runner matters executor tests (add-matter-threads 2) ─────────────────────
//
// The facade receptions' escalation egress: route/credential shape, the
// per-agent OPEN bucket, the len-only audit law, and the decline shapes a
// turn can act on. The child-side trio (matter-tools.js) is transport-pure —
// its wire contract mirrors bot-notify's and is exercised via the same
// park/settle discipline tested in the notify suite.
//
//   node --test agent-runner/test/matters.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createMatters } from "../matters.js";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "matters-exec-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness({ openPerMin = 2, base = "https://packs.example.test", token = "svc-tok" } = {}) {
  const calls = [];
  const logFile = path.join(tmpRoot, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const m = String(url).match(/\/open$/);
    if (m && init.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ id: `mt_${calls.length}`, status: "open" }) };
    }
    if (String(url).match(/\/matters\/[^/]+\/[^/]+$/)) {
      return { ok: true, status: 200, json: async () => ({ matters: [{ id: "mt_1", summary: "s", status: "open", visitorHint: "", updatedAt: 1 }] }) };
    }
    if (String(url).match(/\/mt_/)) {
      return { ok: true, status: 200, json: async () => ({ matter: { id: "mt_1", summary: "s", status: "open", timeline: [] } }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "nf" }) };
  };
  const matters = createMatters({
    config: {
      packsBaseUrl: base, registryToken: token,
      mattersLogFile: logFile, mattersOpenPerMin: openPerMin,
    },
    log: { warn: () => {} },
    fetchImpl,
    now: (() => {
      let t = 1_000_000;
      return () => t;
    })(),
  });
  return { matters, calls, logFile };
}

test("open rides the service credential to the facet internal route; audit is len-only", async () => {
  const h = harness();
  const out = await h.matters.handle({ packId: "pk_1", agentId: "reception", agent: "packs-pk_1-reception", op: "open", args: { summary: "请问怎么收费？", visitor_hint: "张三" } });
  assert.equal(out.ok, true);
  assert.match(out.id, /^mt_/);
  const c = h.calls.at(-1);
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.Authorization, "Bearer svc-tok");
  assert.equal(c.url, "https://packs.example.test/api/packs/internal/matters/pk_1/reception/open");
  assert.equal(JSON.parse(c.init.body).summary, "请问怎么收费？");
  assert.equal(JSON.parse(c.init.body).visitor_hint, "张三");

  // The audit line names the op and the length — never the matter text.
  const line = JSON.parse(readFileSync(h.logFile, "utf8").trim());
  assert.equal(line.op, "open");
  assert.equal(line.outcome, "opened");
  assert.equal(line.len, "请问怎么收费？".length);
  assert.ok(!JSON.stringify(line).includes("请问"));
});

test("the per-agent OPEN bucket declines the excess; reads stay unthrottled", async () => {
  const h = harness({ openPerMin: 2 });
  const ident = { packId: "pk", agentId: "reception", agent: "a" };
  assert.equal((await h.matters.handle({ ...ident, op: "open", args: { summary: "一" } })).ok, true);
  assert.equal((await h.matters.handle({ ...ident, op: "open", args: { summary: "二" } })).ok, true);
  const third = await h.matters.handle({ ...ident, op: "open", args: { summary: "三" } });
  assert.equal(third.ok, false);
  assert.equal(third.reason, "rate-limit");
  // Reads are not spend — they keep answering while opens are exhausted.
  assert.equal((await h.matters.handle({ ...ident, op: "status" })).ok, true);
  assert.equal((await h.matters.handle({ ...ident, op: "read", args: { id: "mt_1" } })).ok, true);
  // The bucket is per agent — a different deployment is unaffected.
  assert.equal((await h.matters.handle({ packId: "pk", agentId: "reception", agent: "b", op: "open", args: { summary: "另一部署" } })).ok, true);
});

test("declines: not-configured plane, empty summary, bad read id, unknown op", async () => {
  const bare = createMatters({ config: { packsBaseUrl: "", registryToken: "", mattersLogFile: path.join(tmpRoot, "x.jsonl") }, log: {} });
  const nc = await bare.handle({ packId: "p", agentId: "r", agent: "a", op: "open", args: { summary: "s" } });
  assert.equal(nc.reason, "not-configured");

  const h = harness();
  assert.equal((await h.matters.handle({ packId: "p", agentId: "r", agent: "a", op: "open", args: { summary: "" } })).reason, "invalid-request");
  assert.equal((await h.matters.handle({ packId: "p", agentId: "r", agent: "a", op: "read", args: { id: "../etc" } })).reason, "invalid-request");
  assert.equal((await h.matters.handle({ packId: "p", agentId: "r", agent: "a", op: "explode" })).reason, "unknown-op");
  assert.equal((await h.matters.handle({ agent: "a", op: "status" })).reason, "identity");
});
