#!/usr/bin/env node
// ── Tool-scope bridge tests (add-mcp-tool-scoping, tasks 3.1–3.2) ────────────
//
// Exercises dsh-profile-template/platform-tool-scope.js at module level with a
// stubbed dsh surface: the guard's name matching (never throws, denies only
// mapped servers' out-of-allowlist leaves) and the best-effort restrict
// (deny computed from the live roster, throws swallowed to guard-only).
// The filter file is re-anchored through TOOL_FILTER_PATH so the repo's
// template dir is never written.
//
//   node --test scripts/test-tool-scope-bridge.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "tool-scope-"));
process.env.TOOL_FILTER_PATH = path.join(tmpRoot, "tool-filter.json");

const { mcpToolGuardReason, applyMcpToolRestrict, readMcpToolFilter } = await import(
  "../dsh-profile-template/platform-tool-scope.js"
);

const writeFilter = (mcpTools) =>
  writeFileSync(process.env.TOOL_FILTER_PATH, JSON.stringify({ mcpTools }));

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("absent or empty filter reads as no filtering", () => {
  rmSync(process.env.TOOL_FILTER_PATH, { force: true });
  assert.equal(readMcpToolFilter(), null);
  writeFilter({});
  assert.equal(readMcpToolFilter(), null, "empty mapping = no filtering");
  writeFileSync(process.env.TOOL_FILTER_PATH, "{ not json");
  assert.equal(readMcpToolFilter(), null, "unparsable = no filtering, never a throw");
});

test("guard denies only mapped servers' out-of-allowlist leaves", () => {
  writeFilter({ "law-bench": ["read", "search.legal"] });
  assert.equal(mcpToolGuardReason("mcp__law-bench__read"), undefined, "allowlisted leaf passes");
  assert.equal(mcpToolGuardReason("mcp__law-bench__search.legal"), undefined, "dotted leaf passes");
  const reason = mcpToolGuardReason("mcp__law-bench__delete_corpus");
  assert.match(reason, /delete_corpus/);
  assert.match(reason, /law-bench/);
  assert.match(reason, /focused mode/, "the reason explains the scope and the exit");
  // Unmapped server: full surface, never denied.
  assert.equal(mcpToolGuardReason("mcp__fetch__anything"), undefined);
  // Non-MCP tools are never denied.
  assert.equal(mcpToolGuardReason("bash"), undefined);
  assert.equal(mcpToolGuardReason("run_code"), undefined);
  // Malformed names never throw.
  assert.equal(mcpToolGuardReason("mcp__"), undefined);
  assert.equal(mcpToolGuardReason(undefined), undefined);
});

test("guard re-reads the filter per invocation (HMR window stays fresh)", () => {
  writeFilter({ "law-bench": ["read"] });
  assert.equal(mcpToolGuardReason("mcp__fetch__evil"), undefined, "fetch server unmapped yet");
  writeFilter({ "law-bench": ["read"], fetch: ["fetch_url"] });
  assert.match(mcpToolGuardReason("mcp__fetch__evil"), /evil/, "newly mapped server denies");
});

test("empty allowlist denies every tool of that server (role narrowed to zero)", () => {
  writeFilter({ "law-bench": [] });
  assert.match(mcpToolGuardReason("mcp__law-bench__read"), /outside this role's tool allowlist/);
});

function stubAgentCtx({ roster, restrictShouldThrow = false } = {}) {
  const calls = { restrict: [] };
  return {
    calls,
    logger: { warn: () => {} },
    tools: {
      schemas: () => roster.map((name) => ({ name })),
      restrict: (filter) => {
        if (restrictShouldThrow) throw new Error("unknown global tool 'mcp__law-bench__ghost'");
        calls.restrict.push(filter);
      },
    },
  };
}

test("restrict computes deny from the live roster of mapped servers", () => {
  writeFilter({ "law-bench": ["read"] });
  const ctx = stubAgentCtx({
    roster: [
      "mcp__law-bench__read",
      "mcp__law-bench__search",
      "mcp__law-bench__delete",
      "mcp__fetch__fetch_url", // unmapped server — untouched
      "bash", // non-MCP — untouched
    ],
  });
  applyMcpToolRestrict(ctx);
  assert.deepEqual(ctx.calls.restrict, [{ deny: ["mcp__law-bench__search", "mcp__law-bench__delete"] }]);
});

test("restrict throws degrade to guard-only and never break composition", () => {
  writeFilter({ "law-bench": ["read"] });
  const ctx = stubAgentCtx({
    roster: ["mcp__law-bench__search"],
    restrictShouldThrow: true, // restrict() throws (drifted roster)
  });
  assert.doesNotThrow(() => applyMcpToolRestrict(ctx));
  assert.equal(ctx.calls.restrict.length, 0);
});

test("no deny needed (roster already within allowlist) skips the restrict call", () => {
  writeFilter({ "law-bench": ["read", "search"] });
  const ctx = stubAgentCtx({ roster: ["mcp__law-bench__read"] });
  applyMcpToolRestrict(ctx);
  assert.equal(ctx.calls.restrict.length, 0, "restrict({}) would throw on the empty filter");
});

test("roster read failure degrades silently", () => {
  writeFilter({ "law-bench": ["read"] });
  const ctx = {
    logger: { warn: () => {} },
    tools: {
      schemas: () => {
        throw new Error("registry unavailable");
      },
      restrict: () => assert.fail("restrict must not run without a roster"),
    },
  };
  assert.doesNotThrow(() => applyMcpToolRestrict(ctx));
});
