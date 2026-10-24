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
export const MEMBER_TARGET_KINDS = ["persona", "cluster", "a2a", "tool"];

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

  // Report lane (agent-fleet-report-lane): append-only status reports. One row
  // per report_status call (source=self) or per finished a2a turn (source=
  // derived — the execution summary). latest/timeline are query-time
  // aggregations; nothing is ever mutated here.
  db.exec(`CREATE TABLE IF NOT EXISTS member_reports (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    session_id TEXT,
    metrics TEXT NOT NULL DEFAULT '{}',
    resources TEXT NOT NULL DEFAULT '[]',
    blockers TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'self',
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_member_reports_member ON member_reports(member_id, created_at)`);

  // Decision lane (agent-fleet-decision-lane): the owner's approval queue.
  // State machine: open → approved|rejected → delivered; open → expired →
  // (owner reopens) → open. `resolution` is JSON {kind, choice?, note?, by,
  // at}; expiry is fleet-policy driven (suggestedDeadline is display-only).
  db.exec(`CREATE TABLE IF NOT EXISTS decision_items (
    id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'normal',
    suggested_deadline TEXT,
    recommendation TEXT,
    state TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    source_session_id TEXT,
    submitted_at INTEGER NOT NULL,
    resolved_at INTEGER,
    delivered_at INTEGER,
    delivered_session_id TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_items_fleet_state ON decision_items(fleet_id, state)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decision_items_member ON decision_items(member_id, state)`);

  // Existing fleets gain the decision policy column (fleet-level expiry; the
  // design default is 72h, 0 = off — never per-post deadlines).
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN decision_policy TEXT`);
  } catch {
    /* column already exists */
  }
  // Template provenance (agent-fleet-templates D5): the packId+version a
  // fleet was instantiated from — the dedup anchor for re-installs and the
  // "template has a newer version" notice (D7: notice only, never migrates).
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN source_template TEXT`);
  } catch {
    /* column already exists */
  }

  // Post-level models (add-fleet-post-model D9): nullable declarations — the
  // member's primary + fallback and the fleet default that doubles as the
  // availability fallback. Nullable by design: unset = inherit down the
  // resolution chain, so a rolled-back deployment needs no data migration.
  try {
    db.exec(`ALTER TABLE fleet_members ADD COLUMN model TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE fleet_members ADD COLUMN fallback_model TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN default_model TEXT`);
  } catch {
    /* column already exists */
  }
  // Orchestration section (add-fleet-orchestration): the declarative edge
  // grammar — nullable, JSON, validated at the route write face. Unset =
  // schedule = byte-identical behavior.
  try {
    db.exec(`ALTER TABLE fleets ADD COLUMN orchestration TEXT`);
  } catch {
    /* column already exists */
  }

  // Fleet row audit (add-fleet-row-update-audit): the DB-layer half. An
  // AFTER UPDATE trigger catches EVERY writer — including processes outside
  // the platform: a bare sqlite UPDATE leaves no application log, which is
  // why the 2026-10-24 orchestration resets could not be attributed. The
  // trigger records WHAT changed; the application half (updateFleet's meta)
  // backfills actor/via on the row it just caused. Trigger-with-attribution =
  // an in-platform write; trigger-without = out-of-process — the
  // adjudication rule for the next recurrence. updated_at is excluded: it is
  // dirty on every write and carries no signal.
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_row_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    fleet_id TEXT NOT NULL,
    changed_columns TEXT NOT NULL,
    orchestration_old TEXT,
    orchestration_new TEXT,
    actor TEXT,
    via TEXT
  )`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fleets_audit_after_update
    AFTER UPDATE ON fleets
    BEGIN
      INSERT INTO fleet_row_audit (ts, fleet_id, changed_columns, orchestration_old, orchestration_new)
      VALUES (
        CAST(strftime('%s','now') AS INTEGER) * 1000,
        NEW.id,
        '[' || trim(
          CASE WHEN NEW.name IS NOT OLD.name THEN '"name",' ELSE '' END ||
          CASE WHEN NEW.state IS NOT OLD.state THEN '"state",' ELSE '' END ||
          CASE WHEN NEW.decision_policy IS NOT OLD.decision_policy THEN '"decision_policy",' ELSE '' END ||
          CASE WHEN NEW.source_template IS NOT OLD.source_template THEN '"source_template",' ELSE '' END ||
          CASE WHEN NEW.default_model IS NOT OLD.default_model THEN '"default_model",' ELSE '' END ||
          CASE WHEN NEW.orchestration IS NOT OLD.orchestration THEN '"orchestration",' ELSE '' END
        , ',') || ']',
        OLD.orchestration,
        NEW.orchestration
      );
    END
  `);

  // Turn result events (add-fleet-turn-events): append-only per-turn outcome
  // records — one row per finished member turn (cron / manual / delegation),
  // written at the runCronJobTurn seam. System records, never agent-authored:
  // reports are content, these are facts. Bounded by rolling prune per member
  // (appendTurnEvent); reports and decisions never share this store.
  db.exec(`CREATE TABLE IF NOT EXISTS member_turn_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fleet_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    error_kind TEXT,
    error TEXT,
    model TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    session_id TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_member ON member_turn_events(member_id, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_fleet ON member_turn_events(fleet_id, status, id)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_fleet ON fleet_members(fleet_id)`);
  // Unique-post check (design D8): "is this persona/cluster on duty anywhere?"
  // scans by target, so index the pair.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_target ON fleet_members(target_kind, target_id)`);

  // ── fleets ────────────────────────────────────────────────────────────────

  function createFleet(fleet) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleets (id, name, owner_email, state, decision_policy, source_template, default_model, orchestration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fleet.id,
      fleet.name,
      fleet.ownerEmail,
      fleet.state || "active",
      fleet.decisionPolicy ? JSON.stringify(fleet.decisionPolicy) : null,
      fleet.sourceTemplate ? JSON.stringify(fleet.sourceTemplate) : null,
      fleet.defaultModel ?? null,
      fleet.orchestration ? JSON.stringify(fleet.orchestration) : null,
      now,
      now,
    );
    return getFleet(fleet.id);
  }

  function getFleet(id) {
    const row = db.prepare("SELECT * FROM fleets WHERE id = ?").get(id);
    return row ? deserializeFleet(row) : null;
  }

  function updateFleet(id, updates, meta = null) {
    const COLUMNS = { name: "name", state: "state", defaultModel: "default_model" };
    const setParts = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      const col = COLUMNS[key];
      if (!col) continue;
      setParts.push(`${col} = ?`);
      values.push(value);
    }
    if (keyIsDecisionPolicy(updates)) {
      setParts.push("decision_policy = ?");
      values.push(JSON.stringify(updates.decisionPolicy));
    }
    if (Object.hasOwn(updates, "orchestration")) {
      setParts.push("orchestration = ?");
      values.push(updates.orchestration ? JSON.stringify(updates.orchestration) : null);
    }
    if (Object.hasOwn(updates, "sourceTemplate")) {
      setParts.push("source_template = ?");
      values.push(updates.sourceTemplate ? JSON.stringify(updates.sourceTemplate) : null);
    }
    if (setParts.length === 0) return null;
    const before = getFleet(id);
    setParts.push("updated_at = ?");
    values.push(Date.now(), id);
    db.prepare(`UPDATE fleets SET ${setParts.join(", ")} WHERE id = ?`).run(...values);
    // Attribution half (add-fleet-row-update-audit): stamp the audit row this
    // UPDATE just caused — better-sqlite3 is synchronous on one connection,
    // so MAX(id) is this call's row. Callers without meta leave actor NULL:
    // that NULL is the out-of-process marker, never overwritten.
    if (meta && (meta.actor != null || meta.via != null)) {
      db.prepare("UPDATE fleet_row_audit SET actor = ?, via = ? WHERE id = (SELECT MAX(id) FROM fleet_row_audit)").run(
        meta.actor ?? null,
        meta.via ?? null,
      );
    }
    // A non-null → null orchestration reset outside the owner's own
    // /api/fleets session is the incident signature (2026-10-24, twice).
    if (
      before &&
      before.orchestration != null &&
      Object.hasOwn(updates, "orchestration") &&
      updates.orchestration == null
    ) {
      const owner = String(before.ownerEmail || "").trim().toLowerCase();
      const actor = meta?.actor != null ? String(meta.actor).trim().toLowerCase() : null;
      const ownerHttpSession = actor != null && actor === owner && typeof meta.via === "string" && meta.via.includes("/api/fleets");
      if (!ownerHttpSession) {
        console.warn(`[fleet-audit] orchestration reset to null: fleet=${id} actor=${meta?.actor ?? "unknown"} via=${meta?.via ?? "(no attribution)"}`);
      }
    }
    return getFleet(id);
  }

  // Template-anchor dedup (D5): a fleet instantiated from this pack by this
  // owner. Archived fleets do not block a fresh instantiation.
  function findFleetByTemplate(packId, ownerEmail) {
    const rows = db
      .prepare("SELECT * FROM fleets WHERE owner_email = ? AND source_template IS NOT NULL")
      .all(ownerEmail);
    for (const row of rows) {
      const t = JSON.parse(row.source_template || "null");
      if (t?.packId === packId && row.state !== "archived") return deserializeFleet(row);
    }
    return null;
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
      INSERT INTO fleet_members (id, fleet_id, title, parent_id, target_kind, target_id, kpi_slots, cadence, model, fallback_model, sort_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.id,
      member.fleetId,
      member.title,
      member.parentId ?? null,
      member.targetKind,
      member.targetId,
      JSON.stringify(member.kpiSlots ?? []),
      member.cadence ? JSON.stringify(member.cadence) : null,
      member.model ?? null,
      member.fallbackModel ?? null,
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
      model: "model",
      fallbackModel: "fallback_model",
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

  // ── member reports (append-only) ──────────────────────────────────────────

  function appendReport(report) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO member_reports (id, fleet_id, member_id, session_id, metrics, resources, blockers, summary, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.id,
      report.fleetId,
      report.memberId,
      report.sessionId ?? null,
      JSON.stringify(report.metrics ?? {}),
      JSON.stringify(report.resources ?? []),
      JSON.stringify(report.blockers ?? []),
      report.summary,
      report.source || "self",
      report.createdAt ?? now,
    );
    return deserializeReport(db.prepare("SELECT * FROM member_reports WHERE id = ?").get(report.id));
  }

  function getReport(id) {
    const row = db.prepare("SELECT * FROM member_reports WHERE id = ?").get(id);
    return row ? deserializeReport(row) : null;
  }

  // Latest report per member for a whole fleet (one query — cells are small).
  function latestReports(fleetId) {
    const rows = db
      .prepare("SELECT * FROM member_reports WHERE fleet_id = ? ORDER BY created_at DESC, id DESC")
      .all(fleetId);
    const byMember = new Map();
    for (const row of rows) {
      if (!byMember.has(row.member_id)) byMember.set(row.member_id, deserializeReport(row));
    }
    return byMember;
  }

  function latestReportFor(memberId) {
    const row = db
      .prepare("SELECT * FROM member_reports WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(memberId);
    return row ? deserializeReport(row) : null;
  }

  // The report immediately BEFORE a given timestamp — the trend baseline.
  function previousReport(memberId, beforeMs) {
    const row = db
      .prepare("SELECT * FROM member_reports WHERE member_id = ? AND created_at < ? AND source = 'self' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(memberId, beforeMs);
    return row ? deserializeReport(row) : null;
  }

  // Timeline page, newest first; `beforeMs` (exclusive) pages via the last
  // row's createdAt.
  function listReports(memberId, { beforeMs = null, limit = 20 } = {}) {
    const rows = beforeMs == null
      ? db.prepare("SELECT * FROM member_reports WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(memberId, limit)
      : db.prepare("SELECT * FROM member_reports WHERE member_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?").all(memberId, beforeMs, limit);
    return rows.map(deserializeReport);
  }

  // Flood control: how many reports this member filed inside the window.
  function countReportsSince(memberId, sinceMs) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM member_reports WHERE member_id = ? AND created_at > ? AND source = 'self'")
      .get(memberId, sinceMs).n;
  }

  // ── decision items ────────────────────────────────────────────────────────

  function appendDecision(item) {
    db.prepare(`
      INSERT INTO decision_items (id, fleet_id, member_id, question, options, severity, suggested_deadline, recommendation, state, resolution, source_session_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)
    `).run(
      item.id,
      item.fleetId,
      item.memberId,
      item.question,
      JSON.stringify(item.options ?? []),
      item.severity || "normal",
      item.suggestedDeadline ?? null,
      item.recommendation ?? null,
      item.sourceSessionId ?? null,
      item.submittedAt ?? Date.now(),
    );
    return getDecision(item.id);
  }

  function getDecision(id) {
    const row = db.prepare("SELECT * FROM decision_items WHERE id = ?").get(id);
    return row ? deserializeDecision(row) : null;
  }

  function listDecisions({ fleetId, state = null, memberId = null, pendingDeliveryFor = null } = {}) {
    const where = ["fleet_id = ?"];
    const args = [fleetId];
    if (state) {
      where.push("state = ?");
      args.push(state);
    }
    if (memberId) {
      where.push("member_id = ?");
      args.push(memberId);
    }
    if (pendingDeliveryFor) {
      // Approved/rejected items of ONE post still awaiting their delivery
      // turn, oldest resolution first (the injection order).
      where.push("member_id = ?", "state IN ('approved','rejected')", "delivered_at IS NULL");
      args.push(pendingDeliveryFor);
      return db
        .prepare(`SELECT * FROM decision_items WHERE ${where.join(" AND ")} ORDER BY resolved_at ASC, id ASC`)
        .all(...args)
        .map(deserializeDecision);
    }
    return db
      .prepare(`SELECT * FROM decision_items WHERE ${where.join(" AND ")} ORDER BY submitted_at DESC, id DESC`)
      .all(...args)
      .map(deserializeDecision);
  }

  function countOpenDecisions(fleetId) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM decision_items WHERE fleet_id = ? AND state = 'open'")
      .get(fleetId).n;
  }

  function countDecisionsByMemberSince(memberId, sinceMs) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM decision_items WHERE member_id = ? AND submitted_at > ?")
      .get(memberId, sinceMs).n;
  }

  // Optimistic-concurrency transition (design D4): the UPDATE only lands when
  // the row is still in `expectedState` — the first resolution wins, a losing
  // concurrent writer reads null and reports the conflict.
  function transitionDecision(id, expectedState, patch, { expectDeliveredNull = false } = {}) {
    const setParts = [];
    const values = [];
    const JSON_COLS = { resolution: "resolution" };
    const PLAIN_COLS = { state: "state", deliveredAt: "delivered_at", deliveredSessionId: "delivered_session_id", resolvedAt: "resolved_at", submittedAt: "submitted_at", recommendation: "recommendation" };
    for (const [key, value] of Object.entries(patch)) {
      const jsonCol = JSON_COLS[key];
      const plainCol = PLAIN_COLS[key];
      if (jsonCol) {
        setParts.push(`${jsonCol} = ?`);
        values.push(value === null ? null : JSON.stringify(value));
      } else if (plainCol) {
        setParts.push(`${plainCol} = ?`);
        values.push(value);
      }
    }
    if (setParts.length === 0) return null;
    values.push(id, expectedState);
    const result = db
      .prepare(
        `UPDATE decision_items SET ${setParts.join(", ")} WHERE id = ? AND state = ?${
          expectDeliveredNull ? " AND delivered_at IS NULL" : ""
        }`,
      )
      .run(...values);
    return result.changes > 0 ? getDecision(id) : null;
  }

  // Fleet-policy expiry sweep (lazy on read + hourly backstop): open items
  // older than the policy window flip to expired and STAY listed. Returns the
  // flipped count (0 when the policy is off).
  function expireOpenDecisions(fleetId, { now = Date.now(), expiryHours } = {}) {
    // getFleet already normalizes the policy (camelCase, defaults filled);
    // read that, never the raw column again.
    const hours = expiryHours ?? (getFleet(fleetId)?.decisionPolicy ?? DEFAULT_DECISION_POLICY).expiryHours;
    if (!hours || hours <= 0) return 0;
    const cutoff = now - hours * 3600_000;
    const result = db
      .prepare("UPDATE decision_items SET state = 'expired' WHERE fleet_id = ? AND state = 'open' AND submitted_at < ?")
      .run(fleetId, cutoff);
    return result.changes;
  }

  // Delivery bookkeeping: mark this post's awaiting items delivered, once —
  // at most `limit` per finished turn, oldest resolution first, matching the
  // injector's per-turn cap (the rest roll to the next turn). Flips state to
  // `delivered` (delivery is a fact, not a new decision).
  function markDelivered(memberId, { now = Date.now(), sessionId = null, limit = 5 } = {}) {
    const ids = db
      .prepare(
        `SELECT id FROM decision_items
         WHERE member_id = ? AND state IN ('approved','rejected') AND delivered_at IS NULL
         ORDER BY resolved_at ASC, id ASC LIMIT ?`,
      )
      .all(memberId, limit)
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db
      .prepare(
        `UPDATE decision_items SET state = 'delivered', delivered_at = ?, delivered_session_id = ?
         WHERE id IN (${placeholders}) AND delivered_at IS NULL`,
      )
      .run(now, sessionId, ...ids);
    return result.changes;
  }

  // ── turn result events (append-only, pruned) ──────────────────────────────

  // Retention is read per call (same convention as the pack policy caps): an
  // operator can tighten it without a restart, an invalid value falls back.
  function turnEventKeep() {
    const n = Number(process.env.FLEET_TURN_EVENTS_KEEP);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  }

  function appendTurnEvent(event) {
    const out = db
      .prepare(`
        INSERT INTO member_turn_events (fleet_id, member_id, source, status, error_kind, error, model, started_at, ended_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.fleetId,
        event.memberId,
        event.source,
        event.status,
        event.errorKind ?? null,
        event.error ?? null,
        event.model ?? null,
        event.startedAt,
        event.endedAt,
        event.sessionId ?? null,
      );
    // Rolling prune: keep the newest N rows for this member only — the
    // oldest overflow goes; reports/decisions live in their own tables.
    db.prepare(`
      DELETE FROM member_turn_events
      WHERE member_id = ? AND id NOT IN (
        SELECT id FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(event.memberId, event.memberId, turnEventKeep());
    return deserializeTurnEvent(
      db.prepare("SELECT * FROM member_turn_events WHERE id = ?").get(out.lastInsertRowid),
    );
  }

  // Timeline page, newest first; `beforeId` (exclusive) pages via the last
  // row's id — same cursor shape as the report timeline.
  function listTurnEvents(memberId, { beforeId = null, limit = 20 } = {}) {
    const rows = beforeId == null
      ? db.prepare("SELECT * FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT ?").all(memberId, limit)
      : db.prepare("SELECT * FROM member_turn_events WHERE member_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(memberId, beforeId, limit);
    return rows.map(deserializeTurnEvent);
  }

  // Fleet-wide filter (status/source optional, validated by the route).
  function listFleetTurnEvents(fleetId, { status = null, source = null, limit = 50 } = {}) {
    const where = ["fleet_id = ?"];
    const args = [fleetId];
    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (source) {
      where.push("source = ?");
      args.push(source);
    }
    return db
      .prepare(`SELECT * FROM member_turn_events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit)
      .map(deserializeTurnEvent);
  }

  function latestTurnFor(memberId) {
    const row = db
      .prepare("SELECT * FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT 1")
      .get(memberId);
    return row ? deserializeTurnEvent(row) : null;
  }

  // Count failures walking back from the newest event; the first non-failure
  // (ok/interrupted) stops the run. Aggregated from the stream by design —
  // no counter storage (spec: 不要求独立计数).
  function consecutiveFailures(memberId) {
    const rows = db
      .prepare("SELECT status FROM member_turn_events WHERE member_id = ? ORDER BY id DESC")
      .all(memberId);
    let n = 0;
    for (const r of rows) {
      if (r.status !== "failed") break;
      n += 1;
    }
    return n;
  }

  // Unique-post lookup (design D8): where is this persona/cluster on duty?
  // Cell-global across LIVE fleets; a2a targets never call this (multi-post).
  // Archived (incl. dissolved) fleets release their incumbents — their member
  // rows survive as history, but a dead organization must not squat a live
  // agent (prod 2026-10-23: a dissolved walkthrough fleet blocked restaffing).
  function findPostByTarget(targetKind, targetId, { excludeMemberId = null } = {}) {
    const rows = db
      .prepare(
        `SELECT fm.* FROM fleet_members fm JOIN fleets f ON f.id = fm.fleet_id
         WHERE fm.target_kind = ? AND fm.target_id = ? AND f.state != 'archived'`,
      )
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
    appendReport,
    getReport,
    latestReports,
    latestReportFor,
    previousReport,
    listReports,
    countReportsSince,
    appendTurnEvent,
    listTurnEvents,
    listFleetTurnEvents,
    latestTurnFor,
    consecutiveFailures,
    appendDecision,
    getDecision,
    listDecisions,
    countOpenDecisions,
    countDecisionsByMemberSince,
    transitionDecision,
    findFleetByTemplate,
    expireOpenDecisions,
    markDelivered,
    close,
  };
}

function deserializeFleet(row) {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    state: row.state,
    decisionPolicy: decisionPolicyOfRow(row),
    sourceTemplate: row.source_template ? JSON.parse(row.source_template) : null,
    defaultModel: row.default_model ?? null,
    orchestration: row.orchestration ? JSON.parse(row.orchestration) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// The fleet-level decision policy: default 72h expiry, 10 escalations per
// post per day. `0` expiryHours disables expiry outright.
export const DEFAULT_DECISION_POLICY = { expiryHours: 72, dailyCapPerMember: 10 };

function decisionPolicyOfRow(row) {
  let parsed = null;
  if (typeof row.decision_policy === "string" && row.decision_policy) {
    try {
      parsed = JSON.parse(row.decision_policy);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_DECISION_POLICY };
  return {
    expiryHours:
      Number.isFinite(parsed.expiryHours) && parsed.expiryHours >= 0 ? parsed.expiryHours : DEFAULT_DECISION_POLICY.expiryHours,
    dailyCapPerMember:
      Number.isFinite(parsed.dailyCapPerMember) && parsed.dailyCapPerMember > 0
        ? parsed.dailyCapPerMember
        : DEFAULT_DECISION_POLICY.dailyCapPerMember,
  };
}

function keyIsDecisionPolicy(updates) {
  return Object.hasOwn(updates, "decisionPolicy");
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
    model: row.model ?? null,
    fallbackModel: row.fallback_model ?? null,
    sortKey: row.sort_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeReport(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    sessionId: row.session_id ?? null,
    metrics: JSON.parse(row.metrics || "{}"),
    resources: JSON.parse(row.resources || "[]"),
    blockers: JSON.parse(row.blockers || "[]"),
    summary: row.summary,
    source: row.source || "self",
    createdAt: row.created_at,
  };
}

function deserializeTurnEvent(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    source: row.source,
    status: row.status,
    errorKind: row.error_kind ?? null,
    error: row.error ?? null,
    model: row.model ?? null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sessionId: row.session_id ?? null,
  };
}

function deserializeDecision(row) {
  return {
    id: row.id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    question: row.question,
    options: JSON.parse(row.options || "[]"),
    severity: row.severity || "normal",
    suggestedDeadline: row.suggested_deadline ?? null,
    recommendation: row.recommendation ?? null,
    state: row.state || "open",
    resolution: row.resolution ? JSON.parse(row.resolution) : null,
    sourceSessionId: row.source_session_id ?? null,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at ?? null,
    deliveredAt: row.delivered_at ?? null,
    deliveredSessionId: row.delivered_session_id ?? null,
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
