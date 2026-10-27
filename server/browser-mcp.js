// server/browser-mcp.js — the browser lane's stdio launcher
// (add-browser-use-lane). A first-party thin process (the websearch-mcp
// precedent) that execs the PINNED @playwright/mcp CLI so the lane's version
// and flags are deployment facts, not npx resolution at call time:
//
//   local   BROWSER_RUNTIME_PATH supplies a chromium install; the CLI launches
//           its own headless browser (default).
//   remote  BROWSER_CDP_ENDPOINT points at an existing browser; the CLI attaches
//           (no local runtime needed).
//   absent  the supply gate in dsh-profile.js omits the entry entirely — this
//           launcher is never spawned. If it is spawned anyway (an operator
//           added the entry BY HAND through the extension API), it fails loudly
//           on stdio-adjacent stderr so the MCP client's degrade path shows the
//           reason instead of a silent dead tool surface.
//
// Env contract (see .env.example):
//   BROWSER_MCP_CLI        absolute path to @playwright/mcp's cli.js (image
//                          bakes /opt/browser-mcp/...; desktop opt-in sets it)
//   BROWSER_CDP_ENDPOINT   attach to this browser instead of launching
//   BROWSER_HEADLESS       "0" launches headful (desktop local use)
//   BROWSER_LANE           "off" is honored by the gate, not here
//
// stdout belongs to the MCP protocol: every diagnostic goes to stderr.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

function resolveCli() {
  const configured = (process.env.BROWSER_MCP_CLI || "").trim();
  if (configured) return existsSync(configured) ? configured : null;
  // Fallback: a tree that declares @playwright/mcp (the packaged app tree can,
  // once a deployment chooses to bake it there).
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@playwright/mcp/cli.js");
  } catch {
    return null;
  }
}

// @playwright/mcp's `--browser` takes CHANNELS (chrome/firefox/webkit/msedge)
// and its default `chrome` resolves to a system Google Chrome the deployment
// does not have — the bundled chromium we bake is invisible to it. Point it at
// our binary explicitly (2026-10-28: the image smoke caught exactly this,
// "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome").
// Resolution order: BROWSER_CHROMIUM_PATH, else a scan of the browsers dir for
// the chromium build playwright installs (linux and macOS layouts, full
// chromium first, then the headless shell).
const BROWSER_BINARY_CANDIDATES = [
  [/(^|-)chromium-\d+$/, ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"]],
  [/^chromium_headless_shell-\d+$/, ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-headless-shell-linux/chrome-headless-shell", "chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell"]],
];

function resolveChromium() {
  const explicit = (process.env.BROWSER_CHROMIUM_PATH || "").trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const root = (process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/browser-mcp/ms-playwright").trim();
  if (!root || !existsSync(root)) return null;
  let entries = [];
  try {
    entries = readdirSync(root).sort().reverse(); // newest build first
  } catch {
    return null;
  }
  for (const [pattern, suffixes] of BROWSER_BINARY_CANDIDATES) {
    for (const dir of entries.filter((e) => pattern.test(e))) {
      for (const suffix of suffixes) {
        const candidate = join(root, dir, suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const cli = resolveCli();
if (!cli) {
  console.error(
    "[browser-mcp] @playwright/mcp is not installed in this deployment " +
      "(set BROWSER_MCP_CLI, or BROWSER_LANE=off to omit the lane deliberately)",
  );
  process.exit(1);
}

const args = [];
// Headless is the default; BROWSER_HEADLESS=0 is the desktop local-use escape.
if (process.env.BROWSER_HEADLESS !== "0") args.push("--headless");
const endpoint = (process.env.BROWSER_CDP_ENDPOINT || "").trim();
if (endpoint) {
  // Attach mode: an existing browser at the endpoint; no local binary needed.
  args.push("--cdp-endpoint", endpoint);
} else {
  const chromium = resolveChromium();
  if (!chromium) {
    console.error(
      "[browser-mcp] no chromium found for the browser lane " +
        "(set BROWSER_CHROMIUM_PATH, or PLAYWRIGHT_BROWSERS_PATH to the browsers dir; " +
        "the image bakes both at /opt/browser-mcp)",
    );
    process.exit(1);
  }
  args.push("--executable-path", chromium);
}

const child = spawn(process.execPath, [cli, ...args], {
  stdio: "inherit",
  // The CLI must see the deployment's chromium/sandbox paths (PLAYWRIGHT_*).
  env: process.env,
});
child.on("error", (err) => {
  console.error(`[browser-mcp] failed to start @playwright/mcp: ${err?.message || err}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[browser-mcp] @playwright/mcp exited on ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
// The MCP host closes our stdin when it goes away; stop the browser with us.
process.stdin.on("end", () => child.kill("SIGTERM"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));