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
// field-by-field verbatim, upstream 401 (at the HTTP layer or as a tool error)
// invalidates the user's credential so the browser re-mints on next visit, and
// an unroutable tool or a server the catalog does not know fails honestly
// instead of pretending success.
//
// Which credential: the ref an action executes with is resolved in precedence
// order — the action's own `credentialRef`, the line's fixed ref (wire), else
// what the hosting server's registry entry declares (facet-market-mcp declares
// `facet-market`; an entry declaring nothing means the incumbent registry
// token). That last rule is the install path's own (credential-refs
// credentialRefForEntry), so the executor presents exactly the bearer the
// user's cell presents when it calls the same server through its pack.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { credentialRefForEntry, invalidateRef, liveTokenForRef } from "../credential-refs.js";
import { getMarketEntries, getRegistryUrl } from "../registry-bridge.js";
import * as lineCredentials from "../line-credentials.js";
import { serverForTool } from "./wire-tool-risk.js";

export const DEFAULT_TIMEOUT_MS = 20_000;

// Lines whose every action executes with ONE fixed paas credential ref,
// regardless of which of the line's servers hosts the tool. Lines absent here
// (facet, wanxing) take the ref from the hosting server's registry entry.
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

// The catalog's server entries. getMarketEntries() returns the snapshot object
// ({ mcpServers, skills }), not a list — reading it as a list threw on every
// un-stubbed execution (caught 2026-10-21 before the first live run).
function safeMarketEntries() {
  try {
    const snap = getMarketEntries();
    if (Array.isArray(snap)) return snap;
    return Array.isArray(snap?.mcpServers) ? snap.mcpServers : [];
  } catch {
    return [];
  }
}

// The catalog entry of a registered server, or null when the snapshot does not
// know it (cold start, or a server the registry never listed).
export function marketEntryFor(serverName, { entries = null } = {}) {
  if (!serverName) return null;
  const list = entries ?? safeMarketEntries();
  return list.find((e) => e?.name === serverName) ?? null;
}

// The credential ref an action executes with (see the header): action
// declaration → line's fixed ref → the hosting server's registry declaration.
// Null when nothing can say — the caller fails `credential_ref_unknown`.
export function resolveCredentialRef(action, serverName, { entryFor = marketEntryFor } = {}) {
  if (typeof action?.credentialRef === "string" && action.credentialRef) return action.credentialRef;
  const fixed = LINE_CREDENTIAL_REF[action?.line];
  if (fixed) return fixed;
  const entry = entryFor(serverName);
  return entry ? credentialRefForEntry(entry) : null;
}

// Wire's MCP layer raises `[kind] detail (HTTP status)` (WireClient.WireError);
// FastMCP surfaces that as an isError text result. Parse it back out so the gate
// can act on the status without guessing from prose.
const WIRE_ERROR_RE = /^\[([a-z_]+)\]\s*([\s\S]*?)(?:\s*\(HTTP (\d{3})\))?\s*$/;
// Servers without that envelope (facet-ops / facet-market / wanxing-ops) word
// an auth rejection freely; this is the stale marker's own test
// (server/dsh-events.js UNAUTHORIZED_RE), reused so the gate and the profile
// path flip the same credential on the same evidence.
const UNAUTHORIZED_TEXT_RE = /\b401\b|unauthoriz/i;

export function classifyToolResult(result) {
  const text = contentText(result);
  if (!result?.isError) return { ok: true, text, status: null, kind: null, detail: text };
  const m = WIRE_ERROR_RE.exec(text);
  if (!m) {
    if (UNAUTHORIZED_TEXT_RE.test(text)) return { ok: false, text, status: 401, kind: "unauthorized", detail: text };
    return { ok: false, text, status: null, kind: "tool_error", detail: text };
  }
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
// `liveToken` / `markInvalid` keep the (email, ref) order of the line store
// they started as; the defaults dispatch through the credential-refs table.
export async function executeRegisteredAction({
  action,
  args,
  email,
  deps = {},
}) {
  const {
    liveToken = (owner, ref) => liveTokenForRef(ref, owner),
    markInvalid = (owner, ref) => invalidateRef(ref, owner),
    resolveEndpoint = resolveServerEndpoint,
    resolveRef = resolveCredentialRef,
    callTool = callLineTool,
    serverFor = serverForTool,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;

  // Routing is declarative: a facet/wanxing action names its server; a wire
  // action is pinned to the vendored tool-surface snapshot. Neither falls back
  // to the other, so a wire action can never reach a facet tool by name.
  // Routing is judged before the credential so an absent tool reports its own
  // cause (tool_unroutable) instead of a credential it would never have used.
  const serverName = action?.server ?? serverFor(action?.tool);
  if (!serverName) {
    throw new ExecutorError("tool_unroutable", `tool "${action?.tool}" is not hosted by any known line MCP server`);
  }
  const ref = resolveRef(action, serverName);
  if (!ref) {
    throw new ExecutorError("credential_ref_unknown", `line "${action?.line}" has no executable credential ref yet`);
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
  const rejected = (detail, durationMs) => {
    // The credential the upstream just rejected is dead: drop it so the browser
    // re-mints on the next visit, and tell the caller so the board can flip.
    markInvalid(email, ref);
    return new ExecutorError("upstream_401", detail || "上游拒绝了当前凭据（401）", {
      status: 401,
      ref,
      server: serverName,
      credentialInvalidated: true,
      durationMs,
    });
  };
  let result;
  try {
    result = await callTool({ endpoint, toolName: action.tool, args, bearer, timeoutMs });
  } catch (err) {
    if (err instanceof ExecutorError) throw err;
    // An HTTP-layer 401 (the server's auth gate, before any tool runs) is the
    // same evidence as a tool-level one: StreamableHTTPError carries the status
    // as a numeric `code`.
    if (err?.code === 401) throw rejected(null, Date.now() - started);
    throw new ExecutorError("transport_error", err?.message || String(err), { server: serverName });
  }
  const durationMs = Date.now() - started;
  const verdict = classifyToolResult(result);
  if (verdict.ok) {
    return { summary: verdict.text || `executed ${action.id}`, durationMs, server: serverName, structured: result?.structuredContent ?? null };
  }
  if (verdict.status === 401) throw rejected(verdict.detail, durationMs);
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
