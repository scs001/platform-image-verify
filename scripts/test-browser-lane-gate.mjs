// Unit tests — the browser lane supply gate in dsh-profile.writeMcpPatch
// (add-browser-use-lane, design D2). The lane's patch entry must resolve one of
// three deployment shapes at patch-write time:
//
//   local   BROWSER_RUNTIME_PATH names an EXISTING directory → entry composed
//   remote  BROWSER_CDP_ENDPOINT set (no local runtime needed) → entry composed
//   absent  neither (or BROWSER_LANE=off, which vetoes both) → entry OMITTED,
//           info-logged as a silent normal state
//
// The gate rides the MERGED server map, so this test drives it through the
// operator layer (mcp.json) exactly like a deployment would.
//
// Run: node --test scripts/test-browser-lane-gate.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const LANE_ENTRY = {
  command: "node",
  args: ["server/browser-mcp.js"],
  laneGate: "browser",
};

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "browser-lane-gate-"));
  mkdirSync(join(home, "profiles", "platform"), { recursive: true });
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { playwright: LANE_ENTRY } }, null, 2),
  );
  return home;
}

// Each case imports dsh-profile.js fresh with its own env domain: the module
// resolves MCP_PATCH_PATH and MCP_CONFIG_PATH at import time.
async function patchEntries(home) {
  const mod = await import(`${pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href}?case=${Date.now()}-${Math.random()}`);
  await mod.writeMcpPatch({});
  const patchPath = join(home, "profiles", "platform", "mcp.patch.yml");
  // Zero composed servers → the writer emits no patch file at all; "no entry"
  // and "no file" are the same omission from the lane's point of view.
  let raw;
  try {
    raw = readFileSync(patchPath, "utf8");
  } catch {
    return [];
  }
  const rows = yaml.load(raw) ?? [];
  return rows.filter((row) => row?.insert).flatMap((row) => row.insert);
}

async function withEnv(home, env, fn) {
  const saved = {};
  for (const key of ["DSH_HOME", "MCP_CONFIG_PATH", "DB_PATH", "BROWSER_LANE", "BROWSER_RUNTIME_PATH", "BROWSER_CDP_ENDPOINT"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DSH_HOME = home;
  process.env.MCP_CONFIG_PATH = join(home, "mcp.json");
  process.env.DB_PATH = join(home, "app.db");
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("absent: no runtime and no endpoint omits the lane", async () => {
  const home = makeHome();
  const rows = await withEnv(home, {}, () => patchEntries(home));
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "lane must be omitted without a browser supply");
});

test("local: an existing runtime path composes the lane", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { BROWSER_RUNTIME_PATH: home }, () => patchEntries(home));
  const row = rows.find((r) => r.id === "mcp-playwright");
  assert.ok(row, "lane must compose when BROWSER_RUNTIME_PATH exists");
  assert.equal(row.name, "@deepseek-ai/dsh-mcp-client");
  assert.equal(row.config?.serverName, "playwright");
});

test("local: a stale runtime path (does not exist) still omits the lane", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { BROWSER_RUNTIME_PATH: join(home, "no-such-dir") }, () => patchEntries(home));
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "a path that does not exist is not a supply");
});

test("remote: a CDP endpoint composes the lane without a local runtime", async () => {
  const home = makeHome();
  const rows = await withEnv(home, { BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222" }, () => patchEntries(home));
  assert.ok(rows.find((r) => r.id === "mcp-playwright"), "lane must compose for a remote endpoint");
});

test("off: BROWSER_LANE=off vetoes both supply forms", async () => {
  const home = makeHome();
  const rows = await withEnv(
    home,
    { BROWSER_LANE: "off", BROWSER_RUNTIME_PATH: home, BROWSER_CDP_ENDPOINT: "http://127.0.0.1:9222" },
    () => patchEntries(home),
  );
  assert.equal(rows.some((r) => r.id === "mcp-playwright"), false, "explicit off must win over supply");
});