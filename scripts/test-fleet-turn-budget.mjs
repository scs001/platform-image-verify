// Unit tests for the per-post turn budget (fix-fleet-chain-operability D3).
//
// Covers the spec pins:
//   - member cadence.turnTimeoutMs within [2min, 30min] takes effect
//   - out-of-range values clamp to the nearest bound (floor and ceiling)
//   - unset/invalid/non-positive → the historical 10-minute default
//   - non-fleet jobs (no sourceTag.fleetId/memberId) never read the field
//   - fleet-db read failure degrades open to the default, never throws
//
// Run: node --test scripts/test-fleet-turn-budget.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { resolveTurnBudgetMs } = await import("../server/cron-runner.js");

const DEFAULT = 10 * 60 * 1000;
const FLOOR = 2 * 60 * 1000;
const CEILING = 30 * 60 * 1000;

function fakeDb(cadence) {
  return { getMember: (id) => (id === "m_x" ? { id: "m_x", cadence } : null) };
}

test("in-range declared budget takes effect", () => {
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: 20 * 60 * 1000 }) }), 20 * 60 * 1000);
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: 120000 }) }), 120000);
});

test("out-of-range values clamp", () => {
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: 90000 }) }), FLOOR, "below floor → 2min");
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: 3_600_000 }) }), CEILING, "above ceiling → 30min");
});

test("unset/invalid/non-positive → default", () => {
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ cron: "0 * * * *" }) }), DEFAULT, "no field");
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: null }) }), DEFAULT, "explicit null");
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: 0 }) }), DEFAULT, "zero");
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: -5 }) }), DEFAULT, "negative");
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: fakeDb({ turnTimeoutMs: "soon" }) }), DEFAULT, "non-numeric string");
});

test("non-fleet jobs never read the field", () => {
  assert.equal(resolveTurnBudgetMs({ preset: "solo" }, { db: fakeDb({ turnTimeoutMs: 20 * 60 * 1000 }) }), DEFAULT, "plain cron task");
  assert.equal(resolveTurnBudgetMs({ sourceTag: { fleetId: "f1" } }, { db: fakeDb({ turnTimeoutMs: 20 * 60 * 1000 }) }), DEFAULT, "fleetId without memberId");
});

test("fleet-db failure degrades open to the default", () => {
  assert.equal(
    resolveTurnBudgetMs({ sourceTag: { fleetId: "f1", memberId: "m_x" } }, { db: { getMember: () => { throw new Error("db gone"); } } }),
    DEFAULT,
  );
});
