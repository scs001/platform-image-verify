#!/usr/bin/env node
// ── Deployment-scoped connector bindings (add-deployment-binding-grant) ──────
//
// The interactive path needs a person: the binding token is an attenuated child
// of the user's own connector account, minted from their session. A served agent
// has no session, so the mint moves to DEPLOY time and the token lands in
// `deployment_secrets` — values platform-side, an opaque reference on the
// descriptor (the same discipline deployment keys follow).
//
// What is pinned here is the decision table, because "which bindings may a
// deployment carry" is exactly where a wrong answer leaks authority:
//   satisfied + non-optional → mint
//   optional                 → skip (the pack said the user may decline)
//   missing / unwired / undetermined → skip (unanswered is not "granted")
//   deprecated               → skip (history)
// And: a failed mint never fails the deploy, never mints two tokens for one
// binding, and the secret name is a legal `[a-z0-9_]{1,32}` whatever the key
// looks like.
//
//   node --test scripts/test-deployment-bindings.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "deployment-bindings-"));
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
// The connector origin comes from the deployment baseline (mcp.json) — without
// it mintBindingToken refuses with connector_not_configured, which is exactly
// what a real deployment without a connector row would do.
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({ mcpServers: { connector: { url: "https://connector.example.test/mcp", credentialRef: "connector" } } }),
);

const db = await import("../db.js");
const deploymentBindings = await import("../deployment-bindings.js");
const connectorCredentials = await import("../connector-credentials.js");

const OWNER = "deployer@example.test";
const PACK = "drill-pack";

function seedLedger(key, status, optional = false) {
  db.upsertConnectorBindingLedgerRow({
    email: OWNER,
    packId: PACK,
    packVersion: "1",
    bindingKey: key,
    provider: "alpha_vantage",
    operations: ["read"],
    status,
    optional,
  });
}

function fakeConnector(handler) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    return handler(String(url), body, init);
  };
}

test("the decision table follows the ledger's states, not a local opinion", async () => {
  await db.initDb();
  assert.equal(db.isDbReady(), true);
  // The parent credential: a real active account on the connector.
  connectorCredentials.store({ email: OWNER, slot: "default", token: "oct_parent" });
  db.setConnectorCredentialActive(OWNER, "default");

  seedLedger("ok", "satisfied");
  seedLedger("chosen_out", "satisfied", true);
  seedLedger("todo", "missing");
  seedLedger("gap", "unwired");
  seedLedger("unknown", "undetermined");
  seedLedger("gone", "deprecated");

  const mintable = deploymentBindings.mintableBindings({ email: OWNER, packId: PACK });
  assert.deepEqual(
    mintable.map((row) => row.bindingKey),
    ["ok"],
    "only satisfied + non-optional is mintable",
  );
});

test("a deployment secret name is a legal secret name whatever the key is", () => {
  for (const key of ["market", "wms:erp", "A.B-C/D", "x".repeat(80), ""]) {
    const name = deploymentBindings.deploymentBindingSecretName(key);
    assert.match(name, /^[a-z0-9_]{1,32}$/, `key ${JSON.stringify(key)} -> ${name}`);
    assert.ok(name.startsWith(deploymentBindings.DEPLOYMENT_BINDING_PREFIX));
  }
});

test("one mint per (pack, agent, key), recorded as a deployment secret", async () => {
  const recorded = [];
  const result = await deploymentBindings.mintDeploymentBindings({
    email: OWNER,
    packId: PACK,
    agentIds: ["writer"],
    record: (row) => recorded.push(row),
    fetchImpl: fakeConnector(async (url) => {
      assert.match(url, /\/api\/tenant\/pats$/);
      return new Response(JSON.stringify({ token: "oct_child", id: "pat-1" }), { status: 200 });
    }),
  });

  assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
  assert.equal(result.granted.length, 1);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].name, "connector_binding_ok");
  assert.equal(recorded[0].secretValue, "oct_child", "the token is stored as the secret value");
  assert.equal(recorded[0].deployer, OWNER, "ownership is the deployer's");
  assert.ok(!JSON.stringify(result).includes("oct_child"), "the token never rides the result payload");
});

test("a failed mint degrades to a reported failure, never a failed deploy", async () => {
  const recorded = [];
  const result = await deploymentBindings.mintDeploymentBindings({
    email: OWNER,
    packId: PACK,
    agentIds: ["writer"],
    record: (row) => recorded.push(row),
    fetchImpl: fakeConnector(async () => new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 })),
  });

  assert.equal(result.granted.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(recorded.length, 0, "nothing is stored when the mint fails");
});

test("no account means no mint — the parent must be a real identity", async () => {
  const STRANGER = "stranger@example.test";
  // A satisfied binding row but NO connector account: the ledger says the
  // binding is resolvable, yet there is no parent credential to attenuate from.
  db.upsertConnectorBindingLedgerRow({
    email: STRANGER,
    packId: PACK,
    packVersion: "1",
    bindingKey: "ok",
    provider: "alpha_vantage",
    operations: ["read"],
    status: "satisfied",
  });

  let connectorCalls = 0;
  const result = await deploymentBindings.mintDeploymentBindings({
    email: STRANGER,
    packId: PACK,
    agentIds: ["writer"],
    record: () => assert.fail("must not record without a parent credential"),
    fetchImpl: async () => {
      connectorCalls += 1;
      assert.fail("must not call the connector without a parent credential");
    },
  });

  assert.equal(result.granted.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].code, "no_account");
  assert.equal(connectorCalls, 0);
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
