#!/usr/bin/env node
// ── Refresh one registry entry's tool_list snapshot (add-mcp-tool-scoping) ───
//
// The publish gate treats the registry entry's `tool_list` as its truth. When
// a server's tool surface changed after registration (or the snapshot was never
// refreshed), a legitimate declaration can read as missing — and with the live
// probe unavailable (the billing gate answers 503 fail-closed on the public
// MCP route), the gate can only say "unresolved". This script is the next step
// that message points at: re-read the tool names from the server and write them
// back into the entry.
//
// Two read paths, in order of preference:
//   1. runtime — initialize + tools/list against the MCP endpoint (preferred;
//      the ledger's authority order puts live runtime above everything else).
//      The public gateway route is billing-gated, so pass the upstream URL
//      (`--upstream`, from the ledger's 上游 column) when the public route
//      answers 503 BILLING_UNAVAILABLE.
//   2. --from-json <file> — an already-captured tools/list result.
//
// The write goes through the console-session PATCH channel (JSON Merge Patch),
// which needs an admin session cookie and a CSRF token; reuse the token file
// the pack-builder flow already uses, or pass --csrf/--cookie explicitly.
//
//   node scripts/refresh-registry-tool-list.mjs --path /law-bench --upstream http://cheap6.mesh.finddata.cn:30840/mcp
//   node scripts/refresh-registry-tool-list.mjs --path /law-bench --from-json /tmp/tools.json --dry-run
//
// Exit code: 0 success / 1 failure (nothing written on failure).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeMcpToolNames } from "../lib/publish-tool-gate.js";

const REGISTRY = process.env.REGISTRY_URL || "https://mcp.finddatatech.cloud";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const entryPath = arg("path");
if (!entryPath) {
  console.error("✗ --path /<registry-entry-path> is required");
  process.exit(1);
}
const dryRun = has("dry-run");

// ── 1. read the current tool names ───────────────────────────────────────────
let names = null;
const fromJson = arg("from-json");
if (fromJson) {
  const doc = JSON.parse(readFileSync(fromJson, "utf8"));
  const tools = Array.isArray(doc) ? doc : doc?.result?.tools ?? doc?.tools;
  if (!Array.isArray(tools)) throw new Error(`${fromJson}: no tools array found`);
  names = tools.map((t) => t?.name).filter((n) => typeof n === "string");
  console.log(`[refresh] read ${names.length} tool name(s) from ${fromJson}`);
} else {
  const endpoint = arg("upstream") || `${REGISTRY.replace(/\/+$/, "")}${entryPath}/mcp`;
  const bearer = process.env.REGISTRY_BEARER || (
    (() => {
      try {
        const f = join(homedir(), ".config/finddata/gateway-token.json");
        return JSON.parse(readFileSync(f, "utf8"))?.tokens?.access_token || null;
      } catch { return null; }
    })()
  );
  names = await probeMcpToolNames(endpoint, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    timeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 10_000),
  });
  if (!names) {
    const why = probeMcpToolNames.lastError?.message || "unknown";
    const hints = /BILLING_UNAVAILABLE/.test(why)
      ? "the public route is behind the billing gate — retry with --upstream <ledger 上游 URL> from a host that can reach it"
      : /401|403|not authorized/.test(why)
        ? "this endpoint wants its own credential, not the registry token — capture the list on a host that has it"
        : "check reachability and credentials";
    console.error(`✗ could not read tools/list from ${endpoint}: ${why}\n  → ${hints}`);
    process.exit(1);
  }
  console.log(`[refresh] probed ${names.length} tool name(s) from ${endpoint}`);
}

// ── 2. write them back into the entry ────────────────────────────────────────
const cookie = process.env.REGISTRY_COOKIE || arg("cookie");
if (!cookie) {
  console.error(
    `✗ an admin console session is required to PATCH the entry.\n` +
      `  Set REGISTRY_COOKIE (copy the session cookie from a logged-in console tab) and REGISTRY_CSRF (from GET ${REGISTRY}/api/auth/csrf-token).\n` +
      `  Names are ready to paste manually otherwise: ${names.join(", ")}`,
  );
  process.exit(1);
}
const csrf = process.env.REGISTRY_CSRF || arg("csrf");
if (!csrf) {
  console.error("✗ REGISTRY_CSRF (or --csrf) is required alongside the session cookie");
  process.exit(1);
}

if (dryRun) {
  console.log(`[refresh] dry run — would PATCH ${entryPath} with ${names.length} tool name(s)`);
  console.log(names.join(", "));
  process.exit(0);
}

const res = await fetch(`${REGISTRY.replace(/\/+$/, "")}/api/servers${entryPath}`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
    Cookie: cookie,
  },
  body: JSON.stringify({ tool_list: names, num_tools: names.length }),
});
if (!res.ok) {
  console.error(`✗ PATCH failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
console.log(`[refresh] ${entryPath}: tool_list refreshed to ${names.length} name(s)`);
