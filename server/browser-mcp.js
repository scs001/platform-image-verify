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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

// Launch configuration goes through the CLI's --config file, not flags: the
// chromium ARGS we need (see the sandbox note) have no CLI passthrough, and
// browser.launchOptions is the supported surface (config.d.ts).
// Container reality: the runtime image runs as the non-root `node` user and
// Chromium's sandbox needs root or a configured user-namespace profile — the
// headless launch died with "Chromium sandboxing failed!" (2026-10-28 image
// smoke). Default to the standard containerized-headless posture
// (--no-sandbox + --disable-dev-shm-usage, the latter for the small /dev/shm
// containers normally have); BROWSER_SANDBOX=1 keeps the sandbox on for
// deployments that configure userns/seccomp and a sized /dev/shm. The browser
// browses untrusted pages, so this is a real trade-off — taken deliberately
// and visible here rather than buried in a run script.
const endpoint = (process.env.BROWSER_CDP_ENDPOINT || "").trim();
const headless = process.env.BROWSER_HEADLESS !== "0";
const browserConfig = { browser: {} };
if (endpoint) {
  // Attach mode: an existing browser at the endpoint; no local binary needed.
  browserConfig.browser.cdpEndpoint = endpoint;
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
  browserConfig.browser.launchOptions = {
    executablePath: chromium,
    headless,
    ...(process.env.BROWSER_SANDBOX === "1" ? {} : { args: ["--no-sandbox", "--disable-dev-shm-usage"] }),
  };
}

// Output dir (resource-library walkthrough defect, 2026-10-28): by default
// @playwright/mcp writes screenshots/downloads under os.tmpdir()/.playwright-mcp,
// outside the user's workspace — so the cell's file-capture hook rejected them
// with invalid_path (and the agent's artifacts can't be served via /api/files
// or offered as save-to-library). Point the lane's outputs at the workspace:
// explicit BROWSER_OUTPUT_DIR wins, else the AGENT_WORKSPACE pin the deployment
// sets, else this process's own cwd (a dsh-mcp-client child launches in the
// session's validated workspace).
// Resolve an output dir, or leave it UNSET: the CLI's own default (a writable
// temp dir) beats a cwd that may be a read-only /app — an early version fell
// back to process.cwd() and the image smoke died with "EACCES: open
// '/app/page-….yml'" (2026-10-28). The platform injects BROWSER_OUTPUT_DIR =
// the session workspace per cell (dsh-profile lane entry), which is the only
// value that routes artifacts into the user's workspace for resource capture.
//
// It must configure BOTH channels, learned the hard way in the image smoke:
//   - config `outputDir`     → auto page snapshots / downloads
//   - the CLI's process CWD  → `browser_take_screenshot`'s filename, which the
//                              CLI resolves relative to its own cwd ("EACCES:
//                              open '/app/browser-lane-smoke.png'" in CI, where
//                              cwd=/app is read-only)
const laneOutputDir =
  (process.env.BROWSER_OUTPUT_DIR || "").trim() || (process.env.AGENT_WORKSPACE || "").trim();
if (laneOutputDir) browserConfig.outputDir = laneOutputDir;

const configDir = mkdtempSync(join(tmpdir(), "browser-mcp-"));
const configPath = join(configDir, "config.json");
writeFileSync(configPath, JSON.stringify(browserConfig));
const args = ["--config", configPath];

const child = spawn(process.execPath, [cli, ...args], {
  stdio: "inherit",
  // The CLI must see the deployment's chromium/sandbox paths (PLAYWRIGHT_*).
  env: process.env,
  // Screenshots resolve against the CLI's cwd (see above); pin it to the
  // resolved output dir when we have one, else inherit.
  ...(laneOutputDir && existsSync(laneOutputDir) ? { cwd: laneOutputDir } : {}),
});
const cleanupConfig = () => {
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
};
child.on("exit", cleanupConfig);
process.on("exit", cleanupConfig);
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