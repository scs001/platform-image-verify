#!/usr/bin/env node
// reconcile-turn-pricing (add-turn-pricing ③, v1.1 subject §15.116挂账) — the
// estimate ↔ billing-truth reconciliation face. Run INSIDE the platform pod:
//
//   node scripts/reconcile-turn-pricing.mjs <owner-email> [YYYY-MM-DD] [--lane-key <key>]
//
// Platform side: the owner's cell's member_turn_daily estimates for the day
// (priced-sample口径 — only turns that carried a price contribute).
// 词元 side: the billing TRUTH (S3/S5: estimates never impersonate it).
//
// v1.1 subject (真机走查修正): the account that owns the LANE KEY — the key
// the platform's LLM calls actually ride — not the owner-email-derived
// account. In production the owner-derived account read $0 (the lane key's
// account ≠ the owner's account). Subject resolution order: --lane-key flag →
// env LLM_API_KEY (the pod's lane key) → owner email (v1口径, kept as the
// fallback and labelled when used). Output: the drift factor (est/actual),
// which absorbs everything v1 deliberately excludes — group rate multiplier,
// subscription discount, effort multipliers, unpriced samples, and non-fleet
// usage on the same account. A factor > 1.3 (WARN line) or < 0.7 prints a
// warning; calibration is a HUMAN decision — this script never writes anything.

import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createSub2apiClient } from "../lib/sub2api-admin.js";

// v1.1 subject resolution (§15.116挂账): the lane-key account is the billed
// account; the owner-email account is the documented v1 fallback (labelled —
// it can read $0 while real spend flows). Exported for the unit test; the
// module imports safely (the CLI face lives under the entry guard below).
export async function resolveSubject({ client: c, ownerEmail: email, explicitKey = null }) {
  const key = (explicitKey ?? "").trim() || process.env.LLM_API_KEY?.trim() || "";
  if (key) {
    const hit = await c.findUserByKey(key);
    if (hit) return { ...hit, via: explicitKey ? "--lane-key" : "env LLM_API_KEY" };
    console.error("[reconcile] lane key unresolved on the 词元 side (stale/ambiguous) — falling back to the owner-email subject (v1口径, may read $0)");
  } else {
    console.error("[reconcile] no lane key available (env LLM_API_KEY empty) — falling back to the owner-email subject (v1口径, may read $0)");
  }
  const found = await c.findUserByEmail(email);
  return found ? { ...found, via: "owner-email" } : null;
}

// The owner's cell: the gateway's cell registry (CELL_DATA_ROOT/cells-registry.db,
// table cell_registry) maps owner → cell id; the fleet DB lives at the 双层
// data path <CELL_DATA_ROOT>/<cellId>/data/data/fleets.db. The script runs in
// the PLATFORM pod — the gateway's registry db is mounted at /data/cells there
// (CELL_DATA_ROOT=/data/cells); locally it defaults to repo-root cell-data/.
export function ownerCellDb(email) {
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

async function main({ client, ownerEmail, day, laneKeyArg = null }) {
  const warnLine = Number(process.env.PRICING_DRIFT_WARN || 0.3);
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

  const subject = await resolveSubject({ client, ownerEmail, explicitKey: laneKeyArg });
  if (!subject) {
    console.error(`[reconcile] no sub2api account resolvable for ${ownerEmail} (lane key and email both miss)`);
    process.exit(1);
  }
  const truth = await client.readUserUsageToday(subject.userId);
  const actual = truth?.todayActualCost ?? null;

  const factor = est > 0 && actual != null && actual > 0 ? est / actual : null;
  const over = factor != null && Math.abs(factor - 1) > warnLine;
  console.log(`[reconcile] day=${day} owner=${ownerEmail} subject=${subject.email ?? subject.userId} (via ${subject.via})`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf("--lane-key");
  const laneKeyArg = flagIdx >= 0 ? (argv.splice(flagIdx, 2)[1] ?? "") : null;
  const [ownerEmail, dayArg] = argv;
  if (!ownerEmail) {
    console.error("usage: node scripts/reconcile-turn-pricing.mjs <owner-email> [YYYY-MM-DD] [--lane-key <key>]");
    process.exit(2);
  }
  const client = createSub2apiClient();
  if (client.degraded()) {
    console.error("[reconcile] SUB2API_ADMIN_KEY not configured — cannot read the billing truth");
    process.exit(1);
  }
  main({ client, ownerEmail, day: dayArg ?? new Date().toISOString().slice(0, 10), laneKeyArg }).catch((e) => {
    console.error(`[reconcile] failed: ${e?.message || e}`);
    process.exit(1);
  });
}
