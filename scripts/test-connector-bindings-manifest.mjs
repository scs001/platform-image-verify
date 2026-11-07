#!/usr/bin/env node
// ── Connector bindings declaration validation (add-connector-bindings, 1.1-1.3) ─
//
// A pack's `connector_bindings` is the machine-readable promise "this pack needs
// these external systems, at (provider, operationType) grain". Publish and
// install both run validatePackManifest, so these level tests pin the contract
// without a live facet.
//
// The two fixtures are the real 仓配分销 connector pack: `-before` is the shape
// that shipped (prose `provider_status`, no machine fields) and `-after` is the
// same pack with the machine fields filled in. Keeping both as cases means the
// validator cannot quietly start accepting prose, nor start rejecting a legal
// declaration.
//
//   node --test scripts/test-connector-bindings-manifest.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validatePackManifest } from "../lib/pack-manifest.js";

const BASE = {
  name: "T",
  skills: [{ name: "s", description: "d", content: "c" }],
  mcpServers: [],
  agents: [],
};

const withBindings = (bindings) => ({ ...BASE, connector_bindings: bindings });
const errorsFor = (bindings) => validatePackManifest(withBindings(bindings));
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/connector-bindings/${name}`, import.meta.url), "utf8"));

const legal = {
  key: "kingdee-cloud",
  provider: "kingdee",
  allowOperations: [{ operationType: "read" }, { operationType: "write" }],
  connectionHint: "金蝶云星空账套",
  optional: false,
  external_system: "金蝶云星空",
  note: "human prose",
};

test("a legal declaration validates clean", () => {
  assert.deepEqual(errorsFor([legal]), []);
});

test("operation classes may be shorthands for the binding's own provider", () => {
  assert.deepEqual(errorsFor([{ key: "k", provider: "kingdee", allowOperations: ["read"] }]), []);
});

test("allowActions alone is a legal scope", () => {
  assert.deepEqual(errorsFor([{ key: "k", provider: "kingdee", allowActions: ["kingdee.list_bills"] }]), []);
});

test("a binding with only human fields is rejected for missing scope, not missing description", () => {
  const errors = errorsFor([
    {
      key: "prose-only",
      external_system: "金蝶云星空",
      surface: "凭证/往来推送",
      direction: "push-via-connector",
      credential: "BYOK：ERP_BYOK_KINGDEE_*",
      note: "对外付款 = 核对指令输出",
    },
  ]);
  // No provider either — the binding is prose, so that is reported too. What
  // matters is that the *scope* gap is named and prose is never asked for.
  const scope = errors.find((e) => e.code === "connector_binding_scope_missing");
  assert.ok(scope, `expected a scope error, got ${JSON.stringify(errors)}`);
  assert.match(scope.error, /declares no scope/);
  assert.ok(errors.every((e) => !/description/.test(e.error)));
});

test("a duplicate key is rejected and names the conflicting key", () => {
  const errors = errorsFor([legal, { key: "kingdee-cloud", provider: "kingdee", allowOperations: ["read"] }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].entry, "connector_bindings[1].key");
  assert.match(errors[0].error, /duplicate connector binding key 'kingdee-cloud'/);
});

test("an empty key or provider is rejected per field", () => {
  const errors = errorsFor([{ key: " ", provider: "", allowOperations: ["read"] }]);
  const entries = errors.map((e) => e.entry);
  assert.deepEqual(entries.sort(), ["connector_bindings[0].key", "connector_bindings[0].provider"]);
});

test("an operation class outside the closed set is rejected", () => {
  // `destructive` is a real catalog class but is not grantable by a binding.
  const errors = errorsFor([{ key: "k", provider: "kingdee", allowOperations: ["destructive"] }]);
  const classError = errors.find((e) => e.entry === "connector_bindings[0].allowOperations[0]");
  assert.ok(classError, `expected a class error, got ${JSON.stringify(errors)}`);
  assert.match(classError.error, /read\/write/);
});

test("an operation scope for an undeclared provider is rejected", () => {
  const errors = errorsFor([
    { key: "k", provider: "kingdee", allowOperations: [{ provider: "feishu", operationType: "read" }] },
  ]);
  const providerError = errors.find((e) => /not this binding's provider/.test(e.error));
  assert.ok(providerError, `expected a provider error, got ${JSON.stringify(errors)}`);
  assert.equal(providerError.entry, "connector_bindings[0].allowOperations[0]");
});

test("an operation scope for an alternative provider is accepted", () => {
  assert.deepEqual(
    errorsFor([
      {
        key: "k",
        provider: "wechatpay",
        alternativeProviders: ["alipay"],
        allowOperations: [{ provider: "alipay", operationType: "read" }],
      },
    ]),
    [],
  );
});

test("optional must be a boolean when present", () => {
  const errors = errorsFor([{ key: "k", provider: "kingdee", allowOperations: ["read"], optional: "yes" }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].entry, "connector_bindings[0].optional");
});

test("the later ledger-owned status field is not writable prose", () => {
  const errors = errorsFor([{ ...legal, provider_status: "directory-provider" }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /decided by the binding ledger/);
});

test("a single provider may carry two bindings with different ranges", () => {
  assert.deepEqual(
    errorsFor([
      { key: "kingdee-read", provider: "kingdee", allowOperations: ["read"] },
      { key: "kingdee-write", provider: "kingdee", allowOperations: ["write"] },
    ]),
    [],
  );
});

test("the real pack is rejected before the machine fields land", () => {
  const errors = validatePackManifest(fixture("supply-chain-before.json"));
  // Every binding fails on the same two facts: prose status is not writable, and
  // there is no scope to grant. Nothing else in the manifest is wrong.
  const codes = errors.map((e) => e.code);
  assert.equal(codes.filter((code) => code === "connector_binding_scope_missing").length, 5);
  assert.equal(codes.filter((code) => code.includes("provider_status")).length, 0);
  assert.ok(
    errors.every((e) => e.entry.startsWith("connector_bindings")),
    `unexpected non-binding errors: ${JSON.stringify(errors.filter((e) => !e.entry?.startsWith("connector_bindings")))}`,
  );
});

test("the real pack passes once the machine fields are filled in", () => {
  assert.deepEqual(validatePackManifest(fixture("supply-chain-after.json")), []);
});

test("the real pack's after-state keeps the human fields untouched", () => {
  const manifest = fixture("supply-chain-after.json");
  for (const binding of manifest.connector_bindings) {
    for (const field of ["external_system", "surface", "direction", "credential", "note"]) {
      assert.equal(typeof binding[field], "string", `${binding.key} lost ${field}`);
    }
  }
});
