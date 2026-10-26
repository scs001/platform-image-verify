// ── Steward autostart installer (add-cell-lifecycle, chapter 2) ────────────
//
// Per-user, zero-admin registration of the resident steward:
//   macOS   ~/Library/LaunchAgents/<appId>.steward.plist  (KeepAlive)
//   Windows schtasks ONLOGON LIMITED (no UAC), entry "PlatformSteward"
//
// Consent is explicit and names the three facts (spec: resident service,
// launch-at-login, and — once paired — heartbeat reporting). The uninstall
// path deregisters AND stops; on macOS a drag-deleted .app can't run hooks,
// so the steward also self-cleans when its bundle is gone (see steward-main).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STEWARD_CONSENT_TEXT =
  "安装后台管家将开启三件事：\n" +
  "1. 一个常驻后台服务（退出应用后，舰队与定时任务继续运行）；\n" +
  "2. 开机自启动（登录本机后自动拉起，不需要管理员权限）；\n" +
  "3. 若之后完成配对，将向平台上报心跳（在线状态与需求计数，绝不含会话内容）。";

export function stewardEntryPath({ isPackaged, resourcesDir = process.resourcesPath, projectRoot }) {
  return isPackaged
    ? path.join(resourcesDir, "app", "supervisor", "steward-main.js")
    : path.join(projectRoot, "supervisor", "steward-main.js");
}

// ── macOS — LaunchAgent ────────────────────────────────────────────────────

export function launchAgentPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.earendil.platform.steward.plist");
}

export function buildLaunchAgentPlist({ nodeBin, entryPath, logDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.earendil.platform.steward</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(entryPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${escapeXml(logDir)}/steward.log</string>
  <key>StandardErrorPath</key><string>${escapeXml(logDir)}/steward.log</string>
</dict>
</plist>
`;
}

// ── Windows — Scheduled Task (modern XML-free path, schtasks CLI) ──────────

export const WIN_TASK_NAME = "PlatformSteward";
export function schtasksCreateArgs({ nodeBin, entryPath }) {
  return ["/Create", "/TN", WIN_TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", `"${nodeBin}" "${entryPath}"`];
}
export const schtasksDeleteArgs = ["/Delete", "/TN", WIN_TASK_NAME, "/F"];

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// install() returns a plan; callers execute. Kept side-effect-light so the
// wizard can show what will happen before the user confirms.
export function installPlan({ isPackaged, nodeBin, dataDir, projectRoot, resourcesDir = process.resourcesPath }) {
  const entryPath = stewardEntryPath({ isPackaged, resourcesDir, projectRoot });
  const logDir = path.join(dataDir, "logs");
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      plistPath: launchAgentPlistPath(),
      plistContent: buildLaunchAgentPlist({ nodeBin, entryPath, logDir }),
      bootstrapArgs: ["bootstrap", `gui/${String(process.getuid?.() ?? "")}`, launchAgentPlistPath()],
    };
  }
  if (process.platform === "win32") {
    return { platform: "win32", taskArgs: schtasksCreateArgs({ nodeBin, entryPath }) };
  }
  return { platform: "unsupported" };
}

export function uninstallPlan() {
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      plistPath: launchAgentPlistPath(),
      bootoutArgs: ["bootout", `gui/${String(process.getuid?.() ?? "")}`, launchAgentPlistPath()],
      remove: launchAgentPlistPath(),
    };
  }
  if (process.platform === "win32") return { platform: "win32", taskArgs: ["/Delete", "/TN", WIN_TASK_NAME, "/F"] };
  return { platform: "unsupported" };
}
