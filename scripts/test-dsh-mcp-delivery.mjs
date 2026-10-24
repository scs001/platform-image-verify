// Unit tests — server/dsh-mcp-delivery (add-line-credential-renewal D5
// hardening after the fleet-cell incident 2026-10-24 13:46: a restart colliding
// with one already in flight lost the credential delivery silently).
// Run: node --test scripts/test-dsh-mcp-delivery.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { createCredentialDelivery } = await import("../server/dsh-mcp-delivery.js");

const silentLog = { log: () => {}, warn: () => {}, error: () => {} };

test("idle credential change restarts immediately (5.1 delivery branch)", async () => {
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming: () => false,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: silentLog,
  });
  const out = await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(out, "restarted");
  assert.deepEqual(restarts, ["/tmp/patch.yml"]);
  assert.equal(d.pending, false);
});

test("restart collision retries and delivers — the incident's silent loss is gone", async () => {
  let calls = 0;
  const restarts = [];
  const warns = [];
  const d = createCredentialDelivery({
    isStreaming: () => false,
    restart: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("dsh restart already in progress");
      restarts.push(calls);
    },
    log: { ...silentLog, warn: (m) => warns.push(m) },
    retryDelaysMs: [1, 1],
  });
  const out = await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(out, "restarted");
  assert.equal(restarts.length, 1, "third attempt delivered");
  assert.equal(warns.length, 2, "each collision logged");
});

test("restart failure exhausts retries with a loud error (never silent)", async () => {
  const errors = [];
  let calls = 0;
  const d = createCredentialDelivery({
    isStreaming: () => false,
    restart: async () => { calls += 1; throw new Error("down"); },
    log: { ...silentLog, error: (m) => errors.push(m) },
    retryDelaysMs: [1, 1],
  });
  await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(calls, 3, "initial + 2 retries");
  assert.equal(errors.length, 1, "exhaustion logged at error level");
});

test("streaming change defers; drainIfIdle delivers at the turn boundary", async () => {
  let streaming = true;
  const restarts = [];
  const logs = [];
  const d = createCredentialDelivery({
    isStreaming: () => streaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: { ...silentLog, log: (m) => logs.push(m) },
  });
  const out = await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(out, "deferred");
  assert.equal(d.pending, true);
  assert.deepEqual(restarts, [], "nothing delivered while streaming");
  streaming = false;
  const drained = await d.drainIfIdle();
  assert.equal(drained, true);
  assert.deepEqual(restarts, ["/tmp/patch.yml"]);
  assert.equal(d.pending, false);
  assert.ok(logs.some((m) => m.includes("deferred")), "the defer decision is logged");
});

test("drainIfIdle no-ops while still streaming (never interrupts a fresh turn)", async () => {
  const d = createCredentialDelivery({
    isStreaming: () => true,
    restart: async () => { throw new Error("must not be called"); },
    log: silentLog,
  });
  await d.onCredentialChange("/tmp/patch.yml");
  assert.equal(await d.drainIfIdle(), false, "streaming → no drain");
  assert.equal(d.pending, true, "still parked");
});

test("deferred past the cap, the poller forces delivery (wedged stream cannot hold the credential hostage)", async () => {
  const restarts = [];
  const warns = [];
  const d = createCredentialDelivery({
    isStreaming: () => true, // wedged forever
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: { ...silentLog, warn: (m) => warns.push(m) },
    maxDeferredMs: 30,
  });
  await d.onCredentialChange("/tmp/patch.yml");
  // The poller ticks every 250ms; the cap (30ms) expires on the first tick.
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(restarts, ["/tmp/patch.yml"], "forced delivery despite streaming");
  assert.ok(warns.some((m) => m.includes("cap")), "the force is logged as a warning");
  assert.equal(d.pending, false);
});

test("re-defer while pending keeps the original defer timestamp (cap measured from first defer)", async () => {
  let streaming = true;
  const restarts = [];
  const d = createCredentialDelivery({
    isStreaming: () => streaming,
    restart: async ({ mcpPatchPath }) => restarts.push(mcpPatchPath),
    log: silentLog,
    maxDeferredMs: 100,
  });
  await d.onCredentialChange("/tmp/a.yml");
  await new Promise((r) => setTimeout(r, 60));
  await d.onCredentialChange("/tmp/b.yml"); // second change, same pending window
  streaming = false;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(restarts.includes("/tmp/b.yml"), "the latest patch is delivered");
  assert.equal(d.pending, false);
});
