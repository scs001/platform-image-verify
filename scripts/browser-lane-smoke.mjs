// scripts/browser-lane-smoke.mjs — image smoke for the browser lane
// (add-browser-use-lane, task 2.2). Proves the lane for real inside the built
// image: spawns server/browser-mcp.js the way the MCP client does, completes
// the MCP initialize handshake, and asserts the tool surface is non-empty.
//
// Chromium launch is NOT part of this gate — that downloads/launches a browser
// and belongs to the operation proof, not the image smoke. What this catches is
// the failure that actually bit the image path before (a missing runtime, a
// broken launcher, a wrong BROWSER_MCP_CLI): the lane's process must speak MCP.
//
// Run inside the image:  node scripts/browser-lane-smoke.mjs
// Run on a dev machine:  BROWSER_MCP_CLI=<path-to-@playwright/mcp/cli.js> node scripts/browser-lane-smoke.mjs
//
// Exit 0 = excellent; anything else prints the reason and exits non-zero.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = join(REPO_ROOT, "server", "browser-mcp.js");
const TIMEOUT_MS = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS) || 60_000;

const child = spawn(process.execPath, [LAUNCHER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const pending = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // non-protocol noise on stdout is itself a failure we surface below via timeout/logs
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function send(id, method, params) {
  const frame = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
  child.stdin.write(`${JSON.stringify(frame)}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

const timer = setTimeout(() => {
  console.error(`browser-lane-smoke: TIMEOUT after ${TIMEOUT_MS}ms`);
  if (stderr) console.error(`--- launcher stderr ---\n${stderr.slice(-2000)}`);
  child.kill("SIGKILL");
  process.exit(2);
}, TIMEOUT_MS);

try {
  const init = await send(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "browser-lane-smoke", version: "0" },
  });
  if (!init.result?.serverInfo) {
    throw new Error(`initialize returned no serverInfo: ${JSON.stringify(init).slice(0, 400)}`);
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await send(2, "tools/list");
  const tools = list.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`tools/list returned no tools: ${JSON.stringify(list).slice(0, 400)}`);
  }
  const names = tools.map((t) => t.name).filter(Boolean);
  console.log(
    `browser-lane-smoke: OK — ${init.result.serverInfo.name ?? "?"} answered with ${names.length} tool(s): ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`,
  );
  clearTimeout(timer);
  child.stdin.end();
  child.kill("SIGTERM");
  // Give the launcher a beat to reap its child, then leave.
  setTimeout(() => process.exit(0), 300);
} catch (err) {
  clearTimeout(timer);
  console.error(`browser-lane-smoke: FAILED — ${err?.message || err}`);
  if (stderr) console.error(`--- launcher stderr ---\n${stderr.slice(-2000)}`);
  child.kill("SIGKILL");
  process.exit(1);
}