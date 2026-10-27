// ── Steward IPC (add-cell-lifecycle, chapter 2) ─────────────────────────────
//
// The install/uninstall actions behind the Preferences "后台管家" section.
// Registration itself is per-user and zero-admin (LaunchAgent / schtasks);
// the install handler also proves the steward actually came up by attaching
// to its control plane before answering, so the UI never reports "installed"
// for a binary that failed to launch.

import { ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  STEWARD_CONSENT_TEXT,
  installPlan,
  uninstallPlan,
  launchAgentPlistPath,
  WIN_TASK_NAME,
} from "./steward-install.js";
import { attachSteward } from "../supervisor/steward-client.js";

const execFileP = promisify(execFile);

export function registerStewardIpc({ dataDir, nodeBin, projectRoot, isPackaged }) {
  ipcMain.handle("steward:consent", () => ({ consentText: STEWARD_CONSENT_TEXT }));

  ipcMain.handle("steward:status", async () => {
    const att = await attachSteward(dataDir).catch(() => ({ ok: false }));
    if (att.ok) {
      const ps = await att.client.request("pairStatus").catch(() => ({}));
      return {
        installed: true,
        running: true,
        protocolVersion: att.discovery?.protocolVersion ?? null,
        pid: att.discovery?.pid ?? null,
        paired: ps.paired === true,
        pairDeviceId: ps.deviceId ?? null,
        error: null,
      };
    }
    return {
      installed: installed(),
      running: false,
      protocolVersion: att.discovery?.protocolVersion ?? null,
      pid: att.discovery?.pid ?? null,
      paired: false,
      pairDeviceId: null,
      error: att.reason ?? null,
    };
  });

  // Pairing = the explicit opt-in for uplink (add-cell-lifecycle 4.1/4.3).
  // The control plane validates and stores the identity; the renderer passes a
  // six-digit bind code + a display label.
  ipcMain.handle("steward:pair", async (_ev, { code, label }) => {
    const att = await attachSteward(dataDir).catch(() => null);
    if (!att?.ok) return { ok: false, error: "后台管家不在运行——先安装并启动" };
    const r = await att.client.request("pair", { code, label }).catch((e) => ({ error: e.message }));
    return r.error ? { ok: false, error: r.error } : { ok: true, email: r.email ?? null };
  });

  ipcMain.handle("steward:unpair", async () => {
    const att = await attachSteward(dataDir).catch(() => null);
    if (!att?.ok) return { ok: false, error: "后台管家不在运行" };
    const r = await att.client.request("unpair").catch((e) => ({ error: e.message }));
    return r.error ? { ok: false, error: r.error } : { ok: true };
  });

  ipcMain.handle("steward:install", async () => {
    const plan = installPlan({ isPackaged, nodeBin, dataDir, projectRoot });
    if (plan.platform === "unsupported") return { ok: false, error: `unsupported platform: ${process.platform}` };
    if (plan.platform === "darwin") {
      fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
      fs.writeFileSync(plan.plistPath, plan.plistContent);
      await execFileP("launchctl", plan.bootstrappArgs ?? plan.bootstrapArgs).catch(async () => {
        // Older aliases: kickstart as the bootstrap fallback.
        await execFileP("launchctl", ["kickstart", "-k", `gui/${String(process.getuid())}/com.earendil.platform.steward`]);
      });
    } else {
      await execFileP("schtasks", plan.taskArgs);
      await execFileP("schtasks", ["/Run", "/TN", WIN_TASK_NAME]).catch(() => {});
    }
    // Prove it came up: the discovery file + a hello on the control plane.
    const deadline = Date.now() + 8000;
    for (;;) {
      const att = await attachSteward(dataDir).catch(() => ({ ok: false }));
      if (att.ok) return { ok: true, pid: att.discovery?.pid };
      if (Date.now() > deadline) return { ok: false, error: "steward registered but did not answer its control plane within 8s" };
      await new Promise((r) => setTimeout(r, 400));
    }
  });

  ipcMain.handle("steward:uninstall", async () => {
    // Drain first (best-effort): the steward stops the runtime stack itself,
    // so no orphan children survive deregistration.
    const att = await attachSteward(dataDir).catch(() => ({ ok: false }));
    if (att.ok) await att.client.request("drainQuit").catch(() => {});
    const plan = uninstallPlan();
    if (plan.platform === "darwin") {
      await execFileP("launchctl", plan.bootoutArgs).catch(() => {});
      if (plan.remove) fs.rmSync(plan.remove, { force: true });
    } else if (plan.platform === "win32") {
      await execFileP("schtasks", plan.taskArgs).catch(() => {});
    }
    return { ok: true };
  });
}

function installed() {
  if (process.platform === "darwin") return fs.existsSync(launchAgentPlistPath());
  if (process.platform === "win32") return true; // schtasks /Query is answered by the running state probe instead
  return false;
}
