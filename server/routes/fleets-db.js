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
  // Config dimensions beyond the model (add-agent-config-dims): thinking depth
  // and a per-turn context budget, declared at post AND fleet level with the
  // same inherit-down semantics as models. Nullable by design — unset = inherit
  // = byte-identical to before, and a rollback needs no data migration.
  for (const col of [
    "ALTER TABLE fleet_members ADD COLUMN effort TEXT",
    "ALTER TABLE fleet_members ADD COLUMN context_budget INTEGER",
    "ALTER TABLE fleets ADD COLUMN effort TEXT",
    "ALTER TABLE fleets ADD COLUMN context_budget INTEGER",
  ]) {
    try {
      db.exec(col);
    } catch {
      /* column already exists */
    }
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

  // Run ledger (add-fleet-cockpit-v2, agent-fleet-runs D1/D2): the execution
  // instance. One header row per run; the turn rows carry run_id plus their
  // chain position (parent_turn_id × edge_kind), so an edge instance IS the
  // downstream turn row — no hops table. `turn_id` is minted when the turn
  // STARTS (dispatch happens mid-turn and needs the upstream id before the row
  // exists) and is distinct from the autoincrement `id`, which keeps the table
  // append-only. Everything is additive and nullable: pre-v2 rows read as v1
  // history (run_id null), a rollback needs no down-migration.
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_runs (
    run_id TEXT PRIMARY KEY,
    fleet_id TEXT NOT NULL,
    root_source TEXT NOT NULL,
    root_member_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open',
    turns INTEGER NOT NULL DEFAULT 0,
    ok_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    usage_input INTEGER,
    usage_output INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_runs_fleet ON fleet_runs(fleet_id, started_at)`);
  for (const col of [
    "turn_id TEXT",
    "run_id TEXT",
    "parent_turn_id TEXT",
    "edge_kind TEXT",
    "usage_input INTEGER",
    "usage_output INTEGER",
    "trace_turn_id TEXT",
    // fix-fleet-turn-attribution D1: per-turn attribution summary (timeout
    // stalled/budget shape, degradedTo, laneId) as one JSON column — it is
    // read by row, never queried, and old rows read as honest absence.
    "detail TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE member_turn_events ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_events_turn_id ON member_turn_events(turn_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_run ON member_turn_events(run_id, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_events_member_ended ON member_turn_events(member_id, ended_at)`);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_fleet ON fleet_members(fleet_id)`);
  // Unique-post check (design D8): "is this persona/cluster on duty anywhere?"
  // scans by target, so index the pair.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fleet_members_target ON fleet_members(target_kind, target_id)`);

  // ── fleets ────────────────────────────────────────────────────────────────

  function createFleet(fleet) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO fleets (id, name, owner_email, state, decision_policy, source_template, default_model, effort, context_budget, orchestration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fleet.id,
      fleet.name,
      fleet.ownerEmail,
      fleet.state || "active",
      fleet.decisionPolicy ? JSON.stringify(fleet.decisionPolicy) : null,
      fleet.sourceTemplate ? JSON.stringify(fleet.sourceTemplate) : null,
      fleet.defaultModel ?? null,
      fleet.effort ?? null,
      Number.isFinite(fleet.contextBudget) ? fleet.contextBudget : null,
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
    const COLUMNS = { name: "name", state: "state", defaultModel: "default_model", effort: "effort", contextBudget: "context_budget" };
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
      INSERT INTO fleet_members (id, fleet_id, title, parent_id, target_kind, target_id, kpi_slots, cadence, model, fallback_model, effort, context_budget, sort_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      member.effort ?? null,
      Number.isFinite(member.contextBudget) ? member.contextBudget : null,
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
      effort: "effort",
      contextBudget: "context_budget",
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
  // Time window of the run ledger (agent-fleet-runs D10). A turn row is pruned
  // only when it is BOTH older than this window AND past the member's newest-N
  // floor — so a quiet post keeps its last 200 forever and a busy post keeps a
  // full month, whichever is more.
  function runRetentionMs() {
    const n = Number(process.env.FLEET_RUNS_RETENTION_DAYS);
    const days = Number.isFinite(n) && n >= 0 ? n : 30;
    return days * 86_400_000;
  }

  function appendTurnEvent(event) {
    const out = db
      .prepare(`
        INSERT INTO member_turn_events (fleet_id, member_id, source, status, error_kind, error, model, started_at, ended_at, session_id,
                                        turn_id, run_id, parent_turn_id, edge_kind, usage_input, usage_output, trace_turn_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        event.turnId ?? null,
        event.runId ?? null,
        event.parentTurnId ?? null,
        event.edgeKind ?? null,
        usageInt(event.usage?.input),
        usageInt(event.usage?.output),
        event.traceTurnId ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
      );
    // Dual-condition prune (agent-fleet-core, v2): only rows that are both
    // past the retention window AND beyond the member's newest-N floor go.
    db.prepare(`
      DELETE FROM member_turn_events
      WHERE member_id = ? AND ended_at < ? AND id NOT IN (
        SELECT id FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(event.memberId, Date.now() - runRetentionMs(), event.memberId, turnEventKeep());
    return deserializeTurnEvent(
      db.prepare("SELECT * FROM member_turn_events WHERE id = ?").get(out.lastInsertRowid),
    );
  }

  function getTurnEvent(turnId) {
    if (!turnId) return null;
    const row = db.prepare("SELECT * FROM member_turn_events WHERE turn_id = ?").get(turnId);
    return row ? deserializeTurnEvent(row) : null;
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

  // Presence cares about REAL rounds only (fix-fleet-turn-veracity D3): a
  // skipped row must never read as "the post just worked". Null when the
  // stream holds only skips (a presence that then rightfully goes stale).
  function latestRealTurnFor(memberId) {
    const row = db
      .prepare("SELECT * FROM member_turn_events WHERE member_id = ? AND status IN ('ok','failed','interrupted') ORDER BY id DESC LIMIT 1")
      .get(memberId);
    return row ? deserializeTurnEvent(row) : null;
  }

  // Skipped rounds inside a window — the "第 k 次" counter for the card badge
  // and the missing-reason count (same read-time aggregate, two consumers).
  function skippedCount(memberId, { sinceMs = null } = {}) {
    const row = sinceMs == null
      ? db.prepare("SELECT COUNT(*) AS n FROM member_turn_events WHERE member_id = ? AND status = 'skipped'").get(memberId)
      : db.prepare("SELECT COUNT(*) AS n FROM member_turn_events WHERE member_id = ? AND status = 'skipped' AND ended_at >= ?").get(memberId, sinceMs);
    return row?.n ?? 0;
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
    return failureStreak(memberId).streak;
  }

  // The failure streak AND its attribution in ONE pass (fix-fleet-failure-
  // visibility D4): a post that has failed N rounds in a row must be able to
  // say WHY and SINCE WHEN, not just that a number is high. `since` is the
  // oldest failure still in the streak; `lastErrorKind` is the newest one's
  // category (the one an operator acts on first). Interrupted rounds are not
  // failures — they stop the streak like any other non-failed row. Skipped
  // rounds (fix-fleet-turn-veracity D2 — runtime never ready, or the lane
  // breaker open) are transparent: never counted, never breaking the chain,
  // never touching since/lastErrorKind (the platform's outage neither poisons
  // nor heals the post's own streak).
  function failureStreak(memberId) {
    const rows = db
      .prepare(
        "SELECT status, started_at, error_kind FROM member_turn_events WHERE member_id = ? ORDER BY id DESC",
      )
      .all(memberId);
    let streak = 0;
    let since = null;
    let lastErrorKind = null;
    for (const r of rows) {
      if (r.status === "skipped") continue;
      if (r.status !== "failed") break;
      if (streak === 0) lastErrorKind = r.error_kind ?? null;
      since = r.started_at ?? since;
      streak += 1;
    }
    return { streak, since: streak > 0 ? since : null, lastErrorKind };
  }

  // ── run ledger (agent-fleet-runs) ─────────────────────────────────────────

  // Header row for a root turn. INSERT OR IGNORE: a run that was already
  // opened (a late downstream turn re-opening a closed one goes through
  // reopenRun) is left alone.
  function insertRun({ runId, fleetId, rootSource, rootMemberId, startedAt }) {
    db.prepare(`
      INSERT OR IGNORE INTO fleet_runs (run_id, fleet_id, root_source, root_member_id, started_at, status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `).run(runId, fleetId, rootSource, rootMemberId, startedAt);
    return getRun(runId);
  }

  function getRun(runId) {
    const row = db.prepare("SELECT * FROM fleet_runs WHERE run_id = ?").get(runId);
    return row ? deserializeRun(row) : null;
  }

  // A downstream turn arriving after the header closed (a queued handoff that
  // waited behind other work) re-opens it; finalizeRun recomputes everything
  // from the turn rows, so the header is always a projection, never a counter.
  function reopenRun(runId) {
    db.prepare("UPDATE fleet_runs SET status = 'open', ended_at = NULL WHERE run_id = ?").run(runId);
    return getRun(runId);
  }

  // Close the header from its turn rows (SUM, not increment — idempotent by
  // construction: calling it twice yields the same row). Status: ok when every
  // turn succeeded, failed when none did, partial otherwise; interrupted turns
  // count as not-ok but not failed.
  function finalizeRun(runId, { endedAt = null } = {}) {
    const agg = db
      .prepare(`
        SELECT COUNT(*) AS turns,
               SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               SUM(usage_input) AS usage_input,
               SUM(usage_output) AS usage_output,
               MAX(ended_at) AS last_ended
        FROM member_turn_events WHERE run_id = ?
      `)
      .get(runId);
    const turns = agg?.turns ?? 0;
    const okCount = agg?.ok_count ?? 0;
    const failedCount = agg?.failed_count ?? 0;
    const status = turns === 0 ? "open" : okCount === turns ? "ok" : okCount === 0 && failedCount > 0 ? "failed" : "partial";
    db.prepare(`
      UPDATE fleet_runs
      SET ended_at = ?, status = ?, turns = ?, ok_count = ?, failed_count = ?, usage_input = ?, usage_output = ?
      WHERE run_id = ?
    `).run(
      endedAt ?? agg?.last_ended ?? Date.now(),
      status,
      turns,
      okCount,
      failedCount,
      agg?.usage_input ?? null,
      agg?.usage_output ?? null,
      runId,
    );
    return getRun(runId);
  }

  // Paged list, newest first. `since`/`until` bound started_at; `source`
  // filters root_source; `status` filters the header status.
  function listRuns(fleetId, { status = null, source = null, since = null, until = null, limit = 50, offset = 0 } = {}) {
    const where = ["fleet_id = ?"];
    const args = [fleetId];
    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (source) {
      where.push("root_source = ?");
      args.push(source);
    }
    if (Number.isFinite(since)) {
      where.push("started_at >= ?");
      args.push(since);
    }
    if (Number.isFinite(until)) {
      where.push("started_at <= ?");
      args.push(until);
    }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM fleet_runs WHERE ${where.join(" AND ")}`).get(...args).n;
    const rows = db
      .prepare(`SELECT * FROM fleet_runs WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    return { total, runs: rows.map(deserializeRun) };
  }

  // The run's turn rows in start order — the timeline's waterfall input. The
  // chain is reconstructed by the reader from parentTurnId × edgeKind.
  function listRunTurns(runId) {
    return db
      .prepare("SELECT * FROM member_turn_events WHERE run_id = ? ORDER BY started_at ASC, id ASC")
      .all(runId)
      .map(deserializeTurnEvent);
  }

  // Edge traffic for the canvas (cockpit D9): hops in the window grouped by
  // (from post, to post, edge kind), with the outcome split. The parent turn
  // row supplies the from post; a parent already pruned leaves the hop out,
  // honestly (the window is shorter than retention, so this is rare).
  function edgeTraffic(fleetId, { sinceMs = Date.now() - 86_400_000 } = {}) {
    return db
      .prepare(`
        SELECT p.member_id AS from_member, c.member_id AS to_member, c.edge_kind AS edge_kind,
               COUNT(*) AS turns,
               SUM(CASE WHEN c.status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
               SUM(CASE WHEN c.status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
               MAX(c.ended_at) AS last_ended
        FROM member_turn_events c
        JOIN member_turn_events p ON p.turn_id = c.parent_turn_id
        WHERE c.fleet_id = ? AND c.edge_kind IS NOT NULL AND c.started_at >= ?
        GROUP BY p.member_id, c.member_id, c.edge_kind
      `)
      .all(fleetId, sinceMs)
      .map((r) => ({
        from: r.from_member,
        to: r.to_member,
        kind: r.edge_kind,
        turns: r.turns,
        ok: r.ok_count ?? 0,
        failed: r.failed_count ?? 0,
        lastEndedAt: r.last_ended ?? null,
      }));
  }

  // Hourly sweep (D10): closed headers past the window go; open ones never.
  // Turn rows are pruned on their own dual condition at append time and here
  // (a quiet cell with no new turns still ages out). Returns counts.
  function pruneRuns({ now = Date.now() } = {}) {
    const cutoff = now - runRetentionMs();
    const runs = db.prepare("DELETE FROM fleet_runs WHERE status != 'open' AND ended_at IS NOT NULL AND ended_at < ?").run(cutoff).changes;
    const members = db.prepare("SELECT DISTINCT member_id FROM member_turn_events WHERE ended_at < ?").all(cutoff);
    let turns = 0;
    const stmt = db.prepare(`
      DELETE FROM member_turn_events
      WHERE member_id = ? AND ended_at < ? AND id NOT IN (
        SELECT id FROM member_turn_events WHERE member_id = ? ORDER BY id DESC LIMIT ?
      )
    `);
    for (const { member_id } of members) {
      turns += stmt.run(member_id, cutoff, member_id, turnEventKeep()).changes;
    }
    const orphans = reclaimOrphanRuns({ now });
    return { runs, turns, orphans };
  }

  // Orphan-open sweep (add-cockpit-run-reclaim): a header opened by begin()
  // whose turn never wrote a row leaves an `open` run that NO future event can
  // close — the settle backstop fires on engine-terminal tasks, and a lost
  // turn produces none. Left alone these squat the list forever (prod
  // 2026-10-26: run_d92b41 sat open 7 hours with zero turns, from a pod roll
  // mid-turn). A header with no turn rows, still open past the grace window,
  // is closed as `failed` — honest: something started and never finished.
  function reclaimOrphanRuns({ now = Date.now(), graceMs = 30 * 60_000 } = {}) {
    const cutoff = now - graceMs;
    const rows = db
      .prepare(`
        SELECT r.run_id, r.started_at FROM fleet_runs r
        WHERE r.status = 'open' AND r.started_at < ?
          AND NOT EXISTS (SELECT 1 FROM member_turn_events e WHERE e.run_id = r.run_id)
      `)
      .all(cutoff);
    for (const r of rows) {
      db.prepare("UPDATE fleet_runs SET status = 'failed', ended_at = ?, turns = 0 WHERE run_id = ?").run(r.started_at, r.run_id);
    }
    return rows.length;
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
    getTurnEvent,
    listTurnEvents,
    listFleetTurnEvents,
    latestTurnFor,
    latestRealTurnFor,
    skippedCount,
    consecutiveFailures,
    failureStreak,
    insertRun,
    getRun,
    reopenRun,
    finalizeRun,
    listRuns,
    listRunTurns,
    edgeTraffic,
    pruneRuns,
    reclaimOrphanRuns,
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
    effort: row.effort ?? null,
    contextBudget: row.context_budget ?? null,
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
    effort: row.effort ?? null,
    contextBudget: row.context_budget ?? null,
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

// Token counts land as integers or not at all: a provider that reports no
// usage leaves NULL, never a guessed zero (spec: 用量缺失不虚构).
function usageInt(v) {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

function usageOf(row) {
  if (row.usage_input == null && row.usage_output == null) return null;
  return { input: row.usage_input ?? null, output: row.usage_output ?? null };
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
    turnId: row.turn_id ?? null,
    runId: row.run_id ?? null,
    parentTurnId: row.parent_turn_id ?? null,
    edgeKind: row.edge_kind ?? null,
    usage: usageOf(row),
    traceTurnId: row.trace_turn_id ?? null,
    detail: parseDetail(row.detail),
  };
}

// fix-fleet-failure-visibility-era rows predate the detail column; a corrupt
// payload reads as honest absence rather than throwing into every reader.
function parseDetail(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function deserializeRun(row) {
  return {
    runId: row.run_id,
    fleetId: row.fleet_id,
    rootSource: row.root_source,
    rootMemberId: row.root_member_id,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    status: row.status,
    turns: row.turns ?? 0,
    okCount: row.ok_count ?? 0,
    failedCount: row.failed_count ?? 0,
    usage: usageOf(row),
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
