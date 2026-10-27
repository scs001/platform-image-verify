// scripts/browser-lane-smoke.mjs — image smoke for the browser lane
// (add-browser-use-lane, task 2.2). Proves the lane for real inside the built
// image: spawns server/browser-mcp.js the way the MCP client does, completes
// the MCP initialize handshake, and asserts the tool surface is non-empty.
//
// Launching chromium itself is NOT part of this gate — it is the operation
// proof's business. What this catches is the image-layer failure class (a
// missing runtime, a broken launcher, a wrong BROWSER_MCP_CLI): the lane's
// process must at least speak MCP.
//
// Run inside the image:  node /app/scripts/browser-lane-smoke.mjs
// Exit 0 = the lane speaks MCP; anything else prints the reason and exits 1.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = join(REPO_ROOT, "server", "browser-mcp.js");
const TIMEOUT_MS = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS) || 60_000;

const child = spawn(process.execPath, [LAUNCHER], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (c) => (stderr += String(c)));

const answer = new Promise((resolve, reject) => {
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += String(chunk);
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.on("exit", (code) => reject(new Error(`launcher exited (code=${code}): ${stderr.trim().slice(-300)}`)));
  child.on("error", (err) => reject(new Error(`launcher spawn failed: ${err?.message || err}: ${stderr.trim().slice(-300)}`)));

  let nextId = 0;
  const call = (method, params) => {
    const id = ++nextId;
    return new Promise((res, rej) => {
      pending.set(id, (msg) => (msg.error ? rej(new Error(`${method} error: ${JSON.stringify(msg.error).slice(0, 200)}`)) : res(msg.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  (async () => {
    try {
      await call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "browser-lane-smoke", version: "0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools = await call("tools/list", {});
      resolve(Array.isArray(tools?.tools) ? tools.tools.length : -1);
    } catch (err) {
      reject(err);
    }
  })();
});

// An image deliberately built without the browser lane says so on stderr
// ("@playwright/mcp is not installed in this deployment"). That is a declared
// absence, not a broken lane: skip honestly instead of failing the release on
// a gate the deployment opted out of (2026-10-27: the timeout used to bury
// this signal and blocked the image job).
const LANE_ABSENT = /@playwright\/mcp is not installed in this deployment/;
const skipIfLaneAbsent = () => {
  if (!LANE_ABSENT.test(stderr)) return false;
  console.log("browser-lane-smoke: SKIP — this image has no browser lane (launcher reports @playwright/mcp not installed)");
  return true;
};

const timeout = setTimeout(() => {
  try { child.kill("SIGKILL"); } catch {}
  if (skipIfLaneAbsent()) process.exit(0);
  console.error(`browser-lane-smoke: TIMEOUT after ${TIMEOUT_MS}ms — no MCP answer. stderr tail:\n${stderr.trim().slice(-500)}`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  const n = await answer;
  clearTimeout(timeout);
  child.kill("SIGTERM");
  if (n <= 0) {
    console.error(`browser-lane-smoke: tools/list returned ${n} tools — expected a non-empty browser tool surface`);
    process.exit(1);
  }
  console.log(`browser-lane-smoke: MCP handshake + tools/list ok (${n} tools)`);
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  if (skipIfLaneAbsent()) process.exit(0);
  console.error(`browser-lane-smoke: FAIL — ${err?.message || err}`);
  process.exit(1);
}