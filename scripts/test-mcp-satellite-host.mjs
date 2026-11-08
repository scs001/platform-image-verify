// ── Per-cell MCP satellite host (share-mcp-satellites-per-cell 2.1/2.2/2.3) ──
//
// The host owns ONE copy of the cell's shareable satellites and re-exposes each
// as its own streamable-http endpoint. What these tests pin:
//   - endpoints are per-satellite (server identity must not collapse),
//   - tools/list and tools/call really reach that satellite,
//   - a broken satellite fails open without taking the others down,
//   - stop() leaves no child process behind (the leak class that bit the
//     browser lane).
//
// Run: node --test scripts/test-mcp-satellite-host.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpSatelliteHost } from "../server/mcp-satellite-host.js";

// A minimal stdio MCP satellite: one tool named after SATELLITE_NAME.
function writeSatellite(dir, name) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `import { Server } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href}";
import { StdioServerTransport } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href}";
import { ListToolsRequestSchema, CallToolRequestSchema } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href}";
const NAME = ${JSON.stringify(name)};
const s = new Server({ name: NAME, version: "0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: NAME + "_tool", description: "from " + NAME, inputSchema: { type: "object" } }] }));
s.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: NAME + ":" + (r.params.arguments?.x ?? "") }] }));
await s.connect(new StdioServerTransport());
`,
  );
  return { name, command: process.execPath, args: [file], env: process.env };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "satellite-host-"));
}

async function connect(url) {
  const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

test("each satellite keeps its own endpoint and tool identity", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [writeSatellite(dir, "alpha"), writeSatellite(dir, "beta")],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    const a = await connect(`http://127.0.0.1:${host.port}/alpha/mcp`);
    const b = await connect(`http://127.0.0.1:${host.port}/beta/mcp`);
    const [ta, tb] = [await a.listTools(), await b.listTools()];
    assert.equal(ta.tools[0].name, "alpha_tool", "alpha endpoint must not serve beta's tools");
    assert.equal(tb.tools[0].name, "beta_tool");
    const ra = await a.callTool({ name: "alpha_tool", arguments: { x: "1" } });
    assert.equal(ra.content[0].text, "alpha:1", "tools/call must reach the right satellite");
    await a.close();
    await b.close();
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown or dead endpoint is a clean 404, not a hang", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [writeSatellite(dir, "only")],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    const res = await fetch(`http://127.0.0.1:${host.port}/nope/mcp`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a satellite that fails to start does not take the others down (fail-open)", async () => {
  const dir = tmp();
  const host = createMcpSatelliteHost({
    satellites: [
      writeSatellite(dir, "good"),
      { name: "broken", command: process.execPath, args: ["-e", "process.exit(1)"], env: process.env },
    ],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await host.start();
    assert.deepEqual(host.names.sort(), ["broken", "good"]);
    const ok = host.health().satellites.find((s) => s.name === "good");
    const bad = host.health().satellites.find((s) => s.name === "broken");
    assert.equal(ok.up, true, "the healthy satellite is up");
    assert.equal(bad.up, false, "the broken one is reported down, not silently missing");
    const c = await connect(`http://127.0.0.1:${host.port}/good/mcp`);
    assert.equal((await c.listTools()).tools[0].name, "good_tool");
    await c.close();
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop() leaves no satellite child behind", async () => {
  const dir = tmp();
  const marker = `satellite-host-proc-${Date.now()}`;
  const file = join(dir, "leaky.mjs");
  writeFileSync(
    file,
    `import { Server } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href}";
import { StdioServerTransport } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href}";
import { ListToolsRequestSchema } from "${new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href}";
const s = new Server({ name: "${marker}", version: "0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
await s.connect(new StdioServerTransport());
`,
  );
  const host = createMcpSatelliteHost({
    satellites: [{ name: "leaky", command: process.execPath, args: [file, marker], env: process.env }],
    port: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  const countProcs = () =>
    execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(file)).length;
  try {
    await host.start();
    assert.equal(countProcs(), 1, "the satellite is running");
  } finally {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(countProcs(), 0, "stop() must not orphan the child");
});
