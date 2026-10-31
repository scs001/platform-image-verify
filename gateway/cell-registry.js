// ── Gateway cell registry, durable (add-cell-lifecycle 3.1) ────────────────
//
// SQLite twin of the steward's JSON ledger: one row per cell, ONE file at
// <CELL_DATA_ROOT>/cells-registry.db (never inside packs.db — that store has
// its own owner and schema cadence). Row shape and migrations come from
// lib/cell-registry.js; lifecycle words come from lib/cell-lifecycle.js.
// Everything a gateway restart needs to rebuild the demand surface is HERE —
// never in the process (spec: roll must go quiet→complete without traffic).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrateRegistryRow, newRegistryRow, REGISTRY_SCHEMA_VERSION } from "../lib/cell-registry.js";
import { transition } from "../lib/cell-lifecycle.js";

const DDL = `
CREATE TABLE IF NOT EXISTS cell_registry (
  cell_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  owner_email TEXT,
  state TEXT NOT NULL,
  policy TEXT NOT NULL,
  workload_json TEXT NOT NULL DEFAULT '{}',
  last_user_traffic_at INTEGER,
  last_duty_run_at INTEGER,
  last_bound_at INTEGER,
  destroy_reason TEXT,
  destroy_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export function createCellRegistryDb({ file }) {
  // The durable registry is the gateway's first write to CELL_DATA_ROOT — on a
  // cold deployment (or a test boot) that directory may not exist yet, and
  // better-sqlite3 throws "directory does not exist" rather than creating it.
  // Same discipline as createPackRegistry/createShareRegistry above.
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(DDL);

  const serialize = (row) => ({
    cell_id: row.cellId,
    schema_version: row.schemaVersion,
    owner_email: row.ownerEmail ?? null,
    state: row.state,
    policy: row.policy,
    workload_json: JSON.stringify(row.workload ?? {}),
    last_user_traffic_at: row.lastUserTrafficAt ?? null,
    last_duty_run_at: row.lastDutyRunAt ?? null,
    last_bound_at: row.lastBoundAt ?? null,
    destroy_reason: row.destroy?.reason ?? null,
    destroy_at: row.destroy?.at ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
  const deserialize = (r) => {
    if (!r) return null;
    return migrateRegistryRow({
      cellId: r.cell_id,
      ownerEmail: r.owner_email,
      state: r.state,
      policy: r.policy,
      workload: JSON.parse(r.workload_json || "{}"),
      lastUserTrafficAt: r.last_user_traffic_at,
      lastDutyRunAt: r.last_duty_run_at,
      lastBoundAt: r.last_bound_at,
      destroy: r.destroy_reason || r.destroy_at ? { reason: r.destroy_reason, at: r.destroy_at } : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })?.row ?? null;
  };

  return {
    get(cellId) {
      return deserialize(db.prepare("SELECT * FROM cell_registry WHERE cell_id = ?").get(cellId));
    },
    all() {
      return db.prepare("SELECT * FROM cell_registry ORDER BY created_at").all().map(deserialize).filter(Boolean);
    },
    put(row) {
      const s = serialize({ ...row, schemaVersion: REGISTRY_SCHEMA_VERSION, updatedAt: Date.now() });
      db.prepare(`
        INSERT INTO cell_registry (cell_id, schema_version, owner_email, state, policy, workload_json,
          last_user_traffic_at, last_duty_run_at, last_bound_at, destroy_reason, destroy_at, created_at, updated_at)
        VALUES (@cell_id, @schema_version, @owner_email, @state, @policy, @workload_json,
          @last_user_traffic_at, @last_duty_run_at, @last_bound_at, @destroy_reason, @destroy_at, @created_at, @updated_at)
        ON CONFLICT(cell_id) DO UPDATE SET
          schema_version=excluded.schema_version, owner_email=COALESCE(excluded.owner_email, cell_registry.owner_email),
          state=excluded.state, policy=excluded.policy, workload_json=excluded.workload_json,
          last_user_traffic_at=COALESCE(excluded.last_user_traffic_at, cell_registry.last_user_traffic_at),
          last_duty_run_at=COALESCE(excluded.last_duty_run_at, cell_registry.last_duty_run_at),
          last_bound_at=COALESCE(excluded.last_bound_at, cell_registry.last_bound_at),
          destroy_reason=excluded.destroy_reason, destroy_at=excluded.destroy_at, updated_at=excluded.updated_at
      `).run(s);
      return this.get(row.cellId);
    },
    // One lifecycle step: read → transition → persist. Returns the same
    // { state, actions } the executor then performs (spawn/drain/…).
    fire(cellId, event, { policy = null } = {}) {
      const current = this.get(cellId);
      const chosenPolicy = current?.policy ?? policy ?? "on_demand";
      const t = transition(current ?? (event.type === "register" ? null : newRegistryRow({ cellId, ownerEmail: event.ownerEmail ?? null, policy: chosenPolicy })), event);
      if (t.error) return { error: t.error, row: current };
      const persisted = this.put({
        // First-ever contact materializes a full row; beats on it only move
        // the lifecycle fields the transition changed.
        ...(current ? t.row : newRegistryRow({ cellId, policy: chosenPolicy })),
        ...t.row,
        cellId,
        policy: t.row.policy ?? chosenPolicy,
        ownerEmail: t.row.ownerEmail ?? event.ownerEmail ?? current?.ownerEmail ?? null,
      });
      return { state: t.state, actions: t.actions, row: persisted };
    },
    close() { db.close(); },
  };
}
