// Layout resolution (openspec: layout-configuration). The four-layer narrowing
// chain is the load-bearing contract: factory → deployment → role → user, each
// layer only hiding or reordering what the layer above left, deployment hiding
// terminal, platform predicates absolute. Plus preset validation and the
// dirty-data degradation paths (a stale slug must never blank a container or
// throw).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FACTORY_PRESETS,
  FACTORY_PRESET_SLUG,
  NAV_SURFACES,
  SETTINGS_SURFACES,
  AGENTS_TAB_SURFACES,
  factoryPreset,
  parseHiddenSource,
  parsePresetSource,
  predicateAllows,
  registryFor,
  resolveContainer,
  resolveLayout,
  validatePreset,
} from "../packages/core/src/lib/surfaces.ts";

const ALL_NAV = NAV_SURFACES.map((s) => s.slug);
const ALL_SETTINGS = SETTINGS_SURFACES.map((s) => s.slug);
const ALL_TABS = AGENTS_TAB_SURFACES.map((s) => s.slug);

// ── Factory baseline ────────────────────────────────────────────────────────

test("factory preset equals the registry exactly (baseline equivalence)", () => {
  const p = FACTORY_PRESETS[FACTORY_PRESET_SLUG];
  assert.deepEqual(p.nav, ALL_NAV);
  assert.deepEqual(p.settings, ALL_SETTINGS);
  assert.deepEqual(p.agentsTabs, ALL_TABS);
});

test("no layers resolves to the registry order", () => {
  const r = resolveLayout({});
  assert.deepEqual(r.nav, ALL_NAV);
  assert.deepEqual(r.settings, ALL_SETTINGS);
  assert.deepEqual(r.agentsTabs, ALL_TABS);
});

test("unknown preset slug falls back to the factory snapshot", () => {
  assert.deepEqual(factoryPreset("nope"), FACTORY_PRESETS[FACTORY_PRESET_SLUG]);
  assert.deepEqual(factoryPreset(undefined), FACTORY_PRESETS[FACTORY_PRESET_SLUG]);
  assert.deepEqual(factoryPreset("simple"), FACTORY_PRESETS.simple);
});

// ── Predicates ──────────────────────────────────────────────────────────────

test("desktop-only surface is dropped when the fact says browser", () => {
  const fleet = NAV_SURFACES.find((s) => s.slug === "fleet");
  assert.equal(predicateAllows(fleet, { isDesktop: false }), false);
  assert.equal(predicateAllows(fleet, { isDesktop: true }), true);
  // Unknown fact leaves it in place (a client that cannot answer keeps it).
  assert.equal(predicateAllows(fleet, {}), true);
  const r = resolveLayout({}, { isDesktop: false });
  assert.equal(r.nav.includes("fleet"), false);
});

test("a preset cannot conjure the fleet into a browser", () => {
  const allWithFleet = { version: 1, nav: ALL_NAV };
  const r = resolveLayout({ deployment: { preset: allWithFleet } }, { isDesktop: false });
  assert.equal(r.nav.includes("fleet"), false);
});

test("marketplace-gated tab disappears when the deployment lacks the market", () => {
  assert.equal(predicateAllows(AGENTS_TAB_SURFACES.find((s) => s.slug === "market"), { packMarketplace: false }), false);
  const r = resolveLayout({}, { packMarketplace: false });
  assert.deepEqual(r.agentsTabs, ["agents", "apps"]);
});

test("admin-only section needs an affirmative admin answer when auth is on", () => {
  const branding = SETTINGS_SURFACES.find((s) => s.slug === "branding");
  assert.equal(predicateAllows(branding, { authOn: true, isAdmin: false }), false);
  assert.equal(predicateAllows(branding, { authOn: true, isAdmin: true }), true);
  // Auth off = machine owner sees everything (existing gate semantics).
  assert.equal(predicateAllows(branding, { authOn: false }), true);
  const r = resolveLayout({}, { authOn: true, isAdmin: false });
  assert.equal(r.settings.includes("branding"), false);
  assert.equal(r.settings.includes("roles"), false);
  assert.equal(r.settings.includes("layout"), false);
});

// ── Narrowing chain ─────────────────────────────────────────────────────────

test("role preset narrows within the deployment default", () => {
  const r = resolveLayout({
    deployment: { preset: factoryPreset(FACTORY_PRESET_SLUG) },
    role: { preset: factoryPreset("simple") },
  });
  assert.deepEqual(r.nav, ["chat", "knowledge", "resources", "agents"]);
  assert.deepEqual(r.settings, ["general", "account", "wechat-app", "devices"]);
});

test("no layer can re-reveal what a more general layer hid", () => {
  const r = resolveLayout({
    deployment: { preset: { version: 1, nav: ["chat", "knowledge", "resources", "agents"] } },
    role: { preset: { version: 1, nav: ALL_NAV } }, // tries to bring apps/tasks back
  });
  assert.deepEqual(r.nav, ["chat", "knowledge", "resources", "agents"]);
});

test("deployment hidden list is terminal: no later layer re-reveals", () => {
  const r = resolveLayout({
    deployment: { hidden: ["tasks"] },
    role: { preset: { version: 1, nav: ALL_NAV } },
    user: { preset: { version: 1, nav: ALL_NAV } },
  });
  assert.equal(r.nav.includes("tasks"), false);
});

test("role narrowing composes with a deployment hidden list", () => {
  const r = resolveLayout({
    deployment: { hidden: ["apps"] },
    role: { preset: { version: 1, nav: ["chat", "agents", "tasks"] } },
  });
  assert.deepEqual(r.nav, ["chat", "agents", "tasks"]);
});

test("user layer supplies the final relative order (reorder support)", () => {
  const r = resolveLayout({
    user: { preset: { version: 1, nav: ["tasks", "chat", "knowledge", "resources", "agents", "apps"] } },
  });
  assert.deepEqual(r.nav, ["tasks", "chat", "knowledge", "resources", "agents", "apps"]);
  // Everything the user did not list is hidden (their list is the full set).
  assert.equal(r.nav.includes("fleet"), false);
});

test("a preset that would blank a container is ignored", () => {
  const r = resolveLayout({
    deployment: { preset: { version: 1, nav: [] } },
  });
  assert.deepEqual(r.nav, ALL_NAV);
});

test("stale slugs in a layer are ignored, never fatal", () => {
  const r = resolveLayout({
    user: { preset: { version: 1, nav: ["chat", "retired-surface", "agents"] } },
  });
  assert.deepEqual(r.nav, ["chat", "agents"]);
});

test("containers the layer omits are left untouched", () => {
  const r = resolveLayout({ user: { preset: { version: 1, nav: ["chat"] } } });
  assert.deepEqual(r.nav, ["chat"]);
  assert.deepEqual(r.settings, ALL_SETTINGS);
  assert.deepEqual(r.agentsTabs, ALL_TABS);
});

test("resolveContainer applies layers in the documented order", () => {
  const slugs = resolveContainer("nav", {
    deployment: { preset: { version: 1, nav: ["chat", "knowledge", "resources", "agents", "apps"] } },
    role: { preset: { version: 1, nav: ["chat", "knowledge", "resources", "agents"] } },
    user: { preset: { version: 1, nav: ["agents", "chat", "knowledge", "resources"] } },
  });
  assert.deepEqual(slugs, ["agents", "chat", "knowledge", "resources"]);
});

// ── Validation & degradation ────────────────────────────────────────────────

test("validatePreset accepts a partial preset and rejects unknown slugs", () => {
  assert.deepEqual(validatePreset({ version: 1, nav: ["chat"] }), { ok: true, preset: { version: 1, nav: ["chat"] } });
  const bad = validatePreset({ version: 1, settings: ["not-a-section"] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown settings surface/);
  assert.equal(validatePreset(null).ok, false);
  assert.equal(validatePreset([]).ok, false);
  assert.equal(validatePreset({ version: 1, nav: "chat" }).ok, false);
  // A settings slug placed in the nav container is rejected (container mismatch).
  assert.equal(validatePreset({ version: 1, nav: ["general"] }).ok, false);
});

test("parsePresetSource degrades bad input to null", () => {
  assert.equal(parsePresetSource(null), null);
  assert.equal(parsePresetSource(""), null);
  assert.equal(parsePresetSource("{not json"), null);
  assert.equal(parsePresetSource(JSON.stringify({ version: 1, nav: ["bogus"] })), null);
  assert.deepEqual(parsePresetSource(JSON.stringify({ version: 1, nav: ["chat"] })), { version: 1, nav: ["chat"] });
});

test("parseHiddenSource accepts arrays and JSON strings, rejects the rest", () => {
  assert.deepEqual(parseHiddenSource(["tasks"]), ["tasks"]);
  assert.deepEqual(parseHiddenSource('["tasks","apps"]'), ["tasks", "apps"]);
  assert.equal(parseHiddenSource("nope"), null);
  assert.equal(parseHiddenSource("{}"), null);
});

test("registryFor returns the canonical list per container", () => {
  assert.deepEqual(registryFor("nav").map((s) => s.slug), ALL_NAV);
  assert.deepEqual(registryFor("settings").map((s) => s.slug), ALL_SETTINGS);
  assert.deepEqual(registryFor("agentsTabs").map((s) => s.slug), ALL_TABS);
});
