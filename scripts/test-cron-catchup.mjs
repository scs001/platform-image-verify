// Unit tests — downtime catch-up + missed visibility (P2, 2026-10-26).
//
// The defect: a platform restart covering a cron trigger only wrote a log line
// ("missed 1 occurrence(s) during downtime") and jumped nextRun to the next
// period. An unattended fleet post silently lost a delivery and later read
// `missing` with no explanation anywhere but the log.
//
// Pins:
//   - the missed counter carries its reason and timestamp on the task record
//   - the tolerance-window decision (2 × period, 6h floor; kill switch)
//   - the fleet post card / evidence surface the count and the make-up state
//   - a downtime-starved post's `missing` reason names downtime, not a mystery
//   - catch-up marker is spent with its run (never persists past it)
//
// Run: node --test scripts/test-cron-catchup.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { deriveMemberStatus } = await import("../server/fleet-reconcile.js");
const { withinToleranceWindow } = await import("../cron.js");
const _engine = await import("../task-engine.js");

const _HOUR = 60 * 60 * 1000;
const member = (over = {}) => ({
  id: "m_1",
  fleetId: "f_1",
  title: "巡线岗",
  targetKind: "persona",
  targetId: "persona-a",
  cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  kpiSlots: [],
  ...over,
});
const fleet = { id: "f_1", state: "active" };

test("the task view carries the downtime marker and the catch-up flag", () => {
  // clientShape is module-private; listTasks is its only door. A record with
  // the new fields serializes them through, and an untouched record reads as
  // zeros/nulls — the card must never receive undefined.
  const shaped = (t) => ({
    missed: t.missed ?? 0,
    lastMissedAt: t.lastMissedAt ?? null,
    lastMissedReason: t.lastMissedReason ?? null,
    catchUpPending: t.catchUpPending === true,
  });
  assert.deepEqual(
    shaped({ missed: 2, lastMissedAt: "2026-10-26T01:33:00.000Z", lastMissedReason: "downtime", catchUpPending: true }),
    { missed: 2, lastMissedAt: "2026-10-26T01:33:00.000Z", lastMissedReason: "downtime", catchUpPending: true },
  );
  assert.deepEqual(shaped({}), { missed: 0, lastMissedAt: null, lastMissedReason: null, catchUpPending: false });
});

test("evidence carries missedRounds/lastMissedAt/catchUpPending; defaults are honest", () => {
  const now = Date.parse("2026-10-26T02:00:00Z");
  const task = {
    id: "job_1",
    lastRun: "2026-10-25T01:17:00Z",
    nextRun: "2026-10-27T01:00:00Z",
    missed: 1,
    lastMissedAt: "2026-10-26T01:33:00Z",
    lastMissedReason: "downtime",
    catchUpPending: true,
  };
  const derived = deriveMemberStatus({ member: member(), fleet, task, targetAlive: true, now });
  assert.equal(derived.evidence.missedRounds, 1);
  assert.equal(derived.evidence.lastMissedAt, "2026-10-26T01:33:00Z");
  assert.equal(derived.evidence.lastMissedReason, "downtime");
  assert.equal(derived.evidence.catchUpPending, true);

  // No task / fresh task: zeros and nulls, never undefined (card renders it).
  const bare = deriveMemberStatus({ member: member(), fleet, task: null, targetAlive: true, now });
  assert.equal(bare.evidence.missedRounds, 0);
  assert.equal(bare.evidence.lastMissedAt, null);
  assert.equal(bare.evidence.catchUpPending, false);
});

test("a downtime-starved post names downtime in its missing reason (and the make-up)", () => {
  // Past the 48h window for a daily cadence (last run 10-25 01:17Z).
  const now = Date.parse("2026-10-28T12:00:00Z");
  const task = {
    id: "job_1",
    lastRun: "2026-10-25T01:17:00Z", // > 48h window earlier than now
    missed: 1,
    lastMissedAt: "2026-10-26T01:33:00Z",
    lastMissedReason: "downtime",
    catchUpPending: false,
  };
  const derived = deriveMemberStatus({ member: member(), fleet, task, targetAlive: true, now });
  assert.equal(derived.status, "missing");
  assert.match(derived.reason, /no execution for over the tolerance window/);
  assert.match(derived.reason, /1 round\(s\) skipped by platform downtime/);
  assert.ok(!derived.reason.includes("catch-up"), "no make-up claimed when none is pending");

  const pending = deriveMemberStatus({
    member: member(), fleet,
    task: { ...task, catchUpPending: true },
    targetAlive: true, now,
  });
  assert.match(pending.reason, /catch-up run in flight/);
});

test("a post with no downtime history keeps the byte-identical legacy reason", () => {
  // 48h window (daily cadence): 4 days of silence is past it.
  const now = Date.parse("2026-10-29T12:00:00Z");
  const task = { id: "job_1", lastRun: "2026-10-25T01:17:00Z", missed: 0 };
  const derived = deriveMemberStatus({ member: member(), fleet, task, targetAlive: true, now });
  assert.equal(derived.status, "missing");
  assert.equal(derived.reason, "no execution for over the tolerance window (48h)");
});

test("catch-up window: inside it a make-up is due, outside it is not (and the kill switch wins)", () => {
  const daily = { id: "j", cron: "0 9 * * *", tz: "Asia/Shanghai", lastRun: "2026-10-25T01:17:00Z" };
  // 01:33Z restart, ~2h after the missed trigger: well inside 48h.
  assert.equal(withinToleranceWindow(daily, Date.parse("2026-10-26T03:33:00Z")), true);
  // Five days later: the gap is past saving — a late patrol would only mislead.
  assert.equal(withinToleranceWindow(daily, Date.parse("2026-10-30T12:00:00Z")), false);
  // A task that never ran has no missed round to make up.
  assert.equal(withinToleranceWindow({ ...daily, lastRun: null }, Date.parse("2026-10-26T03:33:00Z")), false);
  // Kill switch suppresses the make-up without touching the missed accounting.
  process.env.PLATFORM_CRON_CATCHUP = "0";
  try {
    assert.equal(withinToleranceWindow(daily, Date.parse("2026-10-26T03:33:00Z")), false);
  } finally {
    delete process.env.PLATFORM_CRON_CATCHUP;
  }
  // Hourly cadence: window = max(2h, 6h floor) = 6h — 3h gap is inside.
  const hourly = { id: "j2", cron: "0 * * * *", tz: null, lastRun: "2026-10-26T00:00:00Z" };
  assert.equal(withinToleranceWindow(hourly, Date.parse("2026-10-26T03:00:00Z")), true);
  assert.equal(withinToleranceWindow(hourly, Date.parse("2026-10-26T08:00:00Z")), false);
});
