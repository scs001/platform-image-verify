// connect-guidance.js — classify credential-shaped failures into a connect
// pointer (chat-connect-guidance, design D1/D2).
//
// Two entry points, both pure classification over text plus the failing
// tool's server config:
//   turnErrorHint(message)            model-lane turn failures → the 词元 card
//   toolFailureHint(tool, resultText) failed MCP tool calls → the failing
//                                     server's credential-ref panel
//
// Classification is ADDITIVE by contract: callers attach the returned
// `{panel}` to the WS event; they never rewrite the model-visible text.

import * as fs from "node:fs";
import * as path from "node:path";
import * as extensionStore from "../extension-store.js";
import * as credentialRefs from "../credential-refs.js";

// Credential-shaped failure text, server-side only (D2). Deliberately wider
// than the stale marker's `\b401\b|unauthoriz` in markCredentialStaleOn401:
// invalid-key failures often arrive as 400/"Incorrect API key" and still have
// the same user-side repair (re-connect). Both consumers keep their own
// breadth — they answer different questions.
const CREDENTIAL_RE =
  /\b40[13]\b|unauthoriz|invalid[ _-]?api[ _-]?key|incorrect api key|api key (?:is )?(?:invalid|missing|required)|missing[ _-]?api[ _-]?key|credential|auth(entication)? (?:failed|error)|认证失败|鉴权失败|密钥(无效|错误|缺失)|凭据(无效|缺失)|令牌(无效|过期)/i;

// Model-lane turn failures: after ciyuan-account-lane the user-side repair
// path for model credentials is the 词元 account card (binding a personal
// account also rides out a broken deployment seed key — the hint stays honest
// for both cases).
export function turnErrorHint(message) {
  if (typeof message !== "string" || !message) return null;
  return CREDENTIAL_RE.test(message) ? { panel: "ciyuan-account" } : null;
}

// Failed MCP tool calls: `mcp__<server>__<tool>` → the server's config (DB
// market install or mcp.json baseline) → its credentialRef → that ref's
// connect panel. No ref（a public server, a config without credentials）→
// no hint: there is nothing to connect.
export function toolFailureHint(toolName, resultText) {
  if (!toolName || typeof resultText !== "string" || !resultText) return null;
  if (!CREDENTIAL_RE.test(resultText)) return null;
  const serverName = /^mcp__(.+?)__/.exec(toolName)?.[1];
  if (!serverName) return null;
  let config = null;
  try {
    config = extensionStore.getMcpServer(serverName)?.config ?? null;
  } catch {
    /* store unavailable (no DB yet) — fall through to mcp.json */
  }
  if (!config) {
    try {
      const mcpPath = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");
      config = JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers?.[serverName] ?? null;
    } catch {
      /* no mcp.json / unreadable — nothing more to look up */
    }
  }
  if (!config) return null;
  const entry = credentialRefs.refFor(config);
  if (!entry) return null;
  const panel = credentialRefs.connectPanelForRef(entry.refName);
  return panel ? { panel } : null;
}
