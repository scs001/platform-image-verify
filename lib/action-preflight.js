// ── Action preflight (add-line-boards-and-action-gate, task 1.5) ─────────────
//
// Checks a proposed action's target before it enters a confirmation tier.
// Deployment-agnostic by design: the SAME deploy action has two targets with
// different prerequisites.
//
//   target=cloud          → requires the user's `wanxing-deployer` ref
//                           (a pasted sub2api sk- key that carries the
//                           deployed service's autonomous turns)
//   target=desktop:<seat> → requires the seat to be paired and (when it is
//                           this machine) online; NEVER requires a billing key
//
// A failed preflight blocks the proposal and returns a human-readable fix.

import { getLineCredential } from "../db.js";
import * as lineCredentials from "../line-credentials.js";
import { connectPathForRef } from "../credential-refs.js";

const DEPLOYER_LINE = "wanxing-deployer";

// Line-credential preflight (add-wire-line-board 2.3): an action executed with
// the user's own line credential is pointless to confirm when that credential
// is absent or expired — refuse before the confirmation tier and point at the
// connect card. `liveToken` already applies the ref's expiry/stale semantics,
// so the same helper is correct for ID-token lines (wire/lex) and pasted keys.
export function requireLineCredential(line, { label = line } = {}) {
  const connectPath = connectPathForRef(line);
  return async (ctx) => {
    const email = String(ctx?.email || "").trim();
    if (lineCredentials.liveToken(email, line)) return { ok: true };
    return {
      ok: false,
      details: `需要先连接${label}：设置 → 连接 → ${label}（${connectPath}）`,
      connectPath,
      credentialRef: line,
    };
  };
}
const SEAT_RE = /^desktop-[A-Za-z0-9._-]{1,60}$/;
const HEALTH_TIMEOUT_MS = 2000;

function identityEmail(ctx) {
  return String(ctx?.email || "").trim().toLowerCase() || null;
}

async function localRunnerHealthy() {
  const base = String(process.env.WANXING_RUNNER_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deploy preflight. Returns { ok: true } or { ok: false, details }.
 */
export async function preflightDeploy(ctx, args) {
  const target = String(args?.target || "");

  if (target === "cloud") {
    const email = identityEmail(ctx);
    if (!email) {
      return { ok: false, details: "云端部署需要登录身份：请先登录后再试" };
    }
    const cred = getLineCredential(email, DEPLOYER_LINE);
    if (!cred || cred.stale) {
      return {
        ok: false,
        details: "云端部署需要先连接部署者凭据（设置 → 连接 → 萬星部署者，粘贴 sub2api sk- key）",
      };
    }
    return { ok: true };
  }

  if (target.startsWith("desktop:")) {
    const seat = target.slice("desktop:".length);
    if (!SEAT_RE.test(seat)) {
      return { ok: false, details: `机位格式不合法：${seat || "(空)"}（应为 desktop-…）` };
    }
    // Only this machine's seat is probeable from the cell. A remote seat's
    // online state is the registry's truth; accept and let the deploy fail
    // honestly rather than blocking a valid remote target here.
    const localSeat = String(process.env.WANXING_PLUGIN_RUNNER_ID || "");
    if (localSeat && localSeat === seat) {
      const healthy = await localRunnerHealthy();
      if (!healthy) {
        return {
          ok: false,
          details: "本机机位当前离线：请打开桌面应用并启用「萬星舰队」后重试（桌面部署不需要计费键）",
        };
      }
    }
    return { ok: true };
  }

  return { ok: false, details: "target 必须是 cloud 或 desktop:<seat>" };
}

/**
 * Generic preflight dispatcher. Falls back to the registry's own hook.
 */
export async function preflightAction(action, ctx, args) {
  if (action.id === "wanxing.agent.deploy") return preflightDeploy(ctx, args);
  if (typeof action.preflight === "function") return action.preflight(ctx, args);
  return { ok: true };
}
