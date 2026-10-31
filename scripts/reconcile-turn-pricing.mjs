#!/usr/bin/env node
// reconcile-turn-pricing (add-turn-pricing ③) — the estimate ↔ billing-truth
// reconciliation face. Run INSIDE the platform pod:
//
//   node scripts/reconcile-turn-pricing.mjs <owner-email> [YYYY-MM-DD]
//
// Platform side: the owner's cell's member_turn_daily estimates for the day
// (priced-sample口径 — only turns that carried a price contribute).
// 词元 side: the owner's sub2api account's today_actual_cost (the billing
// TRUTH — S3/S5: estimates never impersonate it). Output: the drift factor
// (est/actual), which absorbs everything v1 deliberately excludes — group
// rate multiplier, subscription discount, effort multipliers, unpriced
// samples, and non-fleet usage on the same account. A factor > 1.3 (WARN
// line) or < 0.7 prints a warning; calibration is a HUMAN decision — this
// script never writes anything.

import path from "node:path";
import Database from "better-sqlite3";
import { createSub2apiClient } from "../lib/sub2api-admin.js";

const [ownerEmail, dayArg] = process.argv.slice(2);
if (!ownerEmail) {
  console.error("usage: node scripts/reconcile-turn-pricing.mjs <owner-email> [YYYY-MM-DD]");
  process.exit(2);
}
const day = dayArg ?? new Date().toISOString().slice(0, 10);
const warnLine = Number(process.env.PRICING_DRIFT_WARN || 0.3);

const client = createSub2apiClient();
if (client.degraded()) {
  console.error("[reconcile] SUB2API_ADMIN_KEY not configured — cannot read the billing truth");
  process.exit(1);
}

// The owner's cell: the gateway's cell registry (CELL_DATA_ROOT/cells-registry.db,
// table cell_registry) maps owner → cell id; the fleet DB lives at the 双层
// data path <CELL_DATA_ROOT>/<cellId>/data/data/fleets.db. The script runs in
// the PLATFORM pod — the gateway's registry db is mounted at /data/cells there
// (CELL_DATA_ROOT=/data/cells); locally it defaults to repo-root cell-data/.
function ownerCellDb(email) {
  const root = path.resolve(process.env.CELL_DATA_ROOT || "cell-data");
  const reg = new Database(path.join(root, "cells-registry.db"), { readonly: true });
  try {
    const row = reg.prepare("SELECT cell_id, owner_email FROM cell_registry WHERE lower(owner_email) = lower(?)").get(email);
    if (!row) return null;
    return path.join(root, row.cell_id, "data", "data", "fleets.db");
  } finally {
    reg.close();
  }
}

// The owner's sub2api account id (ADR-0011 door — email resolution probed
// 2026-10-02/03).
async function ownerUserId(email) {
  const found = await client.findUserByEmail(email);
  return found?.userId ?? null;
}

async function main() {
  const dbFile = ownerCellDb(ownerEmail);
  if (!dbFile) {
    console.error(`[reconcile] no cell found for ${ownerEmail}`);
    process.exit(1);
  }
  const db = new Database(dbFile, { readonly: true });
  const rows = db
    .prepare(
      `SELECT member_id, carrier, provider, model, turns,
              SUM(usage_input + usage_cached_input + usage_cache_write) AS billed_input,
              SUM(usage_output) AS output,
              SUM(cost_input_usd + cost_output_usd + cost_cache_write_usd + cost_cache_read_usd) AS est_usd,
              SUM(CASE WHEN pricing_at IS NOT NULL THEN 1 ELSE 0 END) AS priced_turns
       FROM member_turn_daily
       WHERE day = ? AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = member_turn_daily.fleet_id AND lower(f.owner_email) = lower(?))
       GROUP BY member_id, carrier, provider, model
       ORDER BY est_usd DESC`,
    )
    .all(day, ownerEmail);
  db.close();

  const est = rows.reduce((acc, r) => acc + (r.est_usd ?? 0), 0);
  const turns = rows.reduce((acc, r) => acc + (r.turns ?? 0), 0);
  const priced = rows.reduce((acc, r) => acc + (r.priced_turns ?? 0), 0);

  const userId = await ownerUserId(ownerEmail);
  if (!userId) {
    console.error(`[reconcile] no sub2api account for ${ownerEmail}`);
    process.exit(1);
  }
  const truth = await client.readUserUsageToday(userId);
  const actual = truth?.todayActualCost ?? null;

  const factor = est > 0 && actual != null && actual > 0 ? est / actual : null;
  const over = factor != null && Math.abs(factor - 1) > warnLine;
  console.log(`[reconcile] day=${day} owner=${ownerEmail}`);
  console.log(`  platform estimate : $${est.toFixed(4)} (priced ${priced}/${turns} turn-days)`);
  console.log(`  词元 actual (today): ${actual == null ? "unavailable" : "$" + actual.toFixed(4)}`);
  console.log(`  drift factor (est/actual): ${factor == null ? "n/a" : factor.toFixed(3)}${over ? "  ⚠️ beyond the ±30% line" : ""}`);
  if (rows.length) {
    console.log("  top contributors:");
    for (const r of rows.slice(0, 5)) {
      console.log(`    ${r.member_id} ${r.carrier ?? "-"} ${r.model ?? "-"} ×${r.turns} est=$${(r.est_usd ?? 0).toFixed(4)}`);
    }
  }
  if (over) console.warn(`[reconcile] WARN drift ${factor.toFixed(3)} beyond ±${warnLine} — v1 excludes group multiplier/discount/effort/unpriced samples; calibration is a human call`);
}

main().catch((e) => {
  console.error(`[reconcile] failed: ${e?.message || e}`);
  process.exit(1);
});
