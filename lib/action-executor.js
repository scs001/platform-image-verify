// ── Action executor (add-wire-line-board, design D3) ─────────────────────────
//
// The single execution path behind the action gate: an approved proposal names
// a registered action, the action names a tool, the tool lives on one of the
// line operation-MCP servers registered at the gateway. We call that tool as an
// MCP CLIENT over Streamable HTTP, with the USER's own line credential as the
// bearer — never a platform token, never another user's.
//
// Why a client and not a direct REST call: the operation MCP is the audited
// tool surface (tool_risk, argument validation, 422 passthrough semantics). A
// second path straight to the product REST would bypass all of that.
//
// One connection per execution (initialize → callTool → close). Actions are
// human-confirmed one at a time, so the handshake cost is irrelevant; pooling
// is a later optimisation if ever measured.
//
// Errors are classified, not swallowed: upstream 422 is passed through
// field-by-field verbatim, upstream 401 invalidates the user's credential so
// the browser re-mints on next visit, and an unroutable tool (facet/wanxing
// entries whose servers are not in the snapshot yet) fails honestly instead of
// pretending success.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMarketEntries, getRegistryUrl } from "../registry-bridge.js";
import * as lineCredentials from "../line-credentials.js";
import { serverForTool } from "./wire-tool-risk.js";

export const DEFAULT_TIMEOUT_MS = 20_000;

// Which paas credential ref carries a line's write tools. A line absent here
// has no executable actions yet — its proposals fail at execution with
// `credential_ref_unknown`, which is the honest outcome for the facet/wanxing
// placeholders until their refs are wired.
export const LINE_CREDENTIAL_REF = Object.freeze({
  wire: lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF,
});

export class ExecutorError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// The gateway endpoint of a registered server: the catalog's derived URL when
// the registry snapshot knows the server, else the same derivation the bridge
// uses ({REGISTRY_URL}/{name}/mcp). Null when neither is available.
export function resolveServerEndpoint(serverName, { entries = null, registryUrl = null } = {}) {
  const list = entries ?? safeMarketEntries();
  const hit = list.find((e) => e?.name === serverName);
  const fromCatalog = hit?.configTemplate?.url;
  if (typeof fromCatalog === "string" && fromCatalog) return fromCatalog;
  const base = (registryUrl ?? getRegistryUrl() ?? "").replace(/\/+$/, "");
  return base ? `${base}/${serverName}/mcp` : null;
}

function safeMarketEntries() {
  try {
    return getMarketEntries() ?? [];
  } catch {
    return [];
  }
}

// Wire's MCP layer raises `[kind] detail (HTTP status)` (WireClient.WireError);
// FastMCP surfaces that as an isError text result. Parse it back out so the gate
// can act on the status without guessing from prose.
const WIRE_ERROR_RE = /^\[([a-z_]+)\]\s*([\s\S]*?)(?:\s*\(HTTP (\d{3})\))?\s*$/;

export function classifyToolResult(result) {
  const text = contentText(result);
  if (!result?.isError) return { ok: true, text, status: null, kind: null, detail: text };
  const m = WIRE_ERROR_RE.exec(text);
  if (!m) return { ok: false, text, status: null, kind: "tool_error", detail: text };
  const [, kind, detail, status] = m;
  return {
    ok: false,
    text,
    kind,
    detail: detail.trim(),
    status: status ? Number(status) : kind === "missing_credential" || kind === "unauthorized" ? 401 : null,
  };
}

function contentText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

// Default transport: Streamable HTTP with the bearer on every request.
export function httpTransportFactory(endpoint, bearer) {
  return new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
}

// Call one tool on one server, once. Returns the raw MCP result.
export async function callLineTool({
  endpoint,
  toolName,
  args,
  bearer,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  transportFactory = httpTransportFactory,
}) {
  if (!endpoint) throw new ExecutorError("endpoint_unresolved", `no MCP endpoint for tool ${toolName}`);
  if (!bearer) throw new ExecutorError("credential_missing", "no live line credential for this user");
  const client = new Client({ name: "paas-action-executor", version: "0.1.0" });
  const transport = transportFactory(endpoint, bearer);
  try {
    await client.connect(transport);
    return await client.callTool({ name: toolName, arguments: args ?? {} }, undefined, { timeout: timeoutMs });
  } finally {
    await client.close().catch(() => {});
  }
}

// Execute a registered action for a user. Throws ExecutorError on every
// non-success; the caller (routes/actions.js) maps codes to proposal state.
export async function executeRegisteredAction({
  action,
  args,
  email,
  deps = {},
}) {
  const {
    liveToken = lineCredentials.liveToken,
    markInvalid = lineCredentials.markInvalid,
    resolveEndpoint = resolveServerEndpoint,
    callTool = callLineTool,
    serverFor = serverForTool,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;

  const ref = action?.credentialRef ?? LINE_CREDENTIAL_REF[action?.line] ?? null;
  if (!ref) {
    throw new ExecutorError("credential_ref_unknown", `line "${action?.line}" has no executable credential ref yet`);
  }
  const serverName = action?.server ?? serverFor(action?.tool);
  if (!serverName) {
    throw new ExecutorError("tool_unroutable", `tool "${action?.tool}" is not hosted by any known line MCP server`);
  }
  const bearer = liveToken(email, ref);
  if (!bearer) {
    throw new ExecutorError("credential_missing", `no live ${ref} credential for ${email || "the machine owner"}`, { ref });
  }
  const endpoint = resolveEndpoint(serverName);
  if (!endpoint) {
    throw new ExecutorError("endpoint_unresolved", `no MCP endpoint for server ${serverName}`, { server: serverName });
  }

  const started = Date.now();
  let result;
  try {
    result = await callTool({ endpoint, toolName: action.tool, args, bearer, timeoutMs });
  } catch (err) {
    if (err instanceof ExecutorError) throw err;
    throw new ExecutorError("transport_error", err?.message || String(err), { server: serverName });
  }
  const durationMs = Date.now() - started;
  const verdict = classifyToolResult(result);
  if (verdict.ok) {
    return { summary: verdict.text || `executed ${action.id}`, durationMs, server: serverName, structured: result?.structuredContent ?? null };
  }
  if (verdict.status === 401) {
    // The credential the upstream just rejected is dead: drop it so the browser
    // re-mints on the next visit, and tell the caller so the board can flip.
    markInvalid(email, ref);
    throw new ExecutorError("upstream_401", verdict.detail || "柏讯拒绝了当前凭据（401）", {
      status: 401,
      ref,
      credentialInvalidated: true,
      durationMs,
    });
  }
  if (verdict.status === 422 || verdict.kind === "invalid") {
    throw new ExecutorError("upstream_422", verdict.detail, {
      status: verdict.status ?? 422,
      fields: parseFieldErrors(verdict.detail),
      durationMs,
    });
  }
  throw new ExecutorError("tool_error", verdict.detail || verdict.text || "tool returned an error", {
    status: verdict.status,
    kind: verdict.kind,
    durationMs,
  });
}

// Best-effort extraction of FastAPI-style field errors ([{loc, msg, type}])
// from the verbatim detail. Returns [] when the detail is not that shape; the
// detail text itself is always carried alongside, untouched.
export function parseFieldErrors(detail) {
  if (typeof detail !== "string" || !detail) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(detail);
  } catch {
    // Python repr of a list of dicts: single quotes, tuples for `loc`,
    // None/True/False. Translate conservatively; the verbatim detail text is
    // carried alongside, so a failed parse only loses the structured view.
    try {
      const jsonish = detail
        .replace(/'/g, '"')
        .replace(/\(\s*"/g, '["')
        .replace(/"\s*\)/g, '"]')
        .replace(/\(\s*(\d)/g, "[$1")
        .replace(/(\d)\s*\)/g, "$1]")
        .replace(/\bNone\b/g, "null")
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");
      parsed = JSON.parse(jsonish);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      field: Array.isArray(e.loc) ? e.loc.filter((x) => x !== "body").join(".") : String(e.loc ?? ""),
      message: String(e.msg ?? e.message ?? ""),
      type: e.type ? String(e.type) : null,
    }));
}
