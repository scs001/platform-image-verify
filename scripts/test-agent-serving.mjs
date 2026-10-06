#!/usr/bin/env node
// ── Agent serving tests (add-a2a-agent-serving, tasks 2.1–2.2, 3.x) ─────────
//
// Module-level tests for the serving contract: manifest v2 validation rules,
// flow-through (draft → install snapshot keeps serving; contract-free packs
// validate under v1 rules verbatim), and the registry deploy client against
// an in-process stub. The live registry and the runner's dsh children are
// covered by e2e/probe scripts, not here.
//
//   node --test scripts/test-agent-serving.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Set the isolation env BEFORE importing anything that resolves paths/db.
const tmpRoot = mkdtempSync(path.join(tmpdir(), "agent-serving-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const packStore = await import("../pack-store.js");
const { validatePackManifest } = await import("../lib/pack-manifest.js");
const servingLib = await import("../lib/agent-serving.js");

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const BASE = {
  name: "金融-分析",
  description: "财务分析工作流",
  tags: ["金融"],
  skills: [
    { name: "fin-statement-analysis", description: "财报分析", content: "# v1\n逐步分析。" },
  ],
  mcpServers: [{ registryName: "fd-open-data-mcp" }],
  agents: [
    { id: "pack-fingpt", name: "FingPt 分析师", persona: "你是严谨的金融分析师。" },
  ],
};

const withServing = (serving) => ({
  ...BASE,
  agents: [{ ...BASE.agents[0], serving }],
});

// ── Task 2.1: serving block validation ──────────────────────────────────────

test("2.1 contract-free manifests validate under v1 rules verbatim", () => {
  assert.deepEqual(validatePackManifest(BASE), []);
});

test("2.1 minimal contract validates (protocol only; card derived at deploy)", () => {
  assert.deepEqual(validatePackManifest(withServing({ protocol: "a2a" })), []);
});

test("2.1 full manual card validates", () => {
  const errs = validatePackManifest(
    withServing({
      protocol: "a2a",
      card: {
        name: "FingPt Analyst",
        description: "Financial statement analysis over A2A",
        capabilities: { streaming: true, pushNotifications: false },
        skills: [{ id: "statement-analysis", name: "财报分析", description: "解读三大报表", tags: ["finance"] }],
      },
    }),
  );
  assert.deepEqual(errs, []);
});

test("2.1 wrong or missing protocol is rejected", () => {
  for (const protocol of ["acp", "a2a@1", "", undefined, 42]) {
    const errs = validatePackManifest(withServing({ protocol }));
    assert.ok(
      errs.some((e) => /serving\.protocol must be "a2a"/.test(e.error)),
      `protocol ${JSON.stringify(protocol)} should be rejected`,
    );
  }
});

test("2.1 contract cannot smuggle runtime configuration", () => {
  for (const key of ["url", "baseUrl", "endpoint", "model", "apiKey", "apiKeyEnv", "token", "credentials", "auth"]) {
    const errs = validatePackManifest(withServing({ protocol: "a2a", [key]: "x" }));
    assert.ok(
      errs.some((e) => e.error.includes(key) && /forbidden key/.test(e.error)),
      `serving.${key} should be rejected as forbidden`,
    );
  }
  const cardErrs = validatePackManifest(
    withServing({ protocol: "a2a", card: { name: "n", model: "gpt-4" } }),
  );
  assert.ok(cardErrs.some((e) => /serving\.card may not carry runtime configuration/.test(e.error)));
});

test("2.1 unknown keys in serving/card/capability are rejected", () => {
  assert.ok(
    validatePackManifest(withServing({ protocol: "a2a", extra: 1 })).some((e) => /unknown key 'extra'/.test(e.error)),
  );
  assert.ok(
    validatePackManifest(withServing({ protocol: "a2a", card: { icon: "x" } })).some((e) => /unknown key 'icon'/.test(e.error)),
  );
  assert.ok(
    validatePackManifest(withServing({ protocol: "a2a", card: { skills: [{ id: "s", name: "S", url: "http://x" }] } }))
      .some((e) => /unknown key 'url'/.test(e.error)),
  );
});

test("2.1 card capability declarations are shape-checked", () => {
  const errs = validatePackManifest(
    withServing({
      protocol: "a2a",
      card: {
        capabilities: { streaming: "yes" },
        skills: [{ id: "bad id!", name: "" }, "not-an-object", { name: "no-id" }],
      },
    }),
  );
  assert.ok(errs.some((e) => /capabilities 'streaming' must map to a boolean/.test(e.error)));
  assert.ok(errs.some((e) => /capability id must match/.test(e.error)));
  assert.ok(errs.some((e) => /capability name must be/.test(e.error)));
  assert.ok(errs.some((e) => /capability declaration must be an object/.test(e.error)));
  assert.ok(
    errs.some((e) => /capability id must match/.test(e.error) && e.entry === "agents[0].serving.card.skills[2]"),
    "the third declaration ({name:'no-id'}) should be named by position",
  );
});

test("2.1 card.skills never cross-reference the pack's skill files", () => {
  // A capability id that happens to equal a pack skill name is legal (they are
  // different namespaces); one that references nothing also is. Neither path
  // consults manifest.skills.
  const errs = validatePackManifest(
    withServing({
      protocol: "a2a",
      card: { skills: [{ id: "fin-statement-analysis", name: "same word" }, { id: "unrelated-capability", name: "other meaning" }] },
    }),
  );
  assert.deepEqual(errs, []);
});

// ── Task 2.2: flow-through (draft → install keeps serving; v1 untouched) ────

test("2.2 install snapshots a serving manifest verbatim and reports the agent", async () => {
  const manifest = withServing({
    protocol: "a2a",
    card: { name: "FingPt Analyst", capabilities: { streaming: true } },
  });
  const { report } = await packStore.installPack({ packId: "pk-srv-1", version: 1, manifest, user: { email: "u@x" } });
  assert.equal(report.agents[0].status, "installed");
  const row = db.getDb().prepare("SELECT manifest FROM installed_packs WHERE pack_id = ?").get("pk-srv-1");
  const stored = JSON.parse(row.manifest);
  assert.equal(stored.agents[0].serving.protocol, "a2a", "serving must survive the install snapshot");
  assert.equal(stored.agents[0].serving.card.capabilities.streaming, true);
});

test("2.2 a contract-free pack installs exactly as before", async () => {
  // Distinct agent id: pk-srv-1 already owns "pack-fingpt" (cross-pack id
  // conflicts skip by design — same rule as test-pack-cell).
  const manifest = { ...BASE, agents: [{ ...BASE.agents[0], id: "pack-fingpt-2" }] };
  const { report } = await packStore.installPack({ packId: "pk-srv-2", version: 1, manifest, user: { email: "u@x" } });
  assert.equal(report.agents[0].status, "installed");
  const row = db.getDb().prepare("SELECT manifest FROM installed_packs WHERE pack_id = ?").get("pk-srv-2");
  assert.equal(JSON.parse(row.manifest).agents[0].serving, undefined);
});

test("2.2 invalid serving blocks install with status 400", async () => {
  await assert.rejects(
    packStore.installPack({
      packId: "pk-srv-3",
      version: 1,
      manifest: withServing({ protocol: "nope" }),
      user: { email: "u@x" },
    }),
    (err) => err.status === 400 && err.details.some((d) => /serving\.protocol/.test(d.error)),
  );
});

// ── Task 3.1: registry deploy client against an in-process stub ─────────────

function stubRegistry() {
  const calls = { skills: [], agents: [] };
  const skills = new Map();
  const agents = new Map();
  return {
    calls,
    async fetch(rawUrl, init = {}) {
      const url = String(rawUrl).split("?")[0];
      const body = init.body ? JSON.parse(init.body) : null;
      let m = url.match(/^\/api\/skills\/(.+)$/);
      if (m && init.method === "PUT") {
        calls.skills.push({ path: m[1], body });
        // Stored keyed by NAME with the /skills/ prefixed path — the shape the
        // registry actually keeps (live finding), which the name lookup reads.
        skills.set(body.name, { ...body, path: `/skills/${body.name}` });
        return { ok: true, status: 200, json: async () => ({ path: `/skills/${body.name}`, ...body }) };
      }
      if (url.startsWith("/api/skills/") && !init.method) {
        const name = url.split("/").pop();
        if (skills.has(name)) return { ok: true, status: 200, json: async () => ({ path: "/skills/" + name }) };
        return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
      }
      if (url === "/api/skills" && init.method === "POST") {
        calls.skills.push({ path: body.path, body });
        skills.set(body.name, { ...body, path: `/skills/${body.name}` });
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      m = url.match(/^\/api\/agents\/(.+)\/toggle$/);
      if (m && init.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ message: "Agent enabled successfully", path: m[1], is_enabled: true }) };
      }
      m = url.match(/^\/api\/agents\/(.+)$/);
      if (m && !init.method) {
        if (agents.has(m[1])) return { ok: true, status: 200, json: async () => agents.get(m[1]) };
        return { ok: false, status: 404, json: async () => ({ detail: "not found" }) };
      }
      if (m && (init.method === "PUT" || init.method === "POST")) {
        calls.agents.push({ path: m[1], body });
        agents.set(m[1], body);
        return { ok: true, status: 200, json: async () => ({ path: m[1], ...body }) };
      }
      if (url === "/api/agents/register" && init.method === "POST") {
        calls.agents.push({ path: body.path, body });
        agents.set(body.path, body);
        return { ok: true, status: 201, json: async () => ({ path: body.path, ...body }) };
      }
      return { ok: false, status: 404, json: async () => ({ detail: `no stub route for ${init.method} ${url}` }) };
    },
  };
}

const PACK = {
  packId: "pk-abc",
  version: 3,
  runnerBaseUrl: "http://runner.tailnet",
  packsPublicBase: "https://packs.example.test",
  registryUrl: "https://mcp.example.test",
  manifest: withServing({
    protocol: "a2a",
    card: { name: "FingPt Analyst", capabilities: { streaming: true } },
  }),
};

test("3.1 deploy registers skills + one a2a agent with a small descriptor", async () => {
  const stub = stubRegistry();
  const out = await servingLib.deployToRegistry({ ...PACK, fetchImpl: stub.fetch });
  // Skills pushed once each under the pack-scoped path, gated.
  assert.equal(stub.calls.skills.length, 1);
  assert.equal(stub.calls.skills[0].path, "packs/pk-abc/fin-statement-analysis");
  assert.equal(stub.calls.skills[0].body.skill_md_content, PACK.manifest.skills[0].content);
  assert.equal(
    stub.calls.skills[0].body.skill_md_url,
    "https://packs.example.test/api/packs/pk-abc/versions/3/skills/fin-statement-analysis.md",
  );
  assert.equal(stub.calls.skills[0].body.visibility, "group");
  // Exactly one agent entry, a2a, backend = runner, small metadata descriptor.
  assert.equal(stub.calls.agents.length, 1);
  const agent = stub.calls.agents[0].body;
  assert.equal(agent.supported_protocol, "a2a");
  const { agentPortFor } = servingLib;
  assert.equal(agent.url, `http://runner.tailnet:${agentPortFor("/packs/pk-abc/pack-fingpt")}`, "origin + deterministic per-agent port");
  assert.equal(agent.metadata.protocol, "a2a");
  assert.equal(agent.metadata.packId, "pk-abc");
  assert.equal(agent.metadata.packVersion, 3);
  assert.deepEqual(agent.metadata.skills, ["packs/pk-abc/fin-statement-analysis"]);
  assert.deepEqual(agent.metadata.mcpServers, ["fd-open-data-mcp"]);
  assert.equal(agent.metadata.persona, PACK.manifest.agents[0].persona);
  // No full manifest or skill bodies in the entry.
  const serialized = JSON.stringify(agent);
  assert.ok(!serialized.includes("skill_md_content"), "skill bodies must not ride in the agent entry");
  assert.ok(serialized.length < 25_000, `descriptor must stay small (${serialized.length} chars)`);
  assert.ok(out.agentPath);
});

test("3.1 card composition: manual fields override, absent fields derive", async () => {
  const stub = stubRegistry();
  await servingLib.deployToRegistry({ ...PACK, fetchImpl: stub.fetch });
  const agent = stub.calls.agents[0].body;
  assert.equal(agent.name, "FingPt Analyst", "manual card name wins");
  assert.equal(agent.capabilities.streaming, true);

  const stub2 = stubRegistry();
  const noCard = { ...PACK, manifest: withServing({ protocol: "a2a" }) };
  await servingLib.deployToRegistry({ ...noCard, fetchImpl: stub2.fetch });
  const derived = stub2.calls.agents[0].body;
  assert.equal(derived.name, "FingPt 分析师", "derived from the agent's display name");
  assert.ok(derived.description.includes("金融"), "derived description references the pack");
  assert.deepEqual(derived.tags, ["金融"]);
  assert.equal(derived.capabilities.streaming, true, "adapter always streams in v1");
});

test("3.1 deploy is idempotent per (pack version, agent id)", async () => {
  const stub = stubRegistry();
  await servingLib.deployToRegistry({ ...PACK, fetchImpl: stub.fetch });
  await servingLib.deployToRegistry({ ...PACK, fetchImpl: stub.fetch });
  assert.equal(stub.calls.agents.length, 2, "second run PUTs the same path (update), not a duplicate register");
  assert.equal(stub.calls.agents[0].path, stub.calls.agents[1].path);
  assert.equal(new Set(stub.calls.agents.map((c) => c.path)).size, 1);
  // Skills are keyed by name registry-wide: the second deploy PUTs the STORED
  // path (name-resolved), never a fresh POST that would hit the name conflict.
  assert.equal(stub.calls.skills[1]?.path, "fin-statement-analysis", "v2 PUT targets the stored path");
});

test("3.1 refuses to deploy a contract-less pack", async () => {
  const stub = stubRegistry();
  await assert.rejects(
    servingLib.deployToRegistry({ ...PACK, manifest: BASE, fetchImpl: stub.fetch }),
    (err) => /serving contract/i.test(err.message) && /pack-fingpt/.test(err.message),
  );
  assert.equal(stub.calls.agents.length, 0);
});

test("3.1 descriptor uses only the role's declared resources", async () => {
  const stub = stubRegistry();
  const manifest = {
    ...BASE,
    skills: [
      BASE.skills[0],
      { name: "fin-risk-model", description: "风险模型", content: "# v1\n建模。" },
    ],
    agents: [
      {
        ...BASE.agents[0],
        serving: { protocol: "a2a" },
        resources: { skills: ["fin-statement-analysis"] },
      },
    ],
  };
  await servingLib.deployToRegistry({ ...PACK, manifest, fetchImpl: stub.fetch });
  const agent = stub.calls.agents[0].body;
  assert.deepEqual(agent.metadata.skills, ["packs/pk-abc/fin-statement-analysis"], "only the declared subset");
});

// ── add-serving-budgets 1.1: budget validation ──────────────────────────────

test("budget: a positive whole number within the cap validates", () => {
  for (const turnMinutes of [1, 20, 120]) {
    assert.deepEqual(validatePackManifest(withServing({ protocol: "a2a", budget: { turnMinutes } })), []);
  }
  // Budget alongside card/rhythm — the contract keys coexist.
  assert.deepEqual(
    validatePackManifest(withServing({ protocol: "a2a", rhythm: [{ every: "1h" }], budget: { turnMinutes: 10 } })),
    [],
  );
});

test("budget: non-duration shapes are rejected naming the offending value", () => {
  for (const turnMinutes of [0, -5, 1.5, 121, "10", null, undefined, true]) {
    const errs = validatePackManifest(withServing({ protocol: "a2a", budget: { turnMinutes } }));
    assert.ok(
      errs.some((e) => /budget\.turnMinutes must be a positive whole number of minutes at most 120/.test(e.error)),
      `turnMinutes ${JSON.stringify(turnMinutes)} should be rejected`,
    );
  }
});

test("budget: unknown keys and non-object shapes are rejected", () => {
  for (const budget of [5, "10m", [], null]) {
    const errs = validatePackManifest(withServing({ protocol: "a2a", budget }));
    assert.ok(errs.some((e) => /budget must be an object of \{ turnMinutes \}/.test(e.error)), `budget ${JSON.stringify(budget)} should be rejected`);
  }
  // Extra keys — a duration declaration may not smuggle anything alongside
  // (model/endpoint/credential shapes die on this rule too).
  const extra = validatePackManifest(withServing({ protocol: "a2a", budget: { turnMinutes: 10, model: "gpt-4", minutes: 5 } }));
  assert.ok(extra.some((e) => /budget has unknown key 'model'/.test(e.error) && e.entry === "agents[0].serving.budget"));
  assert.ok(extra.some((e) => /budget has unknown key 'minutes'/.test(e.error)));
  // An empty budget declares nothing — rejected, not defaulted silently.
  const empty = validatePackManifest(withServing({ protocol: "a2a", budget: {} }));
  assert.ok(empty.some((e) => /budget\.turnMinutes must be a positive whole number/.test(e.error)));
});

test("budget: absent budget leaves the contract exactly as before", () => {
  // No budget key — the pre-budget contract validates verbatim (compat).
  assert.deepEqual(validatePackManifest(withServing({ protocol: "a2a", rhythm: [{ daily: "09:30" }] })), []);
  assert.deepEqual(validatePackManifest(withServing({ protocol: "a2a" })), []);
});

// ── Tasks 3.2/3.3: deploy routes on the pack gateway ────────────────────────

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");
const express = (await import("express")).default;
const http = (await import("node:http")).default;

async function routeHarness({ user, deployConfig, manifest }) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => user,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth required" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig,
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    registry,
    packId: id,
    close: () => new Promise((r) => server.close(r)),
    call: (method, p, body) =>
      fetch(base + p, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })),
  };
}

test("3.2/3.3 author deploys a version; bookkeeping records; idempotent redeploy", async () => {
  const stub = stubRegistry();
  const manifest = withServing({ protocol: "a2a", card: { name: "FingPt Analyst" } });
  const h = await routeHarness({
    user: { email: "author@x", groups: [] },
    deployConfig: { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch },
    manifest,
  });
  try {
    const first = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    assert.equal(first.status, 200);
    assert.equal(first.body.deployed.length, 1);
    assert.equal(first.body.deployed[0].agentId, "pack-fingpt");
    assert.equal(first.body.effectiveWithinSecs, 300);

    const again = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    assert.equal(again.status, 200);
    assert.equal(new Set(stub.calls.agents.map((c) => c.path)).size, 1, "same agent path upserted, no duplicate entry");

    const list = await h.call("GET", `/api/packs/${h.packId}/deployments`);
    assert.equal(list.status, 200);
    assert.equal(list.body.deployments.length, 1);
    assert.equal(list.body.deployments[0].agentId, "pack-fingpt");
    assert.equal(list.body.deployments[0].version, 1);
    assert.deepEqual(list.body.deployments[0].skills, ["packs/" + h.packId + "/fin-statement-analysis"]);
  } finally {
    await h.close();
  }
});

test("3.2 non-author non-creator is refused; creator may deploy", async () => {
  const stub = stubRegistry();
  const manifest = withServing({ protocol: "a2a" });
  const h = await routeHarness({
    user: { email: "stranger@x", groups: [] },
    deployConfig: { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch },
    manifest,
  });
  try {
    const refused = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    assert.equal(refused.status, 403);
    assert.equal(stub.calls.agents.length, 0);
  } finally {
    await h.close();
  }
  const h2 = await routeHarness({
    user: { email: "stranger@x", groups: ["creators"] },
    deployConfig: { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch },
    manifest,
  });
  try {
    const ok = await h2.call("POST", `/api/packs/${h2.packId}/versions/1/deploy`);
    assert.equal(ok.status, 200, "creator-group member may deploy a foreign pack");
  } finally {
    await h2.close();
  }
});

test("3.2 missing runner wiring answers 503, not silent success", async () => {
  const manifest = withServing({ protocol: "a2a" });
  const h = await routeHarness({ user: { email: "author@x", groups: [] }, deployConfig: {}, manifest });
  try {
    const res = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /AGENT_SERVING_RUNNER_URL/);
  } finally {
    await h.close();
  }
});

test("3.3 unpublish warns about deployments and does not cascade", async () => {
  const stub = stubRegistry();
  const manifest = withServing({ protocol: "a2a" });
  const h = await routeHarness({
    user: { email: "author@x", groups: [] },
    deployConfig: { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch },
    manifest,
  });
  try {
    await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    const agentsBefore = stub.calls.agents.length;
    const un = await h.call("POST", `/api/packs/${h.packId}/unpublish`);
    assert.equal(un.status, 200);
    assert.equal(un.body.deployments.length, 1, "unpublish response names the deployed service so the UI can warn");
    assert.equal(un.body.deployments[0].agentId, "pack-fingpt");
    assert.equal(stub.calls.agents.length, agentsBefore, "unpublish never touches the registry entry");
    // The deployment bookkeeping survives unpublish (undeploy is independent).
    const list = await h.call("GET", `/api/packs/${h.packId}/deployments`);
    assert.equal(list.body.deployments.length, 1);
  } finally {
    await h.close();
  }
});

// ── add-agent-residency: effective rhythm + pause writes ─────────────────────

test("rhythm override lands in the descriptor; absent override carries the manifest default", async () => {
  const manifest = withServing({ protocol: "a2a", rhythm: [{ every: "1h" }] });
  const base = { packId: "pk-abc", version: 3, runnerBaseUrl: "http://runner.tailnet", packsPublicBase: "https://packs.example.test", registryUrl: "https://mcp.example.test", manifest };
  const def = stubRegistry();
  await servingLib.deployToRegistry({ ...base, fetchImpl: def.fetch });
  assert.deepEqual(def.calls.agents[0].body.metadata.effective_rhythm, [{ every: "1h" }]);

  const over = stubRegistry();
  await servingLib.deployToRegistry({
    ...base,
    rhythmOverrides: { "pack-fingpt": [{ daily: "09:30", do: "开市巡检" }] },
    fetchImpl: over.fetch,
  });
  assert.deepEqual(over.calls.agents[0].body.metadata.effective_rhythm, [{ daily: "09:30", do: "开市巡检" }]);

  // null = explicit clear: no effective rhythm at all, manifest default ignored.
  const cleared = stubRegistry();
  await servingLib.deployToRegistry({ ...base, rhythmOverrides: { "pack-fingpt": null }, fetchImpl: cleared.fetch });
  assert.equal(cleared.calls.agents[0].body.metadata.effective_rhythm, undefined);
});

// ── add-serving-budgets 1.2: effective budget in the descriptor ─────────────

test("budget: override wins, then declaration, then the field is absent", async () => {
  const base = { packId: "pk-abc", version: 3, runnerBaseUrl: "http://runner.tailnet", packsPublicBase: "https://packs.example.test", registryUrl: "https://mcp.example.test" };

  // Declared only: the contract's ceiling rides the descriptor.
  const declared = stubRegistry();
  await servingLib.deployToRegistry({ ...base, manifest: withServing({ protocol: "a2a", budget: { turnMinutes: 20 } }), fetchImpl: declared.fetch });
  assert.equal(declared.calls.agents[0].body.metadata.effective_budget_minutes, 20);

  // Deployer override wins over the declaration.
  const over = stubRegistry();
  await servingLib.deployToRegistry({ ...base, manifest: withServing({ protocol: "a2a", budget: { turnMinutes: 20 } }), budgetOverrides: { "pack-fingpt": 5 }, fetchImpl: over.fetch });
  assert.equal(over.calls.agents[0].body.metadata.effective_budget_minutes, 5);

  // null clears the override back to the contract's declaration.
  const cleared = stubRegistry();
  await servingLib.deployToRegistry({ ...base, manifest: withServing({ protocol: "a2a", budget: { turnMinutes: 20 } }), budgetOverrides: { "pack-fingpt": null }, fetchImpl: cleared.fetch });
  assert.equal(cleared.calls.agents[0].body.metadata.effective_budget_minutes, 20);

  // Neither declaration nor override: no budget field (runner default applies).
  const none = stubRegistry();
  await servingLib.deployToRegistry({ ...base, manifest: withServing({ protocol: "a2a" }), fetchImpl: none.fetch });
  assert.equal(none.calls.agents[0].body.metadata.effective_budget_minutes, undefined);
});

test("budget: the deploy route validates the override; the descriptor carries it", async () => {
  const stub = stubRegistry();
  const manifest = withServing({ protocol: "a2a", budget: { turnMinutes: 10 } });
  const h = await routeHarness({
    user: { email: "author@x", groups: [] },
    deployConfig: { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch },
    manifest,
  });
  try {
    for (const budgets of [[10], { "pack-fingpt": 0 }, { "pack-fingpt": 1.5 }, { "pack-fingpt": 121 }, { "pack-fingpt": "10" }]) {
      const bad = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { budgets });
      assert.equal(bad.status, 400, `budgets ${JSON.stringify(budgets)} must be rejected`);
    }
    assert.equal(stub.calls.agents.length, 0, "no registry write on a refused override");

    const ok = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { budgets: { "pack-fingpt": 30 } });
    assert.equal(ok.status, 200);
    assert.equal(stub.calls.agents.at(-1).body.metadata.effective_budget_minutes, 30);

    // null on the wire: clear back to the contract's declaration.
    const clear = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { budgets: { "pack-fingpt": null } });
    assert.equal(clear.status, 200);
    assert.equal(stub.calls.agents.at(-1).body.metadata.effective_budget_minutes, 10);
  } finally {
    await h.close();
  }
});

// ── add-agent-notifications 1.1: notification channel binding ────────────────

test("notify: explicit channel binds; null unbinds; omitted keeps the live binding", async () => {
  const base = { packId: "pk-abc", version: 3, runnerBaseUrl: "http://runner.tailnet", packsPublicBase: "https://packs.example.test", registryUrl: "https://mcp.example.test" };
  const manifest = withServing({ protocol: "a2a" });

  // Explicit string: the descriptor carries the channel name.
  const bound = stubRegistry();
  await servingLib.deployToRegistry({ ...base, manifest, notifyChannels: { "pack-fingpt": "ops-feishu" }, fetchImpl: bound.fetch });
  assert.equal(bound.calls.agents.at(-1).body.metadata.notify_channel, "ops-feishu");

  // Fresh deploy with the agent omitted: nothing live to keep → unbound.
  const fresh = stubRegistry();
  await servingLib.deployToRegistry({ ...base, manifest, notifyChannels: {}, fetchImpl: fresh.fetch });
  assert.equal(fresh.calls.agents.at(-1).body.metadata.notify_channel, undefined);

  // Omitted against a registry where the entry already carries a binding:
  // kept — the live entry is the descriptor-is-the-binding's-only-store.
  await servingLib.deployToRegistry({ ...base, manifest, notifyChannels: {}, fetchImpl: bound.fetch });
  assert.equal(bound.calls.agents.at(-1).body.metadata.notify_channel, "ops-feishu");

  // Explicit null: unbinds even though the live entry carries one.
  await servingLib.deployToRegistry({ ...base, manifest, notifyChannels: { "pack-fingpt": null }, fetchImpl: bound.fetch });
  assert.equal(bound.calls.agents.at(-1).body.metadata.notify_channel, undefined);
});

test("notify: the deploy route validates the binding shape; the descriptor carries it", async () => {
  const stub = stubRegistry();
  const manifest = withServing({ protocol: "a2a" });
  const h = await routeHarness({
    user: { email: "author@x", groups: [] },
    deployConfig: { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch },
    manifest,
  });
  try {
    for (const bad of [["ops-feishu"], { a: "" }, { a: "OPS-FEISHU" }, { a: 42 }, { a: "x".repeat(65) }]) {
      const refused = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { notifyChannel: bad });
      assert.equal(refused.status, 400, `notifyChannel ${JSON.stringify(bad)} must be rejected`);
    }
    assert.equal(stub.calls.agents.length, 0, "no registry write on a refused binding");

    const ok = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { notifyChannel: { "pack-fingpt": "ops-feishu" } });
    assert.equal(ok.status, 200);
    assert.equal(stub.calls.agents.at(-1).body.metadata.notify_channel, "ops-feishu");

    // null on the wire: unbind.
    const clear = await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`, { notifyChannel: { "pack-fingpt": null } });
    assert.equal(clear.status, 200);
    assert.equal(stub.calls.agents.at(-1).body.metadata.notify_channel, undefined);
  } finally {
    await h.close();
  }
});

// ── fix-deploy-toggle-probe-race: deploy reassurance re-toggle ladder ────────
// The registry's toggle POST is a state no-op when already enabled, but every
// call re-probes the backend and persists health_status (the only automatic
// heal — its periodic loop covers MCP servers only). A fresh deploy therefore
// re-fires the toggle across the runner's ≤5min pickup window.

test("deploy fires the reassurance ladder for the deployed agent (immediate + rungs)", async () => {
  const stub = stubRegistry();
  const toggles = [];
  const baseFetch = stub.fetch;
  const fetchImpl = async (url, init) => {
    if (String(url).includes("/toggle?")) toggles.push(String(url));
    return baseFetch(url, init);
  };
  await servingLib.deployToRegistry({ ...PACK, fetchImpl, reassuranceDelays: [10, 20] });
  assert.equal(toggles.length, 1, "the immediate toggle still fires first");
  assert.match(toggles[0], /^\/api\/agents\/packs\/pk-abc\/pack-fingpt\/toggle\?enabled=true$/);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(toggles.length, 3, "one immediate + two ladder re-fires");
});

test("reassurance failures are logged, never thrown (deploy response unaffected)", async () => {
  const warned = [];
  servingLib.scheduleDeployReassurance({
    doFetch: async () => { throw new Error("boom"); },
    path: "/packs/pk-abc/x",
    delays: [10],
    log: { log: () => {}, warn: (m) => warned.push(m) },
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(warned.length, 1);
  assert.match(warned[0], /re-toggle failed \(\+0s\): boom/);
});

test("setAgentPaused GET-merge-PUTs the flag and clears it on resume", async () => {
  const manifest = withServing({ protocol: "a2a" });
  const stub = stubRegistry();
  await servingLib.deployToRegistry({
    packId: "pk-abc", version: 3, runnerBaseUrl: "http://runner.tailnet",
    packsPublicBase: "https://packs.example.test", registryUrl: "https://mcp.example.test",
    manifest, fetchImpl: stub.fetch,
  });
  const out = await servingLib.setAgentPaused({
    registryUrl: "https://mcp.example.test", fetchImpl: stub.fetch,
    agentPath: "/packs/pk-abc/pack-fingpt", paused: true,
  });
  assert.equal(out.paused, true);
  // The last written entry (what the runner's poll reads) carries the flag
  // while keeping the descriptor fields intact.
  const pausedDoc = stub.calls.agents.at(-1).body;
  assert.equal(pausedDoc.metadata.paused, true);
  assert.equal(pausedDoc.metadata.packId, "pk-abc");

  await servingLib.setAgentPaused({
    registryUrl: "https://mcp.example.test", fetchImpl: stub.fetch,
    agentPath: "/packs/pk-abc/pack-fingpt", paused: false,
  });
  assert.equal(stub.calls.agents.at(-1).body.metadata.paused, undefined);
});

// ── add-agent-residency: pause/resume/kill route gates ────────────────────────

test("pause/resume are deployer-gated and write the registry flag", async () => {
  const stub = stubRegistry();
  const manifest = withServing({ protocol: "a2a" });
  const cfg = { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch };
  const stranger = await routeHarness({ user: { email: "stranger@x", groups: [] }, deployConfig: cfg, manifest });
  try {
    const dep = await stranger.call("POST", `/api/packs/${stranger.packId}/versions/1/deploy`);
    assert.equal(dep.status, 403, "stranger cannot deploy, so nothing exists for them to pause");
    const noRow = await stranger.call("POST", `/api/packs/${stranger.packId}/deployments/pack-fingpt/pause`);
    assert.equal(noRow.status, 403);
  } finally {
    await stranger.close();
  }
  const author = await routeHarness({ user: { email: "author@x", groups: [] }, deployConfig: cfg, manifest });
  try {
    const dep = await author.call("POST", `/api/packs/${author.packId}/versions/1/deploy`);
    assert.equal(dep.status, 200);
    const pause = await author.call("POST", `/api/packs/${author.packId}/deployments/pack-fingpt/pause`);
    assert.equal(pause.status, 200);
    assert.equal(pause.body.paused, true);
    assert.equal(stub.calls.agents.at(-1).body.metadata.paused, true);
    const resume = await author.call("POST", `/api/packs/${author.packId}/deployments/pack-fingpt/resume`);
    assert.equal(resume.status, 200);
    assert.equal(resume.body.paused, false);
    assert.equal(stub.calls.agents.at(-1).body.metadata.paused, undefined);
    const unknown = await author.call("POST", `/api/packs/${author.packId}/deployments/nope/pause`);
    assert.equal(unknown.status, 404);
  } finally {
    await author.close();
  }
});

test("kill is admin-gated and writes the same flag; deployments list reports paused", async () => {
  const stub = stubRegistry();
  const manifest = withServing({ protocol: "a2a" });
  const cfg = { registryUrl: "https://mcp.example.test", token: "t", runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test", fetchImpl: stub.fetch };
  const h = await routeHarness({ user: { email: "author@x", groups: [] }, deployConfig: cfg, manifest });
  try {
    await h.call("POST", `/api/packs/${h.packId}/versions/1/deploy`);
    // The author may deploy but NOT kill — platform emergency stop is admin-only.
    const denied = await h.call("POST", `/api/packs/${h.packId}/deployments/pack-fingpt/kill`);
    assert.equal(denied.status, 403);
  } finally {
    await h.close();
  }
  // The admin harness is its own registry — give the admin the creator hat so
  // the deployment row exists in THIS harness before the kill.
  const admin = await routeHarness({ user: { email: "ops@x", groups: ["admin", "creators"] }, deployConfig: cfg, manifest });
  try {
    await admin.call("POST", `/api/packs/${admin.packId}/versions/1/deploy`);
    const kill = await admin.call("POST", `/api/packs/${admin.packId}/deployments/pack-fingpt/kill`);
    assert.equal(kill.status, 200);
    assert.equal(kill.body.by, "platform");
    assert.equal(stub.calls.agents.at(-1).body.metadata.paused, true);
    const list = await admin.call("GET", `/api/packs/${admin.packId}/deployments`);
    assert.equal(list.body.deployments[0].paused, true);
  } finally {
    await admin.close();
  }
});
