// ── Supply spine store (add-supply-store-unification) ───────────────────────
//
// The ONE physical registration store for the skill and MCP species: entries,
// visibility/groups, tool-list snapshots, supply annotations, provenance —
// in the same SQLite file the pack registry already uses (WAL, ensureSchema,
// dump discipline), so the five-species reconciliation is naturally one
// transaction. The registry (mcp-registry) becomes a read-through execution
// adapter: it pulls the read-only projection over HTTP and serves from its
// local replica; it never writes registration rows again.
//
// Write gate: every write names an actor (identity email or service
// principal) and a source ("gate" direct, "facade" via the registry compat
// facade, "migration" the one-shot loader). "legacy-direct" — the historical
// mongosh-patch class — is structurally refused, and every accepted write
// lands an audit row. Column set mirrors the legacy Mongo document 1:1 so the
// migrator is a straight row copy and unknown fields are reportable.
//
// Fail-closed visibility: rows always carry the `visibility` field (NULL =
// unset = not public). Catalog consumers honour it via `visibleTo`'s native
// branch — an entry that carries the field is only anonymous-visible when it
// is exactly "public" (groups still gate on top). Bridge-legacy entries don't
// carry the key, so the incumbent no-groups-is-public rule is untouched.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { mergeAnnotations } from "../lib/supply-annotations.js";

// standardize-mcp-public-endpoints: the internal-form guard, ported from
// registry-bridge's INTERNAL_URL_PATTERN (keep the two in sync by test — the
// bridge exports isInternalFormUrl but importing the bridge here would carry
// its module-scope env reads into every supply-store importer).
const INTERNAL_URL_PATTERN =
  /^https?:\/\/([^/]*mesh\.finddata\.cn|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|127\.\d+\.\d+\.\d+|localhost)(:\d+)?/i;

function isInternalFormUrl(candidate) {
  return typeof candidate === "string" && INTERNAL_URL_PATTERN.test(candidate);
}

export const SPINE_WRITE_SOURCES = ["gate", "facade", "migration"];

export class SupplyStoreError extends Error {
  constructor({ status, code, message }) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MCP_SERVER_COLUMNS = [
  "id", "display_name", "description", "proxy_pass_url", "num_tools", "tool_list",
  "tags", "license", "provider_organization", "deployment", "metadata",
  "visibility", "groups", "is_enabled",
];
const SKILL_COLUMNS = [
  "name", "display_name", "description", "repository_url", "author", "version",
  "tags", "license", "metadata", "visibility", "groups", "is_enabled",
];

function parseJson(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function rowToMcp(row) {
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    description: row.description,
    proxy_pass_url: row.proxy_pass_url,
    num_tools: row.num_tools,
    tool_list: parseJson(row.tool_list, null),
    tags: parseJson(row.tags, null),
    license: row.license,
    provider_organization: row.provider_organization,
    deployment: row.deployment,
    metadata: parseJson(row.metadata, null),
    visibility: row.visibility,
    groups: parseJson(row.groups, null),
    is_enabled: row.is_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function rowToSkill(row) {
  if (!row) return null;
  return {
    name: row.name,
    display_name: row.display_name,
    description: row.description,
    repository_url: row.repository_url,
    author: row.author,
    version: row.version,
    tags: parseJson(row.tags, null),
    license: row.license,
    metadata: parseJson(row.metadata, null),
    visibility: row.visibility,
    groups: parseJson(row.groups, null),
    is_enabled: row.is_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

// Tool snapshot helpers mirror registry-bridge's contract (toolListNames /
// toolDetails) without importing the bridge — module-scope env reads there
// make the import a side effect this module must not carry. Keep the two in
// sync by test, not by import.
function toolListNames(toolList) {
  if (!Array.isArray(toolList)) return null;
  const names = toolList
    .map((t) => (t && typeof t === "object" ? t.name : t))
    .filter((n) => typeof n === "string" && n);
  return names;
}

function toolDetails(toolList) {
  if (!Array.isArray(toolList)) return null;
  return toolList
    .filter((t) => t && typeof t === "object" && typeof t.name === "string")
    .map((t) => ({ name: t.name, description: t.description ?? null }));
}

export function createSupplyStore({ file, gatewayBase = "", now = () => Date.now() }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    description TEXT,
    proxy_pass_url TEXT NOT NULL,
    num_tools INTEGER,
    tool_list TEXT,
    tags TEXT,
    license TEXT,
    provider_organization TEXT,
    deployment TEXT,
    metadata TEXT,
    visibility TEXT,
    groups TEXT,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    display_name TEXT,
    description TEXT,
    repository_url TEXT,
    author TEXT,
    version TEXT,
    tags TEXT,
    license TEXT,
    metadata TEXT,
    visibility TEXT,
    groups TEXT,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS supply_write_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    source TEXT NOT NULL,
    detail TEXT
  )`);

  const insertAudit = db.prepare(
    `INSERT INTO supply_write_audit (ts, actor, action, entity_type, entity_id, source, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // The write gate. Every spine write passes here exactly once.
  function guardWrite({ actor, source }) {
    if (source === "legacy-direct") {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_LEGACY_DIRECT_WRITE",
        message: "registration writes via the legacy direct channel are retired; submit through the spine write gate",
      });
    }
    if (!SPINE_WRITE_SOURCES.includes(source)) {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_UNKNOWN_WRITE_SOURCE",
        message: `unknown write source "${source}"; expected one of ${SPINE_WRITE_SOURCES.join(", ")}`,
      });
    }
    if (!actor || typeof actor !== "string" || !actor.trim()) {
      throw new SupplyStoreError({
        status: 401,
        code: "SUPPLY_UNIDENTIFIED_WRITE",
        message: "every spine write must name the acting identity",
      });
    }
  }

  function stampMcpUpsert(entry) {
    if (!entry || typeof entry !== "object") {
      throw new SupplyStoreError({ status: 400, code: "SUPPLY_BAD_ENTRY", message: "entry object required" });
    }
    if (!entry.id || typeof entry.id !== "string" || !entry.id.startsWith("/")) {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_BAD_ENTRY",
        message: "mcp_servers.id must be the entry path with a leading slash (legacy _id semantics)",
      });
    }
    if (!entry.proxy_pass_url || typeof entry.proxy_pass_url !== "string") {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_BAD_ENTRY",
        message: "proxy_pass_url is required",
      });
    }
    const unknown = Object.keys(entry).filter((k) => !MCP_SERVER_COLUMNS.includes(k) && !["updated_at", "updated_by", "created_at"].includes(k));
    if (unknown.length > 0) {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_UNKNOWN_FIELD",
        message: `unknown mcp_servers field(s): ${unknown.join(", ")} — report and map them, never drop silently`,
      });
    }
  }

  const upsertMcpServer = ({ actor, source, entry }) => {
    guardWrite({ actor, source });
    stampMcpUpsert(entry);
    const ts = now();
    db.prepare(
      `INSERT INTO mcp_servers (${MCP_SERVER_COLUMNS.join(",")}, created_at, updated_at, updated_by)
       VALUES (${MCP_SERVER_COLUMNS.map(() => "?").join(",")}, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name=excluded.display_name, description=excluded.description,
         proxy_pass_url=excluded.proxy_pass_url, num_tools=excluded.num_tools,
         tool_list=excluded.tool_list, tags=excluded.tags, license=excluded.license,
         provider_organization=excluded.provider_organization, deployment=excluded.deployment,
         metadata=excluded.metadata, visibility=excluded.visibility, groups=excluded.groups,
         is_enabled=excluded.is_enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).run(
      entry.id, entry.display_name ?? null, entry.description ?? null, entry.proxy_pass_url,
      entry.num_tools ?? null, entry.tool_list == null ? null : JSON.stringify(entry.tool_list),
      entry.tags == null ? null : JSON.stringify(entry.tags), entry.license ?? null,
      entry.provider_organization ?? null, entry.deployment ?? null,
      entry.metadata == null ? null : JSON.stringify(entry.metadata),
      entry.visibility ?? null, entry.groups == null ? null : JSON.stringify(entry.groups),
      entry.is_enabled === false ? 0 : 1, ts, ts, actor,
    );
    insertAudit.run(ts, actor, "upsert", "mcp_server", entry.id, source, null);
    return getMcpServer(entry.id);
  };

  const patchMcpServer = (id, { actor, source, fields }) => {
    guardWrite({ actor, source });
    const existing = getMcpServer(id);
    if (!existing) {
      throw new SupplyStoreError({ status: 404, code: "SUPPLY_NOT_FOUND", message: `no mcp_servers row ${id}` });
    }
    const patchable = ["display_name", "description", "proxy_pass_url", "num_tools", "tool_list", "tags", "license", "provider_organization", "deployment", "metadata", "visibility", "groups", "is_enabled"];
    const unknown = Object.keys(fields ?? {}).filter((k) => !patchable.includes(k));
    if (unknown.length > 0) {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_UNKNOWN_FIELD",
        message: `unknown mcp_servers patch field(s): ${unknown.join(", ")} — report and map them, never drop silently`,
      });
    }
    const merged = { ...existing, ...(fields ?? {}) };
    merged.id = id;
    return upsertMcpServer({ actor, source, entry: merged });
  };

  const setMcpServerVisibility = (id, { actor, source, visibility, groups }) => {
    return patchMcpServer(id, { actor, source, fields: { visibility: visibility ?? null, groups: groups ?? null } });
  };

  const deleteMcpServer = (id, { actor, source }) => {
    guardWrite({ actor, source });
    const info = db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
    if (info.changes === 0) {
      throw new SupplyStoreError({ status: 404, code: "SUPPLY_NOT_FOUND", message: `no mcp_servers row ${id}` });
    }
    insertAudit.run(now(), actor, "delete", "mcp_server", id, source, null);
  };

  const upsertSkill = ({ actor, source, entry }) => {
    guardWrite({ actor, source });
    if (!entry || typeof entry !== "object" || !entry.name || typeof entry.name !== "string") {
      throw new SupplyStoreError({ status: 400, code: "SUPPLY_BAD_ENTRY", message: "skills.name is required" });
    }
    const unknown = Object.keys(entry).filter((k) => !SKILL_COLUMNS.includes(k) && !["updated_at", "updated_by", "created_at"].includes(k));
    if (unknown.length > 0) {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_UNKNOWN_FIELD",
        message: `unknown skills field(s): ${unknown.join(", ")} — report and map them, never drop silently`,
      });
    }
    const ts = now();
    db.prepare(
      `INSERT INTO skills (${SKILL_COLUMNS.join(",")}, created_at, updated_at, updated_by)
       VALUES (${SKILL_COLUMNS.map(() => "?").join(",")}, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         display_name=excluded.display_name, description=excluded.description,
         repository_url=excluded.repository_url, author=excluded.author, version=excluded.version,
         tags=excluded.tags, license=excluded.license, metadata=excluded.metadata,
         visibility=excluded.visibility, groups=excluded.groups, is_enabled=excluded.is_enabled,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).run(
      entry.name, entry.display_name ?? null, entry.description ?? null, entry.repository_url ?? null,
      entry.author ?? null, entry.version ?? null,
      entry.tags == null ? null : JSON.stringify(entry.tags), entry.license ?? null,
      entry.metadata == null ? null : JSON.stringify(entry.metadata),
      entry.visibility ?? null, entry.groups == null ? null : JSON.stringify(entry.groups),
      entry.is_enabled === false ? 0 : 1, ts, ts, actor,
    );
    insertAudit.run(ts, actor, "upsert", "skill", entry.name, source, null);
    return getSkill(entry.name);
  };

  const patchSkill = (name, { actor, source, fields }) => {
    guardWrite({ actor, source });
    const existing = getSkill(name);
    if (!existing) {
      throw new SupplyStoreError({ status: 404, code: "SUPPLY_NOT_FOUND", message: `no skills row ${name}` });
    }
    const patchable = ["display_name", "description", "repository_url", "author", "version", "tags", "license", "metadata", "visibility", "groups", "is_enabled"];
    const unknown = Object.keys(fields ?? {}).filter((k) => !patchable.includes(k));
    if (unknown.length > 0) {
      throw new SupplyStoreError({
        status: 400,
        code: "SUPPLY_UNKNOWN_FIELD",
        message: `unknown skills patch field(s): ${unknown.join(", ")} — report and map them, never drop silently`,
      });
    }
    const merged = { ...existing, ...(fields ?? {}) };
    merged.name = name;
    return upsertSkill({ actor, source, entry: merged });
  };

  const setSkillVisibility = (name, { actor, source, visibility, groups }) => {
    return patchSkill(name, { actor, source, fields: { visibility: visibility ?? null, groups: groups ?? null } });
  };

  const deleteSkill = (name, { actor, source }) => {
    guardWrite({ actor, source });
    const info = db.prepare(`DELETE FROM skills WHERE name = ?`).run(name);
    if (info.changes === 0) {
      throw new SupplyStoreError({ status: 404, code: "SUPPLY_NOT_FOUND", message: `no skills row ${name}` });
    }
    insertAudit.run(now(), actor, "delete", "skill", name, source, null);
  };

  const getMcpServer = (id) => rowToMcp(db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`).get(id));
  const listMcpServers = () => db.prepare(`SELECT * FROM mcp_servers ORDER BY id`).all().map(rowToMcp);
  const getSkill = (name) => rowToSkill(db.prepare(`SELECT * FROM skills WHERE name = ?`).get(name));
  const listSkills = () => db.prepare(`SELECT * FROM skills ORDER BY name`).all().map(rowToSkill);

  // The one visibility predicate for spine-sourced entries: the row always
  // carries `visibility`, so the fail-closed branch applies — anything not
  // exactly "public" is not anonymous-visible; groups gate on top of public.
  // (mcp-catalog's visibleTo adds the same branch for entries that carry the
  // field; bridge-legacy entries without the key keep incumbent semantics.)
  const visibleToViewer = (entry, viewerGroups) => {
    if (entry.visibility !== "public") return false;
    const required = Array.isArray(entry.groups) ? entry.groups : [];
    const groups = new Set(viewerGroups ?? []);
    return required.length === 0 || required.some((g) => groups.has(g));
  };

  // M2M read-only projection (the registry's pull source): full rows including
  // visibility/groups — the replica needs everything to route and gate.
  const projectionPayload = ({ since } = {}) => {
    const sinceMs = Number.isFinite(Number(since)) && since !== undefined && since !== "" ? Number(since) : null;
    const mcpRows = sinceMs == null
      ? listMcpServers()
      : db.prepare(`SELECT * FROM mcp_servers WHERE updated_at > ? ORDER BY id`).all(sinceMs).map(rowToMcp);
    const skillRows = sinceMs == null
      ? listSkills()
      : db.prepare(`SELECT * FROM skills WHERE updated_at > ? ORDER BY name`).all(sinceMs).map(rowToSkill);
    return { asOf: now(), mcpServers: mcpRows, skills: skillRows };
  };

  // Catalog read face (facet cards / skills listing): market-entry shape the
  // registry-bridge mappers produce, endpoint derived from the PUBLIC gateway
  // base — the upstream proxy_pass_url never reaches a consumer surface.
  // Client-visible endpoint overrides (registry mcp_endpoint, standardize-
  // mcp-public-endpoints) win when they are public-form; internal-form
  // candidates fall back to the gateway-derived URL (same guard semantics as
  // the bridge's consumerEndpointFor — one posture, two planes).
  // Disabled rows drop; visibility is carried for the fail-closed branch.
  const catalogMcpEntries = ({ repoAnnotationFn = null } = {}) =>
    listMcpServers()
      .filter((r) => r.is_enabled !== 0)
      .map((r) => {
        const name = r.id.startsWith("/") ? r.id.slice(1) : r.id;
        const meta = r.metadata ?? {};
        const annotations = mergeAnnotations({
          registry: meta.annotations ?? null,
          catalog: repoAnnotationFn ? repoAnnotationFn(name) : null,
        });
        const override = typeof meta.mcp_endpoint === "string" ? meta.mcp_endpoint.trim() : "";
        const gatewayDerived = `${gatewayBase.replace(/\/+$/, "")}/${name}/mcp`;
        const endpoint =
          override && !isInternalFormUrl(override) ? override : gatewayDerived;
        return {
          name,
          displayName: r.display_name || name,
          description: r.description || "",
          category: Array.isArray(r.tags) && r.tags[0] ? String(r.tags[0]) : "Registry",
          icon: "box",
          configTemplate: {
            url: endpoint,
            headers: { Authorization: "Bearer <your_token>" },
          },
          installInstructions: "Served through your MCP gateway. Fill in your gateway access token.",
          origin: "supply-store",
          groups: Array.isArray(r.groups) ? r.groups : [],
          visibility: r.visibility,
          toolList: toolListNames(r.tool_list),
          toolDetails: toolDetails(r.tool_list),
          license: r.license && r.license !== "N/A" ? r.license : null,
          providerOrganization: r.provider_organization ?? null,
          numTools: Number.isFinite(Number(r.num_tools)) ? Number(r.num_tools) : null,
          tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t)) : [],
          deployment: r.deployment ?? null,
          credentialRef: typeof meta.credential_ref === "string" && meta.credential_ref ? meta.credential_ref : null,
          annotations,
        };
      });

  const catalogSkillEntries = ({ repoAnnotationFn = null } = {}) =>
    listSkills()
      .filter((r) => r.is_enabled !== 0)
      .map((r) => {
        const meta = r.metadata ?? {};
        const annotations = mergeAnnotations({
          registry: meta.annotations ?? null,
          catalog: repoAnnotationFn ? repoAnnotationFn(r.name) : null,
        });
        return {
          name: r.name,
          displayName: r.display_name || r.name,
          description: r.description || "",
          repositoryUrl: r.repository_url ?? null,
          author: r.author ?? null,
          version: r.version ?? null,
          tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t)) : [],
          groups: Array.isArray(r.groups) ? r.groups : [],
          visibility: r.visibility,
          license: r.license ?? null,
          credentialRef: typeof meta.credential_ref === "string" && meta.credential_ref ? meta.credential_ref : null,
          annotations,
        };
      });

  const listAudit = ({ limit = 100 } = {}) =>
    db.prepare(`SELECT * FROM supply_write_audit ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(1000, limit)));

  return {
    db,
    upsertMcpServer,
    patchMcpServer,
    setMcpServerVisibility,
    deleteMcpServer,
    upsertSkill,
    patchSkill,
    setSkillVisibility,
    deleteSkill,
    getMcpServer,
    listMcpServers,
    getSkill,
    listSkills,
    visibleToViewer,
    projectionPayload,
    catalogMcpEntries,
    catalogSkillEntries,
    listAudit,
  };
}

// ── HTTP faces ───────────────────────────────────────────────────────────────
//
// Two channels, one secret each (same posture as FACET_INTERNAL_TOKEN):
//   · projection (read-only) — the registry replica's pull source;
//   · write gate — the registry compat facade and the migration loader.
// Writes carry `actor` in the body: the token authenticates the CHANNEL, the
// actor names the acting identity and lands in the audit row.

import { timingSafeEqual } from "node:crypto";

function bearerMatches(header, expected) {
  if (!expected) return false;
  const presented = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function handleSupplyError(res, err) {
  if (err instanceof SupplyStoreError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  throw err;
}

const parseBodyJson = (raw) => {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw; // express.json() already parsed
  try {
    return JSON.parse(raw);
  } catch {
    throw new SupplyStoreError({ status: 400, code: "SUPPLY_BAD_BODY", message: "request body must be JSON" });
  }
};

export function registerSupplyStoreRoutes(app, { store, projectionToken = "", writeToken = "" }) {
  const requireProjection = (req, res, next) => {
    if (!bearerMatches(req.headers.authorization, projectionToken)) {
      return res.status(401).json({ error: "projection channel requires the supply-store projection token", code: "SUPPLY_UNAUTHORIZED" });
    }
    next();
  };
  const requireWrite = (req, res, next) => {
    if (!bearerMatches(req.headers.authorization, writeToken)) {
      return res.status(401).json({ error: "write gate requires the supply-store write token", code: "SUPPLY_UNAUTHORIZED" });
    }
    next();
  };

  app.get("/api/supply-store/projection", requireProjection, (req, res) => {
    res.json(store.projectionPayload({ since: req.query.since }));
  });

  const writeRoute = (path, handler) => {
    app.post(path, requireWrite, (req, res) => {
      try {
        const body = parseBodyJson(req.body ?? {});
        res.json(handler(body) ?? { ok: true });
      } catch (err) {
        handleSupplyError(res, err);
      }
    });
  };

  writeRoute("/api/supply-store/mcp-servers/upsert", (b) => store.upsertMcpServer({ actor: b.actor, source: b.source ?? "facade", entry: b.entry }));
  writeRoute("/api/supply-store/mcp-servers/patch", (b) => store.patchMcpServer(b.id, { actor: b.actor, source: b.source ?? "facade", fields: b.fields }));
  writeRoute("/api/supply-store/mcp-servers/visibility", (b) => store.setMcpServerVisibility(b.id, { actor: b.actor, source: b.source ?? "facade", visibility: b.visibility, groups: b.groups }));
  writeRoute("/api/supply-store/mcp-servers/delete", (b) => { store.deleteMcpServer(b.id, { actor: b.actor, source: b.source ?? "facade" }); return { ok: true }; });

  writeRoute("/api/supply-store/skills/upsert", (b) => store.upsertSkill({ actor: b.actor, source: b.source ?? "facade", entry: b.entry }));
  writeRoute("/api/supply-store/skills/patch", (b) => store.patchSkill(b.name, { actor: b.actor, source: b.source ?? "facade", fields: b.fields }));
  writeRoute("/api/supply-store/skills/visibility", (b) => store.setSkillVisibility(b.name, { actor: b.actor, source: b.source ?? "facade", visibility: b.visibility, groups: b.groups }));
  writeRoute("/api/supply-store/skills/delete", (b) => { store.deleteSkill(b.name, { actor: b.actor, source: b.source ?? "facade" }); return { ok: true }; });
}
