import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellMemoryConfig, cellMemoryMount, personTokenFor, memoryMcpEntry, MEMORY_DISCIPLINE } from "../cell-memory.js";

test("cellMemoryConfig: off or unconfigured → null (byte-identical baseline)", () => {
  assert.equal(cellMemoryConfig({}), null);
  assert.equal(cellMemoryConfig({ CELL_MEMORY_ENABLED: "1" }), null); // no url/token/data
  assert.equal(cellMemoryConfig({ CELL_MEMORY_ENABLED: "0", CELL_MEMORY_URL: "http://x", CELL_MEMORY_PLATFORM_TOKEN: "t", CELL_MEMORY_DATA: "/d" }), null);
  const cfg = cellMemoryConfig({ CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://x/", CELL_MEMORY_PLATFORM_TOKEN: "t", CELL_MEMORY_DATA: "/d" });
  assert.equal(cfg.url, "http://x");
});

test("personTokenFor: mints once, caches on disk, survives process (restart-stable)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cellmem-"));
  const cfg = { url: "http://mem", platformToken: "plat", dataRoot: dir };
  let mints = 0;
  const fake = async () => {
    mints += 1;
    return { ok: true, json: async () => ({ token: `fdm_person_${mints}` }) };
  };
  const t1 = await personTokenFor(cfg, "alice@finddata.cloud", fake);
  const t2 = await personTokenFor(cfg, "alice@finddata.cloud", fake); // cache hit, no re-mint
  assert.equal(t1, "fdm_person_1");
  assert.equal(t2, "fdm_person_1");
  assert.equal(mints, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("cellMemoryMount: full mount on configured env; fail-open on mint failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cellmem2-"));
  const env = { CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://mem", CELL_MEMORY_PLATFORM_TOKEN: "plat", CELL_MEMORY_DATA: dir };
  const ok = await cellMemoryMount(env, "bob@finddata.cloud", async () => ({ ok: true, json: async () => ({ token: "fdm_bob" }) }));
  assert.equal(ok.mcpEntry.config.serverName, "fd-memory");
  assert.equal(ok.mcpEntry.config.headers.Authorization, "Bearer fdm_bob");
  assert.ok(ok.discipline.includes("memory_handoff_begin"));
  // mint failure → null, never a throw
  const bad = await cellMemoryMount(env, "carol@finddata.cloud", async () => ({ ok: false, status: 500 }));
  assert.equal(bad, null);
  // no owner → null
  assert.equal(await cellMemoryMount(env, "", async () => { throw new Error("unreachable"); }), null);
  // cache miss + network throw also fail-open
  assert.equal(await cellMemoryMount(env, "dave@finddata.cloud", async () => { throw new Error("net down"); }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("memoryMcpEntry shape matches mcpEntry http branch", () => {
  const e = memoryMcpEntry("http://mem", "tk");
  assert.equal(e.id, "mcp-fd-memory");
  assert.equal(e.name, "@deepseek-ai/dsh-mcp-client");
  assert.equal(e.config.transport, "streamable-http");
  assert.equal(e.config.url, "http://mem/mcp");
});

test("discipline text: handoff begin/accept guidance present", () => {
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_begin"));
  assert.ok(MEMORY_DISCIPLINE.includes("memory_handoff_accept"));
});
