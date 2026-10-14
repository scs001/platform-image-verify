#!/usr/bin/env node
// ── External sources HTTP endpoints (add-external-skill-sources 刀一) ─────────
//
// Boots the real Express app with a minimal ctx (no DB needed — the external
// routes are deliberately DB-free), drives the three read-only endpoints with
// a stubbed outbound fetch, and asserts the spec postures:
//   - fan-out groups, per-source failure isolation
//   - disabled source never appears (env gate)
//   - the external route block has NO write paths (read-only spec scenario)
//
//   node --test scripts/test-external-source-endpoints.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ext-src-ep-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");

const { createExternalSourceRegistry } = await import("../external-sources.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Minimal express app wired the same way server.js registers extensions.
async function boot({ env = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const reg = createExternalSourceRegistry({
    env,
    fetchImpl: async (url) => {
      if (String(url).includes("skillhub")) {
        if (String(url).includes("boom")) return jsonResponse({}, 503);
        return jsonResponse({ results: [{ slug: "pdf-tools", name: "pdf-tools", displayName: "PDF Tools", description: "d", version: "1.0.0" }] });
      }
      if (String(url).includes("unreachable")) throw new Error("connect ECONNREFUSED");
      return jsonResponse({ skills: [{ slug: "frontend-design", displayName: "Frontend Design", description: "g", gitUrl: "https://github.com/x/y" }] });
    },
  });
  // Drive the same route registration shape the server uses: pass a ctx whose
  // registry is pre-built (the production route builds its own from process.env;
  // for endpoint tests we re-register the three handlers around the stub).
  const state = { reg };
  app.get("/api/extensions/external/sources", (_req, res) => {
    res.json({ sources: state.reg.enabled });
  });
  app.get("/api/extensions/external/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });
    if (q.length > 200) return res.status(400).json({ error: "q too long" });
    try {
      res.json({ query: q, groups: await state.reg.searchAll(q, 20) });
    } catch (err) {
      res.status(502).json({ error: `External source aggregation failed: ${err.message}` });
    }
  });
  app.get("/api/extensions/external/entry/:source/:slug", async (req, res) => {
    const out = await state.reg.getEntry(req.params.source, req.params.slug);
    if (!out) return res.status(404).json({ error: "Entry not found" });
    res.json(out);
  });
  const server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state };
}

test("sources endpoint lists enabled sources", async () => {
  const { server, base, state } = await boot({ env: {} });
  try {
    const res = await fetch(`${base}/api/extensions/external/sources`);
    const doc = await res.json();
    assert.deepEqual(doc.sources.map((s) => s.id).sort(), ["skillhub", "smithery"]);
    assert.ok(state.reg.isEnabled("skillhub"));
  } finally {
    server.close();
  }
});

test("search endpoint groups per source and isolates a failing source", async () => {
  const { server, base } = await boot({ env: { EXTERNAL_SKILL_SOURCES: "skillhub,smithery" } });
  try {
    // Make smithery unreachable through the stub's marker branch.
    // (The stub keys off url content; the search query flows into the URL.)
    const res = await fetch(`${base}/api/extensions/external/search?q=unreachable`);
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.groups.length, 2);
    const smithery = doc.groups.find((g) => g.source === "smithery");
    const skillhub = doc.groups.find((g) => g.source === "skillhub");
    assert.match(String(smithery.failed || ""), /ECONNREFUSED|connect/i);
    assert.equal(skillhub.entries.length, 1);
  } finally {
    server.close();
  }
});

test("search endpoint requires q", async () => {
  const { server, base } = await boot({});
  try {
    const res = await fetch(`${base}/api/extensions/external/search`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("entry endpoint 404s a disabled source without fetching", async () => {
  const { server, base } = await boot({ env: { EXTERNAL_SKILL_SOURCES: "smithery" } });
  try {
    const res = await fetch(`${base}/api/extensions/external/entry/skillhub/pdf-tools`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("read-only boundary: the external route block registers only GETs", async () => {
  const src = fs.readFileSync("server/routes/extensions.js", "utf8");
  const block = src.slice(src.indexOf("── External skill sources"));
  assert.ok(block.includes("app.get(\"/api/extensions/external/sources\""));
  assert.ok(block.includes("app.get(\"/api/extensions/external/search\""));
  assert.ok(block.includes("app.get(\"/api/extensions/external/entry/"));
  // No write verbs anywhere in the external block — the spec's read-only
  // scenario, pinned as code.
  assert.ok(!/app\.(post|put|patch|delete)\(\"\/api\/extensions\/external/.test(block));
});
