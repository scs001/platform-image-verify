#!/usr/bin/env node
// ── Publish dry-run validation (creator-pack-forge-support) ──────────────────
//
// Route-level contract over a real registerPackRoutes mount:
//   - auth parity: anonymous gets the same 401 shape as the write routes
//   - envelope: { valid, errors[], caller } — eligibility is a finding, never
//     a rejection; non-creators validate freely
//   - collect-everything: one manifest violating limits + files gate + tool
//     gate returns all three items in one pass, markers (code, toolGate) kept
//   - parity corpus: every publish rejection body appears verbatim in
//     validate's errors[] (the "one collector" guarantee, exercised at HTTP)
//   - registry trouble: fail-closed verdict mirrored on both faces
//   - continuation: packId checks are read-only (not-found / foreign-author
//     wording identical to publish; no version created)
//   - side effects: repeated validation mints no pack and never exhausts the
//     publish budget; the validate limiter is its own bucket
//
//   node --test scripts/test-pack-validate.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import express from "express";
import { test, after } from "node:test";

// ── Stub registry (must be up and configured BEFORE the module import: the
// bridge reads REGISTRY_URL at module load) ─────────────────────────────────
function startStubRegistry() {
  let serversFail = false;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/servers")) {
      if (serversFail) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "boom" }));
      }
      return res.end(JSON.stringify({
        servers: [
          {
            path: "/stub-srv",
            is_enabled: true,
            tool_list: ["read", "search"],
            // Commercial closure names a tool the snapshot lacks: declaring
            // it walks the existence branch, not the commercial one.
            metadata: { surface: { commercial_tools: ["read", "ghost_tool"], tools_commercial: 2, tools_total: 2 } },
          },
        ],
      }));
    }
    if (req.url.startsWith("/stub-srv/mcp")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let method = "";
        try { method = JSON.parse(body).method; } catch { /* probe failure is a verdict too */ }
        if (method === "initialize") {
          res.setHeader("mcp-session-id", "stub-session");
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "stub-srv" } } }));
        }
        if (method === "tools/list") {
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "read" }, { name: "search" }] } }));
        }
        res.statusCode = 202;
        res.end("");
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      setServersFail: (v) => { serversFail = v; },
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

delete process.env.PACK_FILES_ENABLED;
delete process.env.PACK_VALIDATE_RATE_MAX;
delete process.env.MARKET_REGISTRY_URL;
const stub = await startStubRegistry();
process.env.REGISTRY_URL = `http://127.0.0.1:${stub.port}`;

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-validate-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
after(() => stub.close());
test.after(() => {
  delete process.env.PACK_FILES_ENABLED;
  delete process.env.PACK_VALIDATE_RATE_MAX;
});

function manifest(overrides = {}) {
  return {
    name: "法律-合同",
    description: "合同审查工作流",
    tags: ["法律"],
    skills: [{ name: "legal-contract-workflow", description: "五阶段合同审查", content: "# 合同审查\n不编造法条。" }],
    mcpServers: [{ registryName: "law-bench" }],
    agents: [{ id: "pack-contract-reviewer", name: "合同审查官", persona: "你是严谨的合同审查官。" }],
    ...overrides,
  };
}

const TREE = (name) => ({
  name,
  description: "带辅助文件",
  skills: [{ name: "tree-skill", description: "多文件技能", content: "# 正文", files: { "references/x.md": "# X\n" } }],
  mcpServers: [],
  agents: [],
});

async function boot() {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: (req) => {
      const who = req.headers["x-test-user"];
      if (!who) return null;
      const [email, groups = ""] = String(who).split("|");
      return { email, groups: groups ? groups.split(",") : [] };
    },
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: ["creators"],
    adminGroups: [],
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, init = {}) =>
    fetch(`${base}${p}`, init).then(async (r) => {
      const text = await r.text();
      let body = null;
      if (r.headers.get("content-type")?.includes("application/json")) {
        try { body = JSON.parse(text); } catch { /* keep text */ }
      }
      return { status: r.status, text, body };
    });
  const as = (who) => ({
    publish: (md, { packId } = {}) =>
      call("/api/packs", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(who ? { "x-test-user": who } : {}) },
        body: JSON.stringify({ manifest: md, ...(packId ? { packId } : {}) }),
      }),
    validate: (md, { packId } = {}) =>
      call("/api/packs/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(who ? { "x-test-user": who } : {}) },
        body: JSON.stringify({ manifest: md, ...(packId ? { packId } : {}) }),
      }),
  });
  return {
    registry,
    call,
    as,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      registry.close();
    },
  };
}

const CREATOR = "creator@example.com|creators";
const PLAIN = "user@example.com|";

// ── Registry trouble FIRST (the server index cache is cold only until some
// tool-declaring request succeeds; a failure writes no cache) ──────────────
test("registry trouble is a fail-closed verdict mirrored on both faces", async () => {
  const h = await boot();
  try {
    stub.setServersFail(true);
    const md = manifest({ mcpServers: [{ registryName: "stub-srv", allowTools: ["read"] }] });
    const p = await h.as(CREATOR).publish(md);
    const v = await h.as(CREATOR).validate(md);
    assert.equal(p.status, 503, JSON.stringify(p.body));
    assert.equal(v.status, 200);
    assert.equal(v.body.valid, false);
    assert.ok(
      v.body.errors.some((e) => JSON.stringify(e) === JSON.stringify(p.body)),
      `validate mirrors the publish 503\npublish=${JSON.stringify(p.body)}\nvalidate=${JSON.stringify(v.body.errors)}`,
    );
  } finally {
    stub.setServersFail(false);
    await h.close();
  }
});

test("anonymous callers are rejected with the write routes' auth shape", async () => {
  const h = await boot();
  try {
    const anon = h.as(null);
    const v = await anon.validate(manifest());
    const p = await anon.publish(manifest());
    assert.equal(v.status, 401);
    assert.equal(p.status, 401);
    assert.deepEqual(v.body, p.body, "validate answers the identical 401 body");
  } finally {
    await h.close();
  }
});

test("any authenticated user may validate; eligibility is a caller finding", async () => {
  const h = await boot();
  try {
    const v = await h.as(PLAIN).validate(manifest());
    assert.equal(v.status, 200);
    assert.equal(v.body.valid, true, JSON.stringify(v.body));
    assert.deepEqual(v.body.errors, []);
    assert.equal(v.body.caller.publishEligible, false);
    assert.equal(v.body.caller.reason, "Creator group required");

    // The eligibility line is real, not cosmetic: the same caller's publish
    // is refused with exactly that wording.
    const p = await h.as(PLAIN).publish(manifest());
    assert.equal(p.status, 403);
    assert.equal(p.body.error, v.body.caller.reason);

    const byCreator = await h.as(CREATOR).validate(manifest());
    assert.deepEqual(byCreator.body.caller, { publishEligible: true });
  } finally {
    await h.close();
  }
});

test("collect-everything: one request surfaces limits + files + tool failures together", async () => {
  const h = await boot();
  try {
    delete process.env.PACK_FILES_ENABLED;
    // Violates three gates at once: name over the 80-char limit (structural),
    // a files-bearing skill with the gate off, and a declared tool the stub's
    // snapshot lacks and the live probe cannot confirm either.
    const bad = manifest({
      name: "x".repeat(81),
      skills: [{ name: "tree-skill", description: "d", content: "c", files: { "a.md": "# A" } }],
      mcpServers: [{ registryName: "stub-srv", allowTools: ["ghost_tool"] }],
      agents: [],
    });
    const v = await h.as(CREATOR).validate(bad);
    assert.equal(v.status, 200);
    assert.equal(v.body.valid, false);
    assert.equal(v.body.errors.length, 3, JSON.stringify(v.body.errors));
    // Structural first (publish's own order), marker-bearing items intact.
    assert.equal(v.body.errors[0].error, "Invalid manifest");
    assert.ok(v.body.errors.some((e) => e.code === "pack-files-disabled"), "files marker kept");
    const toolItem = v.body.errors.find((e) => e.toolGate === true);
    assert.ok(toolItem, "toolGate marker kept");
    assert.match(toolItem.errors[0].error, /ghost_tool/);

    // Publish on the same manifest reports exactly the FIRST item.
    const p = await h.as(CREATOR).publish(bad);
    assert.equal(p.status, 400);
    assert.deepEqual(p.body, v.body.errors[0], "publish body === validate's first item");
  } finally {
    await h.close();
  }
});

test("parity corpus: every publish rejection body appears verbatim in validate errors", async () => {
  const h = await boot();
  try {
    delete process.env.PACK_FILES_ENABLED;
    const corpus = [
      { label: "structural: mcp entry carries a url", md: manifest({ mcpServers: [{ registryName: "x", url: "https://evil.example" }] }) },
      { label: "structural: persona-only violated", md: manifest({ agents: [{ id: "x", name: "X", persona: "p", model: "m" }] }) },
      { label: "structural: name over limit", md: manifest({ name: "x".repeat(81) }) },
      { label: "structural: bad visibility", md: manifest({ visibility: "hidden" }) },
      { label: "tool gate: ghost tool fails both snapshot and probe", md: manifest({ mcpServers: [{ registryName: "stub-srv", allowTools: ["ghost_tool"] }] }) },
      { label: "tool gate: tool outside the commercial set", md: manifest({ mcpServers: [{ registryName: "stub-srv", allowTools: ["search"] }] }) },
    ];
    for (const { label, md } of corpus) {
      const p = await h.as(CREATOR).publish(md);
      const v = await h.as(CREATOR).validate(md);
      assert.equal(v.status, 200, label);
      assert.equal(v.body.valid, false, label);
      assert.ok(
        v.body.errors.some((e) => JSON.stringify(e) === JSON.stringify(p.body)),
        `${label}: publish body must appear verbatim in validate errors\npublish=${JSON.stringify(p.body)}\nvalidate=${JSON.stringify(v.body.errors)}`,
      );
    }

    // Files gate (per-request env read on both sides).
    const tree = TREE("被门挡的包");
    const pF = await h.as(CREATOR).publish(tree);
    const vF = await h.as(CREATOR).validate(tree);
    assert.equal(pF.status, 400);
    assert.equal(pF.body.code, "pack-files-disabled");
    assert.ok(vF.body.errors.some((e) => JSON.stringify(e) === JSON.stringify(pF.body)), "files gate body parity");

    // Missing manifest: publish answers { error: "manifest required" }.
    const pM = await h.as(CREATOR).publish(undefined);
    const vM = await h.call("/api/packs/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": CREATOR },
      body: JSON.stringify({}),
    });
    assert.equal(pM.status, 400);
    assert.ok(vM.body.errors.some((e) => JSON.stringify(e) === JSON.stringify(pM.body)), "manifest-required parity");
  } finally {
    await h.close();
  }
});

test("continuation targets are checked read-only with publish wording", async () => {
  const h = await boot();
  try {
    const author = "forge-author@example.com|creators";
    const other = "forge-other@example.com|creators";
    const { body: created } = await h.as(author).publish(manifest({ name: "续版母包" }));
    const packId = created.id;

    // Nonexistent target.
    const ghost = await h.as(author).validate(manifest(), { packId: "no-such-pack" });
    assert.equal(ghost.status, 200);
    assert.ok(ghost.body.errors.some((e) => e.error === "Pack not found"));

    // Foreign author: validate says it, and publish's 403 says the same words.
    const foreign = await h.as(other).validate(manifest(), { packId });
    assert.equal(foreign.status, 200);
    assert.ok(foreign.body.errors.some((e) => e.error === "Only the pack author may publish new versions"));
    const foreignP = await h.as(other).publish(manifest(), { packId });
    assert.equal(foreignP.status, 403);
    assert.equal(foreignP.body.error, "Only the pack author may publish new versions");

    // The author's own continuation validates clean, and validate minted no
    // version while doing it.
    const ok = await h.as(author).validate(manifest({ name: "续版母包" }), { packId });
    assert.equal(ok.body.valid, true, JSON.stringify(ok.body));
    const versions = h.registry.versions(packId);
    assert.ok(Array.isArray(versions), JSON.stringify(versions));
    assert.equal(versions.filter((v) => v.version > 1).length, 0, "no version created by validate");
  } finally {
    await h.close();
  }
});

test("repeated validation is side-effect free and never exhausts the publish budget", async () => {
  const h = await boot();
  try {
    const author = "forge-budget@example.com|creators";
    const md = manifest({ name: "预算包" });
    for (let i = 0; i < 15; i++) {
      const v = await h.as(author).validate(md);
      assert.equal(v.body.valid, true, `iteration ${i}: ${JSON.stringify(v.body)}`);
    }
    assert.equal(h.registry.list({}).total, 0, "no pack minted by 15 validations");

    // The publish budget is intact: ten publishes still succeed, the 11th is
    // throttled — exactly the default budget, untouched by the dry-runs.
    for (let i = 0; i < 10; i++) {
      const p = await h.as(author).publish(manifest({ name: `预算包 ${i}` }));
      assert.equal(p.status, 200, `publish ${i}: ${JSON.stringify(p.body)}`);
    }
    assert.equal((await h.as(author).publish(manifest({ name: "超预算" }))).status, 429);
  } finally {
    await h.close();
  }
});

test("validate has its own limiter, env-tunable, independent of publish", async () => {
  process.env.PACK_VALIDATE_RATE_MAX = "2";
  const h = await boot(); // env is read when the routes register
  try {
    const author = "forge-val-rate@example.com|creators";
    assert.equal((await h.as(author).validate(manifest())).status, 200);
    assert.equal((await h.as(author).validate(manifest())).status, 200);
    const third = await h.as(author).validate(manifest());
    assert.equal(third.status, 429);
    assert.match(third.body.error, /validation/i);

    // The publish face for this author is unaffected by the validate bucket.
    assert.equal((await h.as(author).publish(manifest())).status, 200);
  } finally {
    delete process.env.PACK_VALIDATE_RATE_MAX;
    await h.close();
  }
});
