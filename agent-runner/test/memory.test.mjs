import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCapture } from "../memory-capture.js";
import { MEMORY_DISCIPLINE, personaWithMemoryDiscipline } from "../memory-discipline.js";
import { materializeAcpWorkspace } from "../compose-acp.js";
import { acpMcpServers } from "../compose-acp.js";

function fakeOk() {
  const seen = [];
  return {
    seen,
    impl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200 };
    },
  };
}

test("MemoryCapture flushes a batch with runner namespace and bearer token", async () => {
  const f = fakeOk();
  const cap = new MemoryCapture({ url: "http://127.0.0.1:49999/", token: "fdm_t", fetchImpl: f.impl, log: { warn() {} } });
  cap.observe({ namespace: "d/p1/a1", sessionId: "s1", summary: "message turn ok (10ms)" });
  await cap.drain();
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].url, "http://127.0.0.1:49999/capture");
  assert.equal(f.seen[0].init.headers.authorization, "Bearer fdm_t");
  const body = JSON.parse(f.seen[0].init.body);
  assert.equal(body.namespace, "d/p1/a1");
  assert.equal(body.events[0].event, "stop");
  assert.equal(body.events[0].session_id, "s1");
});

test("MemoryCapture fails open: endpoint 500 drops a counted gap, never throws", async () => {
  let calls = 0;
  const cap = new MemoryCapture({
    url: "http://127.0.0.1:1",
    token: "fdm_t",
    fetchImpl: async () => { calls++; throw new Error("ECONNREFUSED"); },
    log: { warn() {} },
    now: () => 0,
  });
  cap.observe({ namespace: "d/p/a", sessionId: "s1", summary: "x" });
  await cap.drain();
  await cap.drain();
  assert.ok(calls >= 1);
  assert.equal(cap.droppedBatches >= 1, true);
});

test("MemoryCapture disabled without url/token: observe is a no-op", async () => {
  const cap = new MemoryCapture({ url: "", token: "", fetchImpl: async () => { throw new Error("must not call"); } });
  cap.observe({ namespace: "d/p/a", sessionId: "s1" });
  await cap.drain();
  assert.equal(cap.enabled, false);
});

test("discipline text: single source, appended only when provided", () => {
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_begin"));
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_accept"));
  assert.equal(personaWithMemoryDiscipline("P", null), "P");
  assert.ok(personaWithMemoryDiscipline("P", MEMORY_DISCIPLINE).startsWith("P"));
  assert.ok(personaWithMemoryDiscipline("P", MEMORY_DISCIPLINE).includes("Working-memory discipline"));
});

test("ACP workspace CLAUDE.md carries the memory discipline when provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-acp-"));
  try {
    const entry = { name: "agent1", metadata: { packId: "p1", agentId: "agent1", persona: "You are a test agent.", harness: "acp-claude-code" } };
    const spec = materializeAcpWorkspace({ homeRoot: dir, agentKey: "packs-p1-agent1", entry, skillContents: {}, harnessName: "acp-claude-code", memoryDiscipline: MEMORY_DISCIPLINE });
    const claude = readFileSync(join(spec.workspace, "CLAUDE.md"), "utf8");
    assert.ok(claude.startsWith("You are a test agent."));
    assert.ok(claude.includes("Working-memory discipline"));
    assert.ok(claude.includes("memory_handoff_begin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP workspace without memoryDiscipline stays byte-identical to pre-change output", () => {
  const dir = mkdtempSync(join(tmpdir(), "fdm-acp2-"));
  try {
    const entry = { name: "agent1", metadata: { packId: "p1", agentId: "agent1", persona: "You are a test agent.", harness: "acp-claude-code" } };
    const spec = materializeAcpWorkspace({ homeRoot: dir, agentKey: "k1", entry, skillContents: {}, harnessName: "acp-claude-code" });
    const claude = readFileSync(join(spec.workspace, "CLAUDE.md"), "utf8");
    assert.ok(!claude.includes("Working-memory discipline"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acpMcpServers rows keep the SDK header-array shape (memory row appended by manager matches it)", () => {
  const rows = acpMcpServers(["srv1"], { mcpUrlFor: () => "https://mcp.example/mcp" }, "tok");
  assert.deepEqual(rows[0].headers, [{ name: "Authorization", value: "Bearer tok" }]);
  assert.equal(rows[0].type, "http");
});

import { dshMemoryMount, acpMemoryMount } from "../memory-mount.js";

test("mount rows: dsh loader row and ACP SDK row shapes", () => {
  const dsh = dshMemoryMount("http://127.0.0.1:49375/mcp", "fdm_dep");
  assert.equal(dsh.id, "mcp-fd-memory");
  assert.equal(dsh.name, "@deepseek-ai/dsh-mcp-client");
  assert.equal(dsh.config.serverName, "fd-memory");
  assert.equal(dsh.config.transport, "streamable-http");
  assert.equal(dsh.config.headers.Authorization, "Bearer fdm_dep");

  const acp = acpMemoryMount("http://127.0.0.1:49375/mcp", "fdm_dep");
  assert.equal(acp.type, "http");
  assert.equal(acp.name, "fd-memory");
  assert.deepEqual(acp.headers, [{ name: "Authorization", value: "Bearer fdm_dep" }]);
  assert.deepEqual(acpMemoryMount("http://x/mcp", null).headers, []);
});
