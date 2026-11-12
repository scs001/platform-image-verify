// ── 微信客服：存储 ──────────────────────────────────────────────────────────
//
// 跟 `archive/store.js` 一个约定：`ensureKfSchema(db)` 幂等建表，每函数首参收 `db`，
// 回滚=摘通道，空表无害。
//
// 与存档表的三处刻意差异：
//
// 1. **游标是文字不是数字**。`next_cursor` 是不透明串，不能比较大小，
//    所以"只进不退"只能靠"非空且与请求不同"来判，不能照抄 `MAX(seq, excluded.seq)`。
// 2. **没有 agree_state 列**。kf 是客户主动咨询，不存在外部客户的存档同意问题；
//    加一列恒为 `agree` 的字段等于伪造同意。
// 3. **`history_from` 是一等字段**。3 天窗口意味着首轮之前的历史永远拿不到，
//    这个事实必须落在数据里，否则巡检面会以为库里的是全部。

export function ensureKfSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kf_cursor (
      id              TEXT PRIMARY KEY,
      cursor          TEXT NOT NULL DEFAULT '',
      last_checked_at INTEGER NOT NULL DEFAULT 0,
      last_msg_at     INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER NOT NULL DEFAULT 0,
      history_from    INTEGER NOT NULL DEFAULT 0,
      truncations     INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kf_conversation (
      conversation_id  TEXT PRIMARY KEY,
      open_kfid        TEXT NOT NULL DEFAULT '',
      external_userid  TEXT NOT NULL DEFAULT '',
      name             TEXT NOT NULL DEFAULT '',
      first_msg_at     INTEGER,
      last_msg_at      INTEGER,
      msg_count        INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kf_conv_last ON kf_conversation(last_msg_at DESC);

    CREATE TABLE IF NOT EXISTS kf_message (
      id               TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,
      msg_id           TEXT NOT NULL,
      open_kfid        TEXT NOT NULL DEFAULT '',
      external_userid  TEXT NOT NULL DEFAULT '',
      servicer_userid  TEXT NOT NULL DEFAULT '',
      sent_at          INTEGER NOT NULL,
      origin           TEXT NOT NULL DEFAULT 'unknown',
      msg_type         TEXT NOT NULL DEFAULT 'unknown',
      text             TEXT NOT NULL DEFAULT '',
      media_id         TEXT,
      media_type       TEXT,
      event_type       TEXT,
      raw_json         TEXT,
      ingested_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kf_msg_conv ON kf_message(conversation_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_kf_msg_sent ON kf_message(sent_at DESC);

    CREATE TABLE IF NOT EXISTS kf_customer (
      external_userid TEXT PRIMARY KEY,
      nickname        TEXT NOT NULL DEFAULT '',
      avatar          TEXT NOT NULL DEFAULT '',
      gender          INTEGER NOT NULL DEFAULT 0,
      unionid         TEXT NOT NULL DEFAULT '',
      state           TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      fetched_at      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kf_customer_state ON kf_customer(state);

    -- 媒体：正文早就入库了，这里只管"附件有没有真的取到"。
    -- 一条消息一个媒体，所以主键直接用消息主键。
    CREATE TABLE IF NOT EXISTS kf_media (
      id              TEXT PRIMARY KEY,
      message_id      TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      media_id        TEXT NOT NULL,
      media_type      TEXT NOT NULL DEFAULT 'unknown',
      bytes           INTEGER NOT NULL DEFAULT 0,
      path            TEXT,
      state           TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kf_media_state ON kf_media(state);
  `);

  // 老库升级：`last_success_at` 是后加的列。补列而不是重建表——客户库里已经有游标与
  // history_from，重建会丢"不可得边界"。补 0 之后 `evaluateLag` 报 never_checked，
  // 等第一轮成功同步把它填上。
  ensureKfColumn(db, "kf_cursor", "last_success_at", "INTEGER NOT NULL DEFAULT 0");
}

/** 幂等补列（SQLite 没有 ADD COLUMN IF NOT EXISTS）。 */
function ensureKfColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// ── cursor ──────────────────────────────────────────────────────────────────

export function readKfCursor(db, id = "default") {
  ensureKfSchema(db);
  const row = db.prepare("SELECT * FROM kf_cursor WHERE id=?").get(id);
  if (!row) {
    return {
      id,
      cursor: "",
      lastCheckedAt: 0,
      lastMessageAt: 0,
      lastSuccessAt: 0,
      historyFrom: 0,
      truncations: 0,
    };
  }
  return {
    id: row.id,
    cursor: String(row.cursor || ""),
    lastCheckedAt: Number(row.last_checked_at),
    lastMessageAt: Number(row.last_msg_at),
    lastSuccessAt: Number(row.last_success_at ?? 0),
    historyFrom: Number(row.history_from),
    truncations: Number(row.truncations),
  };
}

/**
 * 写游标。
 *
 * 文字游标没法比大小，所以这里的"只进"靠调用方保证：只在消息落库之后、
 * 且 `next_cursor` 与请求值不同时调用。这里额外做的是三件单调事：
 * 检查水位与数据水位取 max，`history_from` 一旦写下就不再改（它记录的是不可得边界）。
 */
export function writeKfCursor(db, state) {
  ensureKfSchema(db);
  const id = state.id || "default";
  const prev = readKfCursor(db, id);
  const cursor = state.cursor ? String(state.cursor) : prev.cursor;
  const historyFrom = prev.historyFrom || Number(state.historyFrom || 0);
  db.prepare(
    `INSERT INTO kf_cursor(id, cursor, last_checked_at, last_msg_at, last_success_at, history_from, truncations, updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       cursor          = excluded.cursor,
       last_checked_at = MAX(kf_cursor.last_checked_at, excluded.last_checked_at),
       last_msg_at     = MAX(kf_cursor.last_msg_at, excluded.last_msg_at),
       last_success_at = MAX(kf_cursor.last_success_at, excluded.last_success_at),
       history_from    = MAX(kf_cursor.history_from, excluded.history_from),
       truncations     = kf_cursor.truncations + excluded.truncations,
       updated_at      = excluded.updated_at`,
  ).run(
    id,
    cursor,
    Number(state.lastCheckedAt || 0),
    Number(state.lastMessageAt || 0),
    Number(state.lastSuccessAt || 0),
    historyFrom,
    Math.max(0, Number(state.truncations || 0)),
    Number(state.updatedAt || Date.now()),
  );
}

// ── conversation ────────────────────────────────────────────────────────────

export function upsertKfConversation(db, conv) {
  ensureKfSchema(db);
  db.prepare(
    `INSERT INTO kf_conversation(conversation_id, open_kfid, external_userid, name, updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       open_kfid       = CASE WHEN excluded.open_kfid <> '' THEN excluded.open_kfid ELSE kf_conversation.open_kfid END,
       external_userid = CASE WHEN excluded.external_userid <> '' THEN excluded.external_userid ELSE kf_conversation.external_userid END,
       name            = CASE WHEN excluded.name <> '' THEN excluded.name ELSE kf_conversation.name END,
       updated_at      = excluded.updated_at`,
  ).run(
    conv.conversationId,
    conv.openKfId || "",
    conv.externalUserId || "",
    conv.name || "",
    Number(conv.updatedAt || Date.now()),
  );
}

export function getKfConversation(db, conversationId) {
  ensureKfSchema(db);
  const row = db.prepare("SELECT * FROM kf_conversation WHERE conversation_id=?").get(conversationId);
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    openKfId: row.open_kfid,
    externalUserId: row.external_userid,
    name: row.name,
    firstMsgAt: row.first_msg_at ?? null,
    lastMsgAt: row.last_msg_at ?? null,
    msgCount: Number(row.msg_count || 0),
  };
}

export function refreshKfConversationStats(db, conversationId) {  ensureKfSchema(db);
  const row = db
    .prepare(
      "SELECT COUNT(*) n, MIN(sent_at) lo, MAX(sent_at) hi FROM kf_message WHERE conversation_id=?",
    )
    .get(conversationId);
  db.prepare(
    "UPDATE kf_conversation SET msg_count=?, first_msg_at=?, last_msg_at=?, updated_at=? WHERE conversation_id=?",
  ).run(Number(row.n || 0), row.lo ?? null, row.hi ?? null, Date.now(), conversationId);
}

// ── message ─────────────────────────────────────────────────────────────────

/** 幂等写入。主键 `<会话ID>:<msgid>`，重放同一批不增产。 */
export function insertKfMessage(db, msg) {
  ensureKfSchema(db);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO kf_message
         (id, conversation_id, msg_id, open_kfid, external_userid, servicer_userid,
          sent_at, origin, msg_type, text, media_id, media_type, event_type, raw_json, ingested_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      msg.id,
      msg.conversationId,
      msg.msgId,
      msg.openKfId || "",
      msg.externalUserId || "",
      msg.servicerUserId || "",
      Number(msg.sentAt || 0),
      msg.origin || "unknown",
      msg.msgType || "unknown",
      msg.text || "",
      msg.mediaId ?? null,
      msg.mediaType ?? null,
      msg.eventType ?? null,
      msg.rawJson ?? null,
      Number(msg.ingestedAt || Date.now()),
    );
  return info.changes > 0;
}

export function kfMessageCount(db) {
  ensureKfSchema(db);
  return Number(db.prepare("SELECT COUNT(*) n FROM kf_message").get().n || 0);
}

/**
 * 列出消息。默认按时间倒序，可按会话收窄。
 * `origin` 可传数组用于消费侧过滤（agent 输入只允许 peer）。
 */
export function listKfMessages(db, { conversationId, origins, limit = 100, before } = {}) {
  ensureKfSchema(db);
  const where = [];
  const args = [];
  if (conversationId) {
    where.push("conversation_id=?");
    args.push(conversationId);
  }
  if (Array.isArray(origins) && origins.length) {
    where.push(`origin IN (${origins.map(() => "?").join(",")})`);
    args.push(...origins);
  }
  if (before !== undefined && before !== null) {
    where.push("sent_at < ?");
    args.push(Number(before));
  }
  const sql = `SELECT * FROM kf_message ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY sent_at DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, Math.max(1, Math.min(1000, Number(limit) || 100)))
    .map(rowToMessage);
}

export function rowToMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    msgId: row.msg_id,
    openKfId: row.open_kfid,
    externalUserId: row.external_userid,
    servicerUserId: row.servicer_userid,
    sentAt: Number(row.sent_at),
    origin: row.origin,
    msgType: row.msg_type,
    text: row.text,
    mediaId: row.media_id ?? null,
    mediaType: row.media_type ?? null,
    eventType: row.event_type ?? null,
    ingestedAt: Number(row.ingested_at),
  };
}

/**
 * 检索。
 *
 * 这里**不用 FTS5 trigram**：那个索引对 2 字中文查询静默返回 0（已在存档侧踩过），
 * 而中文咨询里两字词（"报价""合同""发票"）恰恰是最常搜的。kf 的消息量级（未认证 100 客户）
 * 用 LIKE 全表扫完全够，换来的是"搜得到"。
 */
export function searchKfMessages(db, { query = "", limit = 50, origins = null } = {}) {
  ensureKfSchema(db);
  const q = String(query || "").trim();
  const size = Math.max(1, Math.min(500, Number(limit) || 50));
  const filters = [];
  const args = [];
  if (Array.isArray(origins) && origins.length) {
    filters.push(`origin IN (${origins.map(() => "?").join(",")})`);
    args.push(...origins);
  }
  if (!q) {
    const sql = `SELECT * FROM kf_message ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
                 ORDER BY sent_at DESC LIMIT ?`;
    return db.prepare(sql).all(...args, size).map(rowToMessage);
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  filters.push("text LIKE ? ESCAPE '\\'");
  args.push(like);
  return db
    .prepare(
      `SELECT * FROM kf_message WHERE ${filters.join(" AND ")} ORDER BY sent_at DESC LIMIT ?`,
    )
    .all(...args, size)
    .map(rowToMessage);
}

// ── customer ────────────────────────────────────────────────────────────────

/** 消息入库时先占位：`external_userid` 原样存，昵称等资料另外补。 */
export function ensureKfCustomer(db, externalUserId) {
  ensureKfSchema(db);
  db.prepare(
    "INSERT OR IGNORE INTO kf_customer(external_userid, state) VALUES(?, 'pending')",
  ).run(String(externalUserId));
}

export function pendingKfCustomers(db, limit = 100) {
  ensureKfSchema(db);
  return db
    .prepare(
      "SELECT external_userid FROM kf_customer WHERE state IN ('pending','failed') ORDER BY attempts ASC LIMIT ?",
    )
    .all(Math.max(1, Math.min(100, Number(limit) || 100)))
    .map((r) => r.external_userid);
}

export function markKfCustomer(db, { externalUserId, state, error = null }) {
  ensureKfSchema(db);
  db.prepare(
    `UPDATE kf_customer SET state=?, attempts=attempts+1, last_error=?, fetched_at=?
     WHERE external_userid=?`,
  ).run(state, error, Date.now(), String(externalUserId));
}

export function upsertKfCustomer(db, customer) {
  ensureKfSchema(db);
  db.prepare(
    `INSERT INTO kf_customer(external_userid, nickname, avatar, gender, unionid, state, attempts, last_error, fetched_at)
     VALUES(?,?,?,?,?,'done',1,NULL,?)
     ON CONFLICT(external_userid) DO UPDATE SET
       nickname = CASE WHEN excluded.nickname <> '' THEN excluded.nickname ELSE kf_customer.nickname END,
       avatar   = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE kf_customer.avatar END,
       gender   = CASE WHEN excluded.gender <> 0 THEN excluded.gender ELSE kf_customer.gender END,
       unionid  = CASE WHEN excluded.unionid <> '' THEN excluded.unionid ELSE kf_customer.unionid END,
       state    = 'done',
       last_error = NULL,
       fetched_at = excluded.fetched_at`,
  ).run(
    String(customer.external_userid || customer.externalUserId || ""),
    String(customer.nickname || ""),
    String(customer.avatar || ""),
    Number(customer.gender || 0),
    String(customer.unionid || ""),
    Date.now(),
  );
}

// ── media ───────────────────────────────────────────────────────────────────

/** 入队。主键=消息主键：一条消息只有一个媒体，重复入队是无害的 no-op。 */
export function queueKfMedia(db, row) {
  ensureKfSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO kf_media(id, message_id, conversation_id, media_id, media_type, state, updated_at)
     VALUES(?,?,?,?,?,'pending',?)`,
  ).run(row.id, row.messageId, row.conversationId, row.mediaId, row.mediaType || "unknown", Date.now());
}

export function pendingKfMedia(db, limit = 20) {
  ensureKfSchema(db);
  return db
    .prepare("SELECT * FROM kf_media WHERE state='pending' ORDER BY updated_at ASC LIMIT ?")
    .all(Math.max(1, Number(limit) || 20))
    .map((r) => ({
      id: r.id,
      messageId: r.message_id,
      conversationId: r.conversation_id,
      mediaId: r.media_id,
      mediaType: r.media_type,
      bytes: Number(r.bytes || 0),
      path: r.path ?? null,
      state: r.state,
      attempts: Number(r.attempts || 0),
      lastError: r.last_error ?? null,
    }));
}

export function markKfMedia(db, { id, state, bytes = 0, path = null, attempts = 0, error = null }) {
  ensureKfSchema(db);
  db.prepare(
    "UPDATE kf_media SET state=?, bytes=?, path=?, attempts=?, last_error=?, updated_at=? WHERE id=?",
  ).run(state, Number(bytes || 0), path, Number(attempts || 0), error, Date.now(), id);
}

/** 完成率。分母为 0 返回 null，不返回 1——空库不该显示 100%。 */
export function kfMediaCompletion(db) {
  ensureKfSchema(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed,
              SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) pending
         FROM kf_media`,
    )
    .get();
  const total = Number(row.total || 0);
  return {
    total,
    done: Number(row.done || 0),
    failed: Number(row.failed || 0),
    pending: Number(row.pending || 0),
    ratio: total ? Number(row.done || 0) / total : null,
  };
}

// ── coverage ────────────────────────────────────────────────────────────────

/**
 * 覆盖口径。**禁止宣称全量**，理由有三条，全部写进返回值：
 *   - 窗口只有 3 天（`windowDays`）；
 *   - 首轮之前的历史不可得（`historyFrom`）；
 *   - 单轮批次上限会截断（`truncations`）。
 */
export function kfCoverageReport(db, { cursorId = "default", windowDays = 3 } = {}) {
  ensureKfSchema(db);
  const cursor = readKfCursor(db, cursorId);
  const conv = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END) with_msgs
       FROM kf_conversation`,
    )
    .get();
  const msg = db.prepare("SELECT COUNT(*) n, MIN(sent_at) lo, MAX(sent_at) hi FROM kf_message").get();
  const cust = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed
       FROM kf_customer`,
    )
    .get();
  const origin = db
    .prepare("SELECT origin, COUNT(*) n FROM kf_message GROUP BY origin")
    .all()
    .reduce((acc, r) => { acc[r.origin] = Number(r.n); return acc; }, {});

  return {
    channel: "wecom-kf",
    windowDays,
    cursor: {
      position: cursor.cursor,
      lastCheckedAt: cursor.lastCheckedAt || null,
      lastMessageAt: cursor.lastMessageAt || null,
      // 滞后判定的水位。为 null 时表示老库还没记录过成功拉取（诊断会报 never_checked）。
      lastSuccessAt: cursor.lastSuccessAt || null,
      historyFrom: cursor.historyFrom || null,
      truncations: cursor.truncations,
    },
    conversations: {
      total: Number(conv.total || 0),
      withMessages: Number(conv.with_msgs || 0),
    },
    messages: {
      total: Number(msg.n || 0),
      firstAt: msg.lo ?? null,
      lastAt: msg.hi ?? null,
      byOrigin: origin,
    },
    customers: {
      total: Number(cust.total || 0),
      done: Number(cust.done || 0),
      failed: Number(cust.failed || 0),
    },
    media: kfMediaCompletion(db),
    claimsFullCoverage: false,
    coverageNote:
      "微信客服只保留最近 3 天消息；首次同步之前的历史不可补。本报告不宣称覆盖全部历史。",
  };
}
