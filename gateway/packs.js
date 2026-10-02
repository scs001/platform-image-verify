// ── Pack registry (openspec: add-pack-marketplace) ───────────────────────────
//
// The gateway's persistence + validation layer for the pack marketplace:
// identity-gated creators publish versioned, immutable capability packs
// (inline skill bodies + registry-name MCP references + persona-only agent
// entries), and every authenticated user can browse them and subscribe.
// Rows live in a dedicated SQLite file at the gateway data root — the same
// isolation rule as the share registry, for the same reason: a pack must
// outlive and cross cells, so it cannot live inside any one of them.
//
// Version immutability is structural: publishing appends a (pack_id, version)
// row and nothing ever updates one; "unpublish" only sets an unlisted flag.
// Pack ids are gateway-minted random (128 bits) — they carry no author or
// name structure, and display names are not unique, so there is no global
// namespace to contend for.
//
// Publishing is the only mutation gated beyond identity: the route layer
// checks the creator group, this module's validateManifest() enforces the v1
// content boundary (MCP entries are registry-name references only — no
// endpoints; agent entries are persona-only — no baseUrl/model/credentials),
// and createPublishRateLimiter() caps the publish rate per author.

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import express from "express";
import { PACK_LIMITS, validatePackManifest as validateManifest, validateRhythm } from "../lib/pack-manifest.js";
import { deployToRegistry, setAgentPaused } from "../lib/agent-serving.js";
import { createSub2apiClient } from "../lib/sub2api-admin.js";

// Re-exported for the gateway's own consumers (tests import from here).
export { PACK_LIMITS, validateManifest };

export function createPackRegistry({ file }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS packs (
    id TEXT PRIMARY KEY,
    author_email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    unlisted INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'public'
  )`);
  // add-agent-platform-ops: visibility on pre-existing databases.
  try {
    db.exec(`ALTER TABLE packs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
  } catch { /* column already present */ }
  db.exec(`CREATE TABLE IF NOT EXISTS pack_versions (
    pack_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    manifest TEXT NOT NULL,
    author_email TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, version)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    pack_id TEXT NOT NULL,
    email TEXT NOT NULL,
    version INTEGER NOT NULL,
    subscribed_at INTEGER NOT NULL,
    unsubscribed_at INTEGER,
    PRIMARY KEY (pack_id, email)
  )`);
  // Agent-service deployments (add-a2a-agent-serving 3.3): bookkeeping only —
  // the runner pulls the bundle from the registry; this table answers "which
  // of this pack's roles are deployed" for the unpublish warning and the
  // deploy button's status. One row per (pack, agent); upgrades upsert.
  db.exec(`CREATE TABLE IF NOT EXISTS pack_deployments (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    agent_path TEXT NOT NULL,
    skill_paths TEXT NOT NULL DEFAULT '[]',
    deployed_by TEXT NOT NULL,
    deployed_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id)
  )`);

  // Platform billing (add-agent-platform-ops D1/D2): the deployer→sub2api
  // account mapping (the platform-held password exists only for accounts the
  // platform created), and the per-agent metered keys (value stored ONCE —
  // sub2api keeps only a hash; the runner fetches values by reference).
  db.exec(`CREATE TABLE IF NOT EXISTS sub2api_accounts (
    email TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    password TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_keys (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    key_ref TEXT NOT NULL,
    key_value TEXT NOT NULL,
    deployer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id)
  )`);

  const now = () => Date.now();
  const mintId = () => randomBytes(16).toString("base64url");

  const versionRow = (packId, version) =>
    db.prepare(`SELECT * FROM pack_versions WHERE pack_id = ? AND version = ?`).get(packId, version) ?? null;

  const latestVersionRow = (packId) =>
    db.prepare(`SELECT * FROM pack_versions WHERE pack_id = ? ORDER BY version DESC LIMIT 1`).get(packId) ?? null;

  const packRow = (packId) => db.prepare(`SELECT * FROM packs WHERE id = ?`).get(packId) ?? null;

  function summaryOf(pack, version) {
    return {
      id: pack.id,
      authorEmail: pack.author_email,
      createdAt: pack.created_at,
      version: version.version,
      name: version.name,
      description: version.description,
      tags: JSON.parse(version.tags || "[]"),
      publishedAt: version.published_at,
      unlisted: Boolean(pack.unlisted),
      visibility: pack.visibility === "private" ? "private" : "public",
    };
  }

  // Private packs are owner-scoped (openspec: pack-visibility): invisible to
  // everyone but the author and admins, with the same not-found answer a
  // nonexistent pack gives — probing teaches nothing.
  return {
    packRowPublic: packRow,

    visibleTo(pack, user, { admin = false } = {}) {
      if (!pack) return false;
      if (pack.visibility !== "private") return true;
      return !!user && (pack.author_email === user.email || admin === true);
    },

    // First publish: mint an id and store version 1.
    publish({ email, manifest }) {
      const id = mintId();
      const visibility = manifest.visibility === "private" ? "private" : "public";
      db.prepare(`INSERT INTO packs (id, author_email, created_at, visibility) VALUES (?, ?, ?, ?)`).run(id, email, now(), visibility);
      db.prepare(
        `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      ).run(id, manifest.name, manifest.description || "", JSON.stringify(manifest.tags ?? []), JSON.stringify(manifest), email, now());
      return { id, version: 1 };
    },

    // Subsequent publish: author-checked append of the next version. Stored
    // versions are immutable — this is the only write path that touches one.
    publishVersion({ email, id, manifest }) {
      const pack = packRow(id);
      if (!pack) return { error: "not_found" };
      if (pack.author_email !== email) return { error: "forbidden" };
      // Visibility is a PACK-level attribute (owner-scoped everywhere); a
      // version cannot flip it — publish a new pack to change exposure.
      const latest = latestVersionRow(id);
      const version = (latest?.version ?? 0) + 1;
      db.prepare(
        `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, version, manifest.name, manifest.description || "", JSON.stringify(manifest.tags ?? []), JSON.stringify(manifest), email, now());
      return { id, version };
    },

    // Latest-version detail. `includeUnlisted` is the route's call: an
    // unlisted pack stays visible to its author and active subscribers.
    get(id, { includeUnlisted = false } = {}) {
      const pack = packRow(id);
      if (!pack) return null;
      if (pack.unlisted && !includeUnlisted) return null;
      const version = latestVersionRow(id);
      if (!version) return null;
      return { ...summaryOf(pack, version), manifest: JSON.parse(version.manifest) };
    },

    // Stored versions are always retrievable — "immutable" includes the
    // unlisted state (spec: every stored version SHALL remain retrievable).
    // Only the listing and latest-version detail hide unlisted packs.
    getVersion(id, version) {
      const pack = packRow(id);
      if (!pack) return null;
      const row = versionRow(id, Number(version));
      if (!row) return null;
      return { id, version: row.version, manifest: JSON.parse(row.manifest) };
    },

    // Paginated listing of live (not unlisted) packs, newest publish first.
    // `search` matches name/description substrings; `tag` matches a tag
    // exactly (stored as a JSON array, matched textually for v1 volumes).
    list({ search = "", tag = "", page = 1, pageSize = 50, viewer = null } = {}) {
      const size = Math.min(Math.max(1, Number(pageSize) || 50), 100);
      const pageNum = Math.max(1, Number(page) || 1);
      const where = ["p.unlisted = 0"];
      const params = [];
      // Private packs: owner sees their own; nobody else's (admin listing goes
      // through the same clause — pass viewer with admin flag from the route).
      if (viewer?.admin) {
        where.push("1 = 1");
      } else {
        where.push("(p.visibility IS NULL OR p.visibility != 'private' OR p.author_email = ?)");
        params.push(String(viewer?.email ?? ""));
      }
      if (search) {
        where.push(`(v.name LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')`);
        const pat = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        params.push(pat, pat);
      }
      if (tag) {
        where.push(`v.tags LIKE ? ESCAPE '\\'`);
        params.push(`%"${tag.replace(/[\\%_"]/g, (c) => `\\${c}`)}"%`);
      }
      const whereSql = where.join(" AND ");
      const total = db.prepare(
        `SELECT COUNT(*) AS n FROM packs p JOIN pack_versions v
           ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
         WHERE ${whereSql}`,
      ).get(...params).n;
      const rows = db.prepare(
        `SELECT p.*, v.version, v.name, v.description, v.tags, v.published_at FROM packs p JOIN pack_versions v
           ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
         WHERE ${whereSql}
         ORDER BY v.published_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, size, (pageNum - 1) * size);
      return {
        total,
        page: pageNum,
        pageSize: size,
        packs: rows.map((r) => summaryOf(r, r)),
      };
    },

    // Author-checked unlist. Versions and subscriptions are untouched.
    setUnlisted({ email, id }) {
      const pack = packRow(id);
      if (!pack) return false;
      if (pack.author_email !== email) return false;
      db.prepare(`UPDATE packs SET unlisted = 1 WHERE id = ?`).run(id);
      return true;
    },

    // Subscribe records the latest version at subscribe time. Resubscribing
    // (re)records it — the cell's own installed-pack state remains the
    // operational truth for what is materialized there.
    subscribe({ email, id }) {
      const pack = packRow(id);
      if (!pack || pack.unlisted) return null;
      const version = latestVersionRow(id);
      if (!version) return null;
      db.prepare(
        `INSERT INTO subscriptions (pack_id, email, version, subscribed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (pack_id, email) DO UPDATE SET version = excluded.version, subscribed_at = excluded.subscribed_at, unsubscribed_at = NULL`,
      ).run(id, email, version.version, now());
      return { version: version.version, manifest: JSON.parse(version.manifest) };
    },

    unsubscribe({ email, id }) {
      const r = db.prepare(
        `UPDATE subscriptions SET unsubscribed_at = ? WHERE pack_id = ? AND email = ? AND unsubscribed_at IS NULL`,
      ).run(now(), id, email);
      return r.changes > 0;
    },

    subscription(email, id) {
      return db.prepare(
        `SELECT * FROM subscriptions WHERE pack_id = ? AND email = ? AND unsubscribed_at IS NULL`,
      ).get(id, email) ?? null;
    },

    subscriberCount(id) {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM subscriptions WHERE pack_id = ? AND unsubscribed_at IS NULL`,
      ).get(id).n;
    },

    authorEmail(id) {
      return packRow(id)?.author_email ?? null;
    },

    // ── Agent-service deployments (add-a2a-agent-serving 3.3) ────────────────
    // Bookkeeping only: the registry holds the deployed truth (agent entries);
    // these rows answer "which roles of this pack are deployed" for the
    // unpublish warning and the deploy button's status. Upsert keeps one row
    // per (pack, agent) across in-place upgrades.
    recordDeployment({ packId, agentId, version, agentPath, skillPaths, email }) {
      db.prepare(
        `INSERT INTO pack_deployments (pack_id, agent_id, version, agent_path, skill_paths, deployed_by, deployed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pack_id, agent_id) DO UPDATE SET
           version = excluded.version, agent_path = excluded.agent_path,
           skill_paths = excluded.skill_paths, deployed_by = excluded.deployed_by,
           deployed_at = excluded.deployed_at`,
      ).run(packId, agentId, Number(version), agentPath, JSON.stringify(skillPaths ?? []), email, now());
    },

    deployments(id) {
      return db.prepare(`SELECT * FROM pack_deployments WHERE pack_id = ? ORDER BY agent_id`).all(id)
        .map((r) => ({
          agentId: r.agent_id,
          version: r.version,
          agentPath: r.agent_path,
          skills: JSON.parse(r.skill_paths || "[]"),
          deployedBy: r.deployed_by,
          deployedAt: r.deployed_at,
        }));
    },
    // ── Platform billing bookkeeping (add-agent-platform-ops) ─────────────
    billingAccount(email) {
      return db.prepare(`SELECT * FROM sub2api_accounts WHERE email = ?`).get(email) ?? null;
    },
    saveBillingAccount({ email, userId, password }) {
      db.prepare(
        `INSERT INTO sub2api_accounts (email, user_id, password, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id,
           password = COALESCE(excluded.password, sub2api_accounts.password)`,
      ).run(email, userId, password, Date.now());
    },
    recordDeploymentKey({ packId, agentId, keyRef, keyValue, deployer }) {
      // keyRef normalizes to string: sub2api ids arrive as numbers, route
      // params as strings — one canonical form or lookups miss.
      db.prepare(
        `INSERT INTO deployment_keys (pack_id, agent_id, key_ref, key_value, deployer, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pack_id, agent_id) DO UPDATE SET key_ref = excluded.key_ref,
           key_value = excluded.key_value, deployer = excluded.deployer`,
      ).run(packId, agentId, String(keyRef), keyValue, deployer, Date.now());
    },
    deploymentKeyByRef(keyRef) {
      const r = db.prepare(`SELECT * FROM deployment_keys WHERE key_ref = ?`).get(String(keyRef));
      return r ? { agentId: r.agent_id, packId: r.pack_id, keyValue: r.key_value, deployer: r.deployer } : null;
    },
    listDeploymentKeys() {
      return db.prepare(`SELECT pack_id, agent_id, key_ref, deployer, created_at FROM deployment_keys`).all()
        .map((r) => ({ packId: r.pack_id, agentId: r.agent_id, keyRef: r.key_ref, deployer: r.deployer, createdAt: r.created_at }));
    },

    close() {
      db.close();
    },
  };
}

// Per-author fixed-window publish limiter (share.js createRateLimiter
// pattern, keyed by author email instead of remote address).
export function createPublishRateLimiter({ windowMs = 60 * 60_000, max = 10 } = {}) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, b] of buckets) if (b.resetAt <= cutoff) buckets.delete(key);
  }, windowMs).unref();

  return function allow(email) {
    const t = Date.now();
    let b = buckets.get(email);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(email, b);
    }
    b.count += 1;
    return b.count <= max;
  };
}

// ── HTTP surface ─────────────────────────────────────────────────────────────
//
// Every route requires a verified identity (the gateway's resolveUser /
// rejectUnauthenticated — same as the share routes); only publishing adds the
// creator-group gate on top. Registered before the cell-proxy catch-all.

export function registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups,
  adminGroups = [],
  rateMax = 10,
  rateWindowMs = 60 * 60_000,
  jsonLimit = "1mb",
  deployConfig: deployConfigOpt = null,
}) {
  // Agent-serving wiring (3.2): injected config wins (tests), env falls back
  // to the dedicated AGENT_SERVING_* names, then the market-bridge vars —
  // on single-process deployments the registry is the same host either way.
  const deployConfig = () => {
    if (typeof deployConfigOpt === "function") return deployConfigOpt();
    if (deployConfigOpt && typeof deployConfigOpt === "object") return deployConfigOpt;
    return {
      registryUrl: process.env.AGENT_SERVING_REGISTRY_URL || process.env.REGISTRY_URL || "",
      token: process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "",
      runnerBaseUrl: process.env.AGENT_SERVING_RUNNER_URL || "",
      packsPublicBase: process.env.AGENT_SERVING_PACKS_URL || process.env.PAAS_BASE_URL || "",
      // Platform billing (add-agent-platform-ops D1): the admin key rides the
      // platform secret; absent ⇒ the linkage degrades (no gate, no keys).
      ...(process.env.SUB2API_ADMIN_KEY
        ? { sub2api: { baseUrl: process.env.SUB2API_BASE_URL || "http://127.0.0.1:32080", adminKey: process.env.SUB2API_ADMIN_KEY } }
        : { sub2api: null }),
    };
  };
  const publishAllowed = createPublishRateLimiter({ windowMs: rateWindowMs, max: rateMax });
  const isCreator = (user) => creatorGroups.some((g) => (user.groups || []).includes(g));
  // The platform emergency stop's gate (add-agent-residency D5): admin groups
  // only — the deployer-facing pause/resume ride the author-or-creator gate.
  const isAdmin = (user) => adminGroups.some((g) => (user.groups || []).includes(g));
  const auth = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };

  // Publish (first version or next). Body: { packId?, manifest } — packId
  // targets an existing pack (author-checked); omitting it mints a new one.
  app.post("/api/packs", express.json({ limit: jsonLimit }), (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!isCreator(user)) return res.status(403).json({ error: "Creator group required" });
    const manifest = req.body?.manifest;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : null;
    if (!manifest) return res.status(400).json({ error: "manifest required" });
    const errors = validateManifest(manifest);
    if (errors.length > 0) return res.status(400).json({ error: "Invalid manifest", errors });
    // Only publishes that pass validation count against the author's budget —
    // iterating on a manifest must not exhaust it. Invalid attempts store
    // nothing and cost only a pure-function validation.
    if (!publishAllowed(user.email)) return res.status(429).json({ error: "Too many publishes, try again later" });
    const result = packId
      ? registry.publishVersion({ email: user.email, id: packId, manifest })
      : registry.publish({ email: user.email, manifest });
    if (result?.error === "not_found") return res.status(404).json({ error: "Pack not found" });
    if (result?.error === "forbidden") return res.status(403).json({ error: "Only the pack author may publish new versions" });
    res.json(result);
  });

  // Browse: paginated, searchable listing of live packs.
  app.get("/api/packs", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const { search = "", tag = "", page, pageSize } = req.query;
    res.json(registry.list({ search: String(search), tag: String(tag), page, pageSize, viewer: { email: user.email, admin: isAdmin(user) } }));
  });

  // Latest-version detail. An unlisted pack stays visible to its author and
  // active subscribers; the author additionally sees the subscriber count.
  app.get("/api/packs/:id", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    const isSubscriber = Boolean(registry.subscription(user.email, id));
    const pack = registry.get(id, { includeUnlisted: isAuthor || isSubscriber });
    // Private packs answer not-found to everyone but the owner and admins —
    // indistinguishable from a nonexistent pack (openspec: pack-visibility).
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    if (isAuthor) pack.subscriberCount = registry.subscriberCount(id);
    res.json(pack);
  });

  // A stored version is always retrievable, listed or not.
  app.get("/api/packs/:id/versions/:version", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const pack = registry.packRowPublic?.(req.params.id);
    const v = registry.getVersion(req.params.id, req.params.version);
    const visible = v && registry.visibleTo(pack, user, { admin: isAdmin(user) });
    if (!visible) return res.status(404).json({ error: "Pack version not found" });
    res.json(v);
  });

  // PUBLIC raw SKILL.md per pack skill (add-a2a-agent-serving D3): the
  // registry's skill registration fetches skill_md_url ANONYMOUSLY to
  // validate, so this route serves the body with synthesized frontmatter
  // (name/description from the manifest — pack skills are body-only) to any
  // caller. Pack skill bodies are already shown in full to every market
  // user; anonymous raw-md exposure is the same content, machine-shaped.
  // Registered before the authenticated routes; no auth check by design.
  app.get("/api/packs/:id/versions/:version/skills/:skill", (req, res) => {
    const version = registry.getVersion(req.params.id, req.params.version);
    // The URL always carries .md; normalize so the lookup never sees it (the
    // auth exemption matches on the .md suffix, path-to-regexp keeps it in
    // the param on some versions).
    const wanted = String(req.params.skill).replace(/\.md$/, "");
    const skill = version?.manifest?.skills?.find((s) => s.name === wanted);
    if (!skill) return res.status(404).type("text/plain").send("skill not found");
    const fm = [`---`, `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`, `---`, ""].join("\n");
    res.type("text/markdown").send(`${fm}${skill.content}`);
  });

  // Deploy a stored version's serving-contract roles as Agent Services
  // (add-a2a-agent-serving 3.2). Idempotent per (pack, agent): the registry
  // entry is upserted in place and the bookkeeping row follows. Gate: the
  // pack's author or a creator-group member (the same population that may
  // publish). Env (`AGENT_SERVING_*`, falling back to the market vars) or an
  // injected `deployConfig` supplies the registry wiring; a missing runner
  // URL answers 503, not a silent success.
  app.post("/api/packs/:id/versions/:version/deploy", express.json({ limit: "64kb" }), async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    // Private packs deploy for their owner (and admins) only — creators-group
    // strangers get the same not-found a nonexistent pack gives.
    const packRowRec = registry.packRowPublic(id);
    if (packRowRec?.visibility === "private" && !registry.visibleTo(packRowRec, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    if (!isAuthor && !isCreator(user)) return res.status(403).json({ error: "Pack author or creator group required" });

    const version = registry.getVersion(id, req.params.version);
    if (!version) return res.status(404).json({ error: "Pack version not found" });

    const cfg = deployConfig();
    if (!cfg.runnerBaseUrl) {
      return res.status(503).json({ error: "Agent serving is not configured on this deployment (AGENT_SERVING_RUNNER_URL)" });
    }
    // Rhythm overrides (add-agent-residency D7): { "<agentId>": entries | null }
    // — deployer-set effective rhythm, validated under the same rules the
    // manifest enforces (one shape definition, two enforcement points).
    const rhythms = req.body?.rhythms;
    if (rhythms !== undefined) {
      if (!rhythms || typeof rhythms !== "object" || Array.isArray(rhythms)) {
        return res.status(400).json({ error: "rhythms must be an object of { agentId: rhythm entries }" });
      }
      for (const [agentId, entries] of Object.entries(rhythms)) {
        if (entries === null) continue; // explicit clear back to none
        const errs = validateRhythm(entries);
        if (errs.length > 0) {
          return res.status(400).json({ error: `rhythm override for '${agentId}' is invalid: ${errs[0].error}` });
        }
      }
    }
    // ── Platform billing linkage (add-agent-platform-ops D1–D3) ──────────
    // Degrades to the pre-③ behavior when no admin key is wired: no gate,
    // no per-agent keys — deploy proceeds on the runner's shared quota.
    const sub2api = cfg.sub2api
      ? createSub2apiClient(cfg.sub2api)
      : null;
    let billing = { linked: false };
    let billingKeys = {};
    const billingKeyValues = new Map(); // keyRef → plaintext (never logged)
    if (sub2api && !sub2api.degraded()) {
      const check = await sub2api.selfCheck();
      if (!check.ok) {
        console.warn(`[packs] sub2api self-check failed — billing degraded: ${check.reason}`);
      } else {
        let account = registry.billingAccount(user.email);
        let ensured;
        try {
          ensured = await sub2api.ensureDeployerUser(user.email);
        } catch (err) {
          return res.status(502).json({ error: `billing account check failed: ${err.message}` });
        }
        if (!account || account.user_id !== ensured.userId || (ensured.password && !account.password)) {
          registry.saveBillingAccount({ email: user.email, userId: ensured.userId, password: ensured.password });
          account = registry.billingAccount(user.email);
        }
        const floor = Number(process.env.DEPLOY_BALANCE_FLOOR ?? 0.5);
        let balance;
        try {
          balance = (await sub2api.readUser(ensured.userId)).balance;
        } catch (err) {
          return res.status(502).json({ error: `billing balance read failed: ${err.message}` });
        }
        if (balance <= floor) {
          return res.status(402).json({
            error: `insufficient balance (${balance.toFixed(2)}) — the deploy gate needs more than ${floor}. Recharge path: contact the operator.`,
            balance,
            floor,
          });
        }
        // Mint one metered key per serving agent (before the registry push so
        // the descriptor can carry the reference). The plaintext lands ONLY
        // in the platform's deployment_keys store.
        const quota = Number(process.env.AGENT_KEY_QUOTA_USD ?? 5);
        const rl5h = Number(process.env.AGENT_KEY_RL_5H_USD ?? 1);
        const rl1d = Number(process.env.AGENT_KEY_RL_1D_USD ?? 3);
        const rl7d = Number(process.env.AGENT_KEY_RL_7D_USD ?? 10);
        if (account.password) {
          for (const agent of version.manifest.agents ?? []) {
            if (!agent?.serving) continue;
            try {
              const m = await sub2api.mintAgentKey({
                email: user.email,
                password: account.password,
                name: `${id}/${agent.id}`,
                quotaUsd: quota, rl5hUsd: rl5h, rl1dUsd: rl1d, rl7dUsd: rl7d,
              });
              const ref = m.keyId ?? m.key;
              billingKeys[agent.id] = ref;
              billingKeyValues.set(ref, m.key);
            } catch (err) {
              return res.status(502).json({ error: `billing key mint failed for ${agent.id}: ${err.message}` });
            }
          }
        } else {
          console.warn(`[packs] no stored password for ${user.email}'s sub2api account — deploying without per-agent keys`);
        }
        billing = { linked: true, balance, floor };
      }
    }

    let out;
    try {
      out = await deployToRegistry({
        packId: id,
        version: version.version,
        manifest: version.manifest,
        rhythmOverrides: rhythms ?? {},
        billingKeys,
        ...cfg,
      });
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 ? err.status : 502;
      return res.status(status).json({ error: err.message });
    }
    for (const d of out.deployed) {
      registry.recordDeployment({
        packId: id,
        agentId: d.agentId,
        version: version.version,
        agentPath: d.agentPath,
        skillPaths: d.skills,
        email: user.email,
      });
      // Persist the minted key value once the registry push succeeded. The
      // map was built keyed by agent id; missing entry = degraded minting.
      const keyRef = billingKeys[d.agentId];
      if (keyRef != null) {
        const stored = registry.deploymentKeyByRef(keyRef);
        // keyId is the reference; the VALUE rides in a side map from minting.
        registry.recordDeploymentKey({
          packId: id, agentId: d.agentId, keyRef,
          keyValue: billingKeyValues.get(keyRef) ?? stored?.keyValue ?? "",
          deployer: user.email,
        });
      }
    }
    res.json({
      deployed: out.deployed.map((d) => ({
        agentId: d.agentId, agentPath: d.agentPath, skills: d.skills, card: d.card,
        ...(billingKeys[d.agentId] != null ? { billingKeyRef: billingKeys[d.agentId] } : {}),
      })),
      billing,
      effectiveWithinSecs: out.effectiveWithinSecs,
    });
  });

  // The deployer's own balance (add-agent-platform-ops D3): one read for the
  // deploy surface. Unlinked billing answers { linked: false } — the surface
  // hides the readout instead of guessing.
  app.get("/api/packs/billing/me", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const cfg = deployConfig();
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    if (!sub2api || sub2api.degraded()) return res.json({ linked: false, balance: null });
    const account = registry.billingAccount(user.email);
    if (!account) return res.json({ linked: true, balance: null, known: false });
    try {
      const u = await sub2api.readUser(account.user_id);
      res.json({ linked: true, balance: u.balance, known: true });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Billing board (add-agent-platform-ops D5): one read for the ops console —
  // deployed agents with their key refs, per-deployer balances, and the
  // linkage state. Authenticated like the internal key route (runner service
  // credential) or by an admin user.
  app.get("/api/packs/billing/board", async (req, res) => {
    const cfg = deployConfig();
    const token = cfg?.token || "";
    const asAdmin = (() => {
      const user = resolveUser(req);
      return user && adminGroups.some((g) => (user.groups || []).includes(g));
    })();
    if (!asAdmin && (!token || req.headers.authorization !== `Bearer ${token}`)) {
      return res.status(401).json({ error: "admin or runner service credential required" });
    }
    const keys = registry.listDeploymentKeys();
    let balances = [];
    let degraded = true;
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    if (sub2api && !sub2api.degraded()) {
      try {
        const emails = [...new Set(keys.map((k) => k.deployer))];
        balances = await Promise.all(
          emails.map(async (email) => {
            const acct = registry.billingAccount(email);
            if (!acct) return { email, balance: null };
            const u = await sub2api.readUser(acct.user_id);
            return { email, balance: u.balance, status: u.status };
          }),
        );
        degraded = false;
      } catch (e) {
        console.warn(`[packs] billing board balance read failed: ${e.message}`);
      }
    }
    res.json({ degraded, keys, balances });
  });

  // Internal: the runner fetches a deployed agent's billing key by reference
  // (add-agent-platform-ops D2). Authenticated by the runner's REGISTRY
  // service credential — the same trust plane the runner already uses for
  // packs data; NOT a public predicate. Every fetch is audit-logged.
  app.get("/api/packs/internal/llm-key/:keyRef", (req, res) => {
    const expected = (cfg) => `Bearer ${cfg?.token || ""}`;
    const token = deployConfig()?.token || "";
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: "runner service credential required" });
    }
    const rec = registry.deploymentKeyByRef(req.params.keyRef);
    if (!rec || !rec.keyValue) return res.status(404).json({ error: "unknown or unkeyed deployment" });
    console.log(`[packs] llm-key fetched by runner (ref ${req.params.keyRef}, agent ${rec.agentId})`);
    res.json({ keyRef: req.params.keyRef, agentId: rec.agentId, keyValue: rec.keyValue });
  });

  // Deployed roles of a pack (3.3): the unpublish warning's and the deploy
  // button's data. Online/offline health itself comes from the registry via
  // the catalog's a2a entries — this list is the "deployed" fact. The paused
  // flag (add-agent-residency) is a best-effort live read of each entry's
  // metadata; unreachable registry ⇒ flags omitted, never an error.
  app.get("/api/packs/:id/deployments", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const rows = registry.deployments(req.params.id);
    const cfg = deployConfig();
    const paused = {};
    if (cfg.registryUrl) {
      for (const r of rows) {
        try {
          // cfg.fetchImpl (tests) wins; prod builds the real registry call.
          const doFetch =
            cfg.fetchImpl ??
            ((p, init = {}) =>
              fetch(`${cfg.registryUrl.replace(/\/+$/, "")}${p}`, {
                ...init,
                headers: { ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...(init.headers ?? {}) },
              }));
          const entry = await (await doFetch(`/api/agents${r.agentPath}`)).json();
          paused[r.agentId] = entry?.metadata?.paused === true;
        } catch { /* flag omitted */ }
      }
    }
    res.json({ deployments: rows.map((r) => ({ ...r, paused: paused[r.agentId] ?? false })) });
  });

  // Pause/resume (add-agent-residency D5): deployer-facing, reversible — the
  // registry entry's metadata flag is the truth the runner polls. Kill = the
  // platform emergency stop writing the SAME flag through an admin gate; the
  // resume path is identical regardless of who paused. Undeploy is untouched.
  const pauseAction = (paused) => async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    if (!isAuthor && !isCreator(user)) return res.status(403).json({ error: "Pack author or creator group required" });
    const row = registry.deployments(id).find((d) => d.agentId === req.params.agentId);
    if (!row) return res.status(404).json({ error: "Deployment not found" });
    const cfg = deployConfig();
    if (!cfg.registryUrl) return res.status(503).json({ error: "Agent serving is not configured on this deployment" });
    try {
      const out = await setAgentPaused({ ...cfg, agentPath: row.agentPath, paused });
      res.json({ ...out, effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  };
  app.post("/api/packs/:id/deployments/:agentId/pause", pauseAction(true));
  app.post("/api/packs/:id/deployments/:agentId/resume", pauseAction(false));

  // The platform emergency stop (add-agent-residency D5): admin-gated, writes
  // the same paused flag — a deployer resume restores.
  app.post("/api/packs/:id/deployments/:agentId/kill", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!isAdmin(user)) return res.status(403).json({ error: "Admin group required" });
    const row = registry.deployments(req.params.id).find((d) => d.agentId === req.params.agentId);
    if (!row) return res.status(404).json({ error: "Deployment not found" });
    const cfg = deployConfig();
    if (!cfg.registryUrl) return res.status(503).json({ error: "Agent serving is not configured on this deployment" });
    try {
      const out = await setAgentPaused({ ...cfg, agentPath: row.agentPath, paused: true });
      res.json({ ...out, by: "platform", effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  });

  // Unpublish: author-checked unlist. Unknown pack and foreign pack answer
  // identically (the revoke pattern — probing teaches nothing). Deployed
  // Agent Services are NOT cascaded (spec: undeploy is independent) — the
  // response names them so the UI can warn.
  app.post("/api/packs/:id/unpublish", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!registry.setUnlisted({ email: user.email, id: req.params.id })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    res.json({ ok: true, deployments: registry.deployments(req.params.id) });
  });

  // Subscribe: records the subscription and hands back the full manifest of
  // the current version so the browser can drive its cell's install in one
  // round trip. Unlisted packs take no new subscribers.
  app.post("/api/packs/:id/subscribe", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    // Private packs install for their owner (and admins) only — everyone
    // else gets the not-found answer (openspec: pack-visibility).
    const pack = registry.packRowPublic(req.params.id);
    if (!registry.visibleTo(pack, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const sub = registry.subscribe({ email: user.email, id: req.params.id });
    if (!sub) return res.status(404).json({ error: "Pack not found" });
    res.json({ packId: req.params.id, version: sub.version, manifest: sub.manifest });
  });

  app.delete("/api/packs/:id/subscribe", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    registry.unsubscribe({ email: user.email, id: req.params.id });
    res.json({ ok: true });
  });
}
