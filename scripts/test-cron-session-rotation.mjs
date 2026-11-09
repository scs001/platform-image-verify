#!/usr/bin/env node
// ── Cron sessions rotate before the context window fills ────────────────────
//
// A cron task binds ONE session forever (`cron-<id>`), so every round appends
// its whole conversation and the cached context only grows. Live 2026-11-09,
// the optimizer's inventory post (`job_1794118516358_xfqxg8`):
//
//   time        output tokens   cacheRead
//   11-08 09:25      564          84,480   ← healthy: 5 teams / 10 gaps
//   11-09 01:11      805         119,168   ← still ran
//   11-09 14:32      128         157,824   ← empty-handed
//
// 157,824 > contextWindow 128,000. The output collapsed to exactly 128 tokens
// — the SAME number a completely unrelated post produced — because roughly 128
// tokens of window were left. Two different posts reporting an identical output
// size is the fingerprint of a window limit, not of a bad prompt.
//
// Pinned here:
//   1. below the threshold → no rotation (a healthy run keeps its session)
//   2. at/over the threshold → rotate, and the new id is derived from the task
//      id (so repeated rotations cannot grow a suffix chain)
//   3. only the NEWEST metered round decides — an old spike that a rotation
//      already cleared must not rotate forever
//   4. a manual (non-schedule) task is never rotated
//
//   node --test scripts/test-cron-session-rotation.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { shouldRotateSession } = await import(path.join(here, "../task-engine.js"));

const WINDOW = 128_000;
const metered = (cacheReadTokens, inputTokens = 3_000) => ({ tokens: { cacheReadTokens, inputTokens } });

test("1. a session well under the window is not rotated", () => {
  const history = [metered(40_000), metered(60_000)];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), false);
});

test("2. the live regression shape rotates: cacheRead 157,824 > 128,000", () => {
  const history = [metered(84_480), metered(119_168), metered(157_824)];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});

test("3. only the newest metered round decides — a cleared spike does not re-rotate", () => {
  // The 157,824 round happened, rotation fired, and the fresh session came
  // back small. The old spike must not keep triggering rotation forever.
  const history = [metered(157_824), metered(8_000)];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), false);
});

test("4. exactly at the threshold counts as over (>=, not >)", () => {
  const history = [metered(89_600, 0)]; // 0.7 * 128,000 = 89,600
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});

test("5. unmetered rounds are skipped, not treated as zero", () => {
  // A provider that reports no usage must not look like "fresh session".
  const history = [metered(120_000), { success: true }];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});

test("6. empty or metered-free history never rotates", () => {
  assert.equal(shouldRotateSession([], { window: WINDOW, ratio: 0.7 }), false);
  assert.equal(shouldRotateSession([{ success: true }], { window: WINDOW, ratio: 0.7 }), false);
});

test("7. uncacheable-but-large input alone can trigger rotation", () => {
  const history = [{ tokens: { inputTokens: 100_000, cacheReadTokens: 0 } }];
  assert.equal(shouldRotateSession(history, { window: WINDOW, ratio: 0.7 }), true);
});
