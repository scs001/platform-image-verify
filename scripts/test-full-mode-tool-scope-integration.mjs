#!/usr/bin/env node
// ── Full-mode tool scope integration (full-mode-tool-scope 1.3/1.4/4.2) ─────
//
// Real composition: temp DB + DSH home, installed-pack snapshots, the shared
// writeMcpPatch pipeline, and the materialized tool-filter.json. Covers the
// flag's byte-equality promise, the union, the safety valve, the override,
// uninstall re-derivation, and a custom preset's declared/fallback face.
//
//   node --test scripts/test-full-mode-tool-scope-integration.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "full-mode-scope-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));
// catalog.js binds its file at import and must never read the repo's own
// agents.json — an empty fixture cwd is the established test trick.
const cwdFixture = path.join(tmpRoot, "cwd");
mkdirSync(cwdFixture, { recursive: true });
writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
process.chdir(cwdFixture);

const db = await import("../db.js");
await db.initDb();
const { writeMcpPatch, writeCatalogAgentPresets } = await import("../dsh-profile.js");
const catalog = await import("../catalog.js");

const FILTER_PATH = path.join(process.env.DSH_HOME, "profiles", "platform", "tool-filter.json");
const readFilter = () => readFileSync(FILTER_PATH, "utf8");
const filterDoc = () => JSON.parse(readFilter());

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const installPack = (packId, refs) =>
  db.upsertInstalledPack({
    packId,
    name: packId,
    version: 1,
    manifest: { name: packId, mcpServers: refs },
    report: {},
  });

test("flag off: composition is byte-identical to the pre-change writer", async () => {
  delete process.env.FULL_MODE_TOOL_SCOPE;
  installPack("pack-off", [{ registryName: "srv-a", allowTools: ["read"] }]);
  await writeMcpPatch();
  assert.equal(readFilter(), '{\n  "mcpTools": {}\n}\n');
  db.deleteInstalledPack("pack-off");
});

test("flag on: two packs referencing one server contribute the union", async () => {
  process.env.FULL_MODE_TOOL_SCOPE = "on";
  installPack("pack-a", [{ registryName: "srv-a", allowTools: ["read", "search"] }]);
  installPack("pack-b", [{ registryName: "srv-a", allowTools: ["search", "write"] }]);
  await writeMcpPatch();
  assert.deepEqual(filterDoc().mcpTools["srv-a"].sort(), ["read", "search", "write"]);
});

test("flag on: an undeclared reference keeps the whole surface (never an empty set)", async () => {
  installPack("pack-legacy", [{ registryName: "srv-a" }]);
  await writeMcpPatch();
  assert.equal(filterDoc().mcpTools["srv-a"], undefined);
});

test("flag on: the per-server override lifts a narrowed server", async () => {
  db.deleteInstalledPack("pack-legacy");
  db.setFullSurfaceServers(["srv-a"]);
  await writeMcpPatch();
  assert.equal(filterDoc().mcpTools["srv-a"], undefined);
  db.setFullSurfaceServers([]);
});

test("flag on: uninstalling the last referencing packs drops the key", async () => {
  db.deleteInstalledPack("pack-a");
  db.deleteInstalledPack("pack-b");
  await writeMcpPatch();
  assert.equal(filterDoc().mcpTools["srv-a"], undefined);
});

test("flag on: a custom preset declares a face or inherits the union", async () => {
  installPack("pack-c", [{ registryName: "srv-b", allowTools: ["read", "search"] }]);
  const declared = db.createUserPreset({
    name: "声明预设",
    persona: "p",
    mcpServers: ["srv-b"],
    mcpTools: { "srv-b": ["read"] },
  });
  // Data layer round-trip first: a missing face here would be a persistence
  // bug, not a catalog-lookup one.
  assert.deepEqual(db.getUserPreset(declared.id).mcpTools, { "srv-b": ["read"] });
  // Same sequence the create route rides: refresh the catalog AND regenerate
  // the roster's generated presets (hasCatalogAgentPreset gates on the defs
  // file, not just the catalog row).
  await catalog.refresh();
  writeCatalogAgentPresets(catalog.getChatAgentEntries());
  await writeMcpPatch({ agentPreset: declared.id });
  assert.deepEqual(filterDoc().mcpTools["srv-b"], ["read"]);

  const inherited = db.createUserPreset({ name: "继承预设", persona: "p", mcpServers: ["srv-b"] });
  await catalog.refresh();
  writeCatalogAgentPresets(catalog.getChatAgentEntries());
  await writeMcpPatch({ agentPreset: inherited.id });
  assert.deepEqual(filterDoc().mcpTools["srv-b"].sort(), ["read", "search"]);
});
