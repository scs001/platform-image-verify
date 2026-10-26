// Standalone resident entry: `node supervisor/steward-main.js`
//
// The process the per-user autostart launches (macOS LaunchAgent / Windows
// Scheduled Task). Resolves the same inputs electron/main.js resolves — data
// root per-OS, bundled node for children when packaged — constructs the SAME
// Supervisor and hangs the steward control plane on it. Chapter 2 adds the
// autostart registration and the policy engine; this entry is deliberately
// thin so both chapters ride one host.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Supervisor } from "./lifecycle.js";
import { createSteward } from "./steward.js";
import { createPolicyEngine } from "./steward-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function defaultDataDir() {
  if (process.env.PLATFORM_DATA_DIR) return process.env.PLATFORM_DATA_DIR;
  const name = process.env.STEWARD_APP_NAME || "platform";
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", name);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name);
  return path.join(os.homedir(), ".config", name);
}

const dataDir = defaultDataDir();
// launchd/schtasks give the resident steward a bare PATH (no "node" on it):
// falling back to `"node"` here spawned every child service into
// "command not found" restart loops on real installs (v1.3.19 first-trial).
// The steward itself already runs under the bundled node (packaged) whose
// ABI matches the children's native addons — reuse that binary by default.
const nodeBin = process.env.PLATFORM_NODE_BIN || process.execPath;

// Orphaned-steward self-clean (add-cell-lifecycle 2.1): on macOS a
// drag-deleted .app runs no uninstaller, so the LaunchAgent would respawn a
// steward whose bundle is gone forever. Detect "packaged entry inside a
// removed .app" and deregister ourselves — the platform registry row then
// reads `destroyed`/tombstoned by staleness (chapter 4).
{
  const inBundle = PROJECT_ROOT.split(path.sep).some((seg) => seg.endsWith(".app"));
  const bundleRoot = PROJECT_ROOT.slice(0, PROJECT_ROOT.indexOf(".app") + 4);
  if (inBundle && !fs.existsSync(bundleRoot)) {
    console.error(`[steward] app bundle gone (${bundleRoot}) — self-deregistering launch agent and exiting`);
    try {
      const { execFile } = await import("node:child_process");
      const uid = String(process.getuid?.() ?? "");
      execFile("launchctl", ["bootout", `gui/${uid}`, path.join(os.homedir(), "Library", "LaunchAgents", `com.earendil.${(process.env.STEWARD_APP_NAME || "platform")}.steward.plist`)], () => {});
      fs.rmSync(path.join(os.homedir(), "Library", "LaunchAgents", `com.earendil.${(process.env.STEWARD_APP_NAME || "platform")}.steward.plist`), { force: true });
    } catch { /* best-effort */ }
    process.exit(0);
  }
}

const supervisor = new Supervisor({ nodeBin, projectRoot: PROJECT_ROOT, dataDir, agentEnv: process.env });
const steward = createSteward({ supervisor, dataDir });

// Residency policy engine (chapter 2): always keeps the stack up; on_demand
// wakes on due schedules from jobs.json and drains on quiet; manual stays
// dark. The engine is constructed before listen so every client activity is
// visible to the quiet-drain decision.
const engine = createPolicyEngine({ supervisor, steward, dataDir });
steward.setPolicyEngine(engine);

const info = await steward.start();
console.log(`[steward] control plane on ${info.socket} (protocolVersion ${info.protocolVersion})`);

engine.start();

const quit = async (code = 0) => {
  await steward.shutdown({ removeDiscovery: true });
  process.exit(code);
};
process.on("SIGTERM", () => void quit(0));
process.on("SIGINT", () => void quit(0));
