// Database persistence for agent fleets (agent-fleet-core).
//
// Two tables: fleets (the organization) and fleet_members (the stable posts —
// ADR-0031: a member row IS the post; the incumbent rides targetKind/targetId
// and can be swapped without touching the row's identity, tree position, or
// KPI slot declarations). Storage pattern mirrors clusters-db.js (per-cell
// sqlite file, WAL, snake_case columns, camelCase API).

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { storeDir } from "../../paths.js";

export const FLEET_STATES = ["active", "paused", "archived"];
export const MEMBER_TARGET_KINDS = ["persona", "cluster", "a2a"];

export function createFleetDatabase({ file } = {}) {
  const dbPath = file || path.join(storeDir("data"), "fleets.db");

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`CREATE TABLE IF NOT EXISTS fleets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS fleet_members (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    title TEXT NOT NULL,
    parent_id TEXT,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kpi_slots TEXT NOT NULL DEFAULT '[]',
    cadence TEXT,
    sort_key INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_fleet ON fleet_members(fleet_id)`);
  // Unique-post check (design D8): "is this persona/cluster on duty anywhere?"
  // scans by target, so index the pair.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_target ON fleet_members(target_kind, target_id)`);

  // ── fleets ────────────────────────────────────────────────────────────────

  function createFleet(fleet) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleets (id, name, owner_email, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fleet.id, fleet.name, fleet.ownerEmail, fleet.state || "active", now, now);
    return { ...fleet, state: fleet.state || "active", createdAt: now, updatedAt: now };
  }

  function getFleet(id) {
    const row = db.prepare("SELECT * FROM fleets WHERE id = ?").get(id);
    return row ? deserializeFleet(row) : null;
  }

  function updateFleet(id, updates) {
    const COLUMNS = { name: "name", state: "state" };
    const setParts = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      const col = COLUMNS[key];
      if (!col) continue;
      setParts.push(`${col} = ?`);
      values.push(value);
    }
    if (setParts.length === 0) return null;
    setParts.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE fleets SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    return getFleet(id);
  }

  function listFleets({ ownerEmail = null } = {}) {
    const rows = ownerEmail
      ? db.prepare("SELECT * FROM fleets WHERE owner_email = ? ORDER BY created_at DESC").all(ownerEmail)
      : db.prepare("SELECT * FROM fleets ORDER BY created_at DESC").all();
    return rows.map(deserializeFleet);
  }

  // ── members ───────────────────────────────────────────────────────────────

  function createMember(member) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleet_members (id, fleet_id, title, parent_id, target_kind, target_id, kpi_slots, cadence, sort_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.id,
      member.fleetId,
      member.title,
      member.parentId ?? null,
      member.targetKind,
      member.targetId,
      JSON.stringify(member.kpiSlots ?? []),
      member.cadence ? JSON.stringify(member.cadence) : null,
      Number.isFinite(member.sortKey) ? member.sortKey : now,
      now,
      now,
    );
    return getMember(member.id);
  }

  function getMember(id) {
    const row = db.prepare("SELECT * FROM fleet_members WHERE id = ?").get(id);
    return row ? deserializeMember(row) : null;
  }

  function listMembers(fleetId) {
    return db
      .prepare("SELECT * FROM fleet_members WHERE fleet_id = ? ORDER BY sort_key, created_at")
      .all(fleetId)
      .map(deserializeMember);
  }

  function updateMember(id, updates) {
    const JSON_COLUMNS = { kpiSlots: "kpi_slots", cadence: "cadence" };
    const PLAIN_COLUMNS = {
      title: "title",
      parentId: "parent_id",
      sortKey: "sort_key",
      // Restaff (swap, ADR-0031): the incumbent ref is the one mutable
      // identity-adjacent field — everything else on the row is post history.
      targetKind: "target_kind",
      targetId: "target_id",
    };
    const setParts = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      const jsonCol = JSON_COLUMNS[key];
      const plainCol = PLAIN_COLUMNS[key];
      if (jsonCol) {
        setParts.push(`${jsonCol} = ?`);
        values.push(value === null ? null : JSON.stringify(value));
      } else if (plainCol) {
        setParts.push(`${plainCol} = ?`);
        values.push(value);
      }
    }
    if (setParts.length === 0) return null;
    setParts.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE fleet_members SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    return getMember(id);
  }

  function deleteMember(id) {
    const result = db.prepare("DELETE FROM fleet_members WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // Unique-post lookup (design D8): where is this persona/cluster on duty?
  // Cell-global across fleets; a2a targets never call this (multi-post).
  function findPostByTarget(targetKind, targetId, { excludeMemberId = null } = {}) {
    const rows = db
      .prepare("SELECT * FROM fleet_members WHERE target_kind = ? AND target_id = ?")
      .all(targetKind, targetId);
    const hit = rows.find((r) => r.id !== excludeMemberId);
    if (!hit) return null;
    const fleet = getFleet(hit.fleet_id);
    return { member: deserializeMember(hit), fleet };
  }

  function close() {
    db.close();
  }

  return {
    db,
    createFleet,
    getFleet,
    updateFleet,
    listFleets,
    createMember,
    getMember,
    listMembers,
    updateMember,
    deleteMember,
    findPostByTarget,
    close,
  };
}

function deserializeFleet(row) {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeMember(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    title: row.title,
    parentId: row.parent_id ?? null,
    targetKind: row.target_kind,
    targetId: row.target_id,
    kpiSlots: JSON.parse(row.kpi_slots || "[]"),
    cadence: row.cadence ? JSON.parse(row.cadence) : null,
    sortKey: row.sort_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Export singleton (server.js uses the default per-cell file; tests inject).
let fleetDb = null;

export function getFleetDatabase() {
  if (!fleetDb) {
    fleetDb = createFleetDatabase({});
  }
  return fleetDb;
}

export function setFleetDatabase(db) {
  fleetDb = db;
}
