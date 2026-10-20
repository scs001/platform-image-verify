// ── action-registry unit tests (add-line-boards-and-action-gate) ─────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAction,
  listActions,
  isRegistered,
  riskToTierMap,
  tierForRisk,
  RISK,
} from "./action-registry.js";

describe("action-registry", () => {
  it("getAction returns correct entry for known id", () => {
    const action = getAction("facet.pack.publish");
    assert.ok(action);
    assert.equal(action.id, "facet.pack.publish");
    assert.equal(action.line, "facet");
    assert.equal(action.risk, RISK.publish);
    assert.equal(action.target, "cloud");
  });

  it("getAction returns null for unknown id", () => {
    const action = getAction("unknown.action");
    assert.strictEqual(action, null);
  });

  it("listActions filters by line", () => {
    const facetActions = listActions({ line: "facet" });
    assert.equal(facetActions.length, 4);
    facetActions.forEach((a) => assert.equal(a.line, "facet"));

    const wanxingActions = listActions({ line: "wanxing" });
    assert.equal(wanxingActions.length, 5);
    wanxingActions.forEach((a) => assert.equal(a.line, "wanxing"));
  });

  it("listActions filters by target", () => {
    const cloudActions = listActions({ target: "cloud" });
    // All actions except deploy are cloud-only; deploy has target=any
    assert.ok(cloudActions.length >= 8);
    cloudActions.forEach((a) => {
      assert.ok(a.target === "cloud" || a.target === "any");
    });
  });

  it("isRegistered returns true for registered actions", () => {
    assert.ok(isRegistered("facet.pack.publish"));
    assert.ok(isRegistered("wanxing.agent.deploy"));
  });

  it("isRegistered returns false for unregistered actions", () => {
    assert.ok(!isRegistered("fake.tool"));
  });

  it("riskToTierMap returns all mappings", () => {
    const map = riskToTierMap();
    assert.deepEqual(Object.keys(map).sort(), [
      "cost",
      "destructive",
      "publish",
      "read",
      "write",
    ]);
  });

  it("tierForRisk maps each risk to correct tier", () => {
    assert.equal(tierForRisk(RISK.read), "auto");
    assert.equal(tierForRisk(RISK.write), "inline");
    assert.equal(tierForRisk(RISK.destructive), "second");
    assert.equal(tierForRisk(RISK.cost), "second");
    assert.equal(tierForRisk(RISK.publish), "async");
    assert.equal(tierForRisk("unknown"), "unknown");
  });

  it("all nine v1 actions are present and consistent", () => {
    const expectedIds = [
      "facet.pack.publish",
      "facet.pack.visibility",
      "facet.pack.curation",
      "facet.agent.toggle",
      "wanxing.agent.pause",
      "wanxing.agent.resume",
      "wanxing.callers.add",
      "wanxing.callers.remove",
      "wanxing.agent.deploy",
    ];
    expectedIds.forEach((id) => {
      const action = getAction(id);
      assert.ok(action, `missing action: ${id}`);
      assert.ok(isRegistered(id));
      assert.ok(["read", "write", "destructive", "cost", "publish"].includes(action.risk));
      assert.ok(["cloud", "desktop", "any"].includes(action.target));
      assert.equal(typeof action.impact, "function");
      assert.equal(typeof action.preflight, "function");
    });
  });
});
