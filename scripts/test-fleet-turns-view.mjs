// The architect's turn-diagnosis page (fix-tool-result-cost).
//
// `fleet_turns_read` shipped up to 100 rows pretty-printed with every field —
// 2.3MB across one cell's traces, third largest tool result after the handoff
// list and `read`. The page now carries the diagnosis fields compactly and says
// whether it was truncated, so a caller cannot mistake a page for the whole set.
//
// The MCP module spawns a stdio server at import, so the pure view lives in
// server/fleet-turns-view.js and this suite is its test face.
//
// Run: node --test scripts/test-fleet-turns-view.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const { shapeTurnsPage, TURNS_PAGE_DEFAULT, TURNS_PAGE_MAX } = await import("../server/fleet-turns-view.js");

const turn = (n, over = {}) => ({
  id: n,
  memberId: `m${n}`,
  source: "cron",
  status: "failed",
  errorKind: "timeout",
  error: "x".repeat(800),
  model: "deepseek",
  startedAt: 1000 + n,
  endedAt: 2000 + n,
  usage: { input: 1, output: 2 },
  turnId: `t${n}`,
  runId: "r1",
  parentTurnId: null,
  edgeKind: null,
  traceTurnId: "tr-1",
  detail: { kind: "turn_budget_exceeded", steps: 12 },
  ...over,
});

test("默认页与上限", () => {
  const body = shapeTurnsPage(Array.from({ length: 150 }, (_, i) => turn(i)));
  assert.equal(body.count, TURNS_PAGE_DEFAULT);
  assert.equal(body.page, TURNS_PAGE_DEFAULT);
  assert.equal(body.truncated, true);
  const big = shapeTurnsPage(Array.from({ length: 150 }, (_, i) => turn(i)), 9999);
  assert.equal(big.count, TURNS_PAGE_MAX, "clamped by the ceiling");
  assert.equal(shapeTurnsPage(Array.from({ length: 3 }, (_, i) => turn(i)), "abc").count, 3);
  assert.equal(shapeTurnsPage([], 10).truncated, false);
});

test("投影只留诊断字段，错误串有上限", () => {
  const [row] = shapeTurnsPage([turn(1)]).turns;
  for (const k of ["id", "memberId", "source", "status", "errorKind", "error", "model", "startedAt", "endedAt", "usage", "turnId", "runId", "parentTurnId", "edgeKind"]) {
    assert.ok(k in row, k);
  }
  assert.equal(row.error.length, 240, "an 800-char error is cut");
  assert.equal(row.traceTurnId, undefined, "internal ids do not ride the page");
  assert.equal(row.detail, undefined, "the executor's detail blob does not ride it either");
});

test("页比整份小一个数量级（这就是它存在的原因）", () => {
  const rows = Array.from({ length: 100 }, (_, i) => turn(i));
  const prettyBefore = JSON.stringify(rows, null, 2).length;
  const now = JSON.stringify(shapeTurnsPage(rows)).length;
  assert.ok(now * 8 < prettyBefore, `page ${now}B vs pretty ${prettyBefore}B`);
});
