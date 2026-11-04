// extension-store.js
// Business logic layer for managing MCP server configs and custom skills.
// Wraps the db.js CRUD operations and provides market catalog loading.

import { bundledJson } from "./paths.js";
import { readJsonOr } from "./lib/persistence.js";
import * as db from "./db.js";
import { getMarketEntries } from "./registry-bridge.js";
import { mergeAnnotations, projectAnnotation } from "./lib/supply-annotations.js";
import { getRepoSkillAnnotation } from "./lib/market-annotations.js";
import { getFileSkills } from "./server/skills.js";

// Resolved at READ time — see catalog.js: a cwd overlay may land after boot.
const marketCatalogFile = () => bundledJson("market-catalog.json");
const marketCatalogSkillsFile = () => bundledJson("market-catalog-skills.json");

// shared predicate for "this arg needs user input".
// Matches /path/..., your_..., and <...> placeholders.
// Used by both requiresConfig derivation (server) and setup-form field generation (client re-implements the same rule).
export function isPlaceholderArg(arg) {
  return /\/path\//.test(arg) || /^your_/.test(arg) || /^<.*>$/.test(arg);
}

// Header-value variant: substring match, since header values embed the
// placeholder ("Bearer <your_token>") rather than being the bare placeholder.
// The client setup form re-implements this rule (McpServerForm hasPlaceholder).
function hasPlaceholder(value) {
  return (
    typeof value === "string" &&
    (/\/path\//.test(value) || /your_/.test(value) || /<[^<>]+>/.test(value))
  );
}

// Derive whether a catalog entry needs user-supplied config.
function requiresConfig(template) {
  if (!template) return false;
  const env = template.env || {};
  if (Object.keys(env).length > 0) return true;
  const headers = template.headers || {};
  if (Object.values(headers).some(hasPlaceholder)) return true;
  const args = template.args || [];
  return args.some(isPlaceholderArg);
}

// ── MCP Server Configs ───────────────────────────────────────────────────────

export function listMcpServers() {
  return db.listExtensionConfigs().filter((c) => c.type === "mcp");
}

export function getMcpServer(name) {
  const config = db.getExtensionConfig(name);
  if (!config || config.type !== "mcp") return null;
  return config;
}

// seed on startup — skip if already present (preserves user edits).
// origin/locked/permissions come from the bundle manifest for packaged seeds
// ("bundled", locked, tool allow/deny lists); default to a plain user row.
export function seedMcpServer({ name, config, enabled = true, origin = "user", locked = false, permissions = null }) {
  return db.seedExtensionConfig({ name, type: "mcp", config, enabled, origin, locked, permissions });
}

export function addMcpServer({ name, config, enabled = true, requiredGroups = null }) {
  return db.addExtensionConfig({ name, type: "mcp", config, enabled, requiredGroups });
}

export function updateMcpServer(name, { config, enabled }) {
  return db.updateExtensionConfig(name, { type: "mcp", config, enabled });
}

export function removeMcpServer(name) {
  const server = getMcpServer(name);
  if (!server) return false;
  return db.deleteExtensionConfig(name);
}

export function toggleMcpServer(name, enabled) {
  const server = getMcpServer(name);
  if (!server) return null;
  return db.setExtensionEnabled(name, enabled);
}

// ── Custom Skills ────────────────────────────────────────────────────────────

export function listCustomSkills() {
  return db.listCustomSkills();
}

export function getCustomSkill(name) {
  return db.getCustomSkill(name);
}

// The v30 fields (files/frontmatter/originMeta) pass through verbatim when
// present — object in, JSON column storage, object out. Callers that omit
// them (the user-edit path, packs) keep the old single-file behavior.
const SKILL_V30_KEYS = ["files", "frontmatter", "originMeta"];

function pickV30(extra) {
  const out = {};
  for (const k of SKILL_V30_KEYS) if (extra[k] !== undefined) out[k] = extra[k];
  return out;
}

export function addCustomSkill({ name, description, content, enabled = true, ...extra }) {
  return db.addCustomSkill({ name, description, content, enabled, ...pickV30(extra) });
}

export function updateCustomSkill(name, { description, content, enabled, ...extra }) {
  return db.updateCustomSkill(name, { description, content, enabled, ...pickV30(extra) });
}

export function removeCustomSkill(name) {
  const skill = getCustomSkill(name);
  if (!skill) return false;
  return db.deleteCustomSkill(name);
}

export function toggleCustomSkill(name, enabled) {
  const skill = getCustomSkill(name);
  if (!skill) return null;
  return db.setCustomSkillEnabled(name, enabled);
}

// ── Market Catalog ───────────────────────────────────────────────────────────

let marketCatalogCache = null;
let marketCatalogSkillsCache = null;

export async function loadMarketCatalog() {
  if (marketCatalogCache) return marketCatalogCache;
  const doc = readJsonOr(marketCatalogFile(), null, { label: "extensions" });
  // readJsonOr warns on parse errors; a missing/invalid file degrades to the
  // empty catalog (fresh installs ship without market catalogs).
  marketCatalogCache = doc ?? { mcpServers: [] };
  return marketCatalogCache;
}

export async function loadMarketCatalogSkills() {
  if (marketCatalogSkillsCache) return marketCatalogSkillsCache;
  const doc = readJsonOr(marketCatalogSkillsFile(), null, { label: "extensions" });
  marketCatalogSkillsCache = doc ?? { skills: [] };
  return marketCatalogSkillsCache;
}

export async function getMarketCatalog(user = null) {
  const { mcpServers, skills } = await mergedMarketCatalog();
  const servers = mcpServers.map((s) => ({
    ...s,
    requiresConfig: requiresConfig(s.configTemplate),
  }));
  // sort ready-to-use first, then alphabetical. The JSON file order is a hint, this is the source of truth.
  servers.sort((a, b) => {
    if (a.requiresConfig !== b.requiresConfig) return a.requiresConfig ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return {
    mcpServers: servers.filter((s) => visibleToUser(s, user)),
    skills: skills.filter((s) => visibleToUser(s, user)),
  };
}

// The merged catalog BEFORE per-user visibility filtering — the install
// admission check needs an entry's groups even when the requesting user must
// not see it (that's exactly the bypass it exists to close).
async function mergedMarketCatalog() {
  const [mcpServers, skills] = await Promise.all([
    loadMarketCatalog(),
    loadMarketCatalogSkills(),
  ]);
  // Registry entries (last-good snapshot from registry-bridge) merge behind
  // the bundled catalog: a bundled entry wins on name collision because it is
  // curated for this deployment.
  const registry = getMarketEntries();
  const bundledMcpNames = new Set((mcpServers.mcpServers || []).map((s) => s.name));
  const registryServers = registry.mcpServers.filter((s) => !bundledMcpNames.has(s.name));
  const bundledSkillNames = new Set((skills.skills || []).map((s) => s.name));
  const registrySkills = registry.skills.filter((s) => !bundledSkillNames.has(s.name));
  const out = {
    mcpServers: [...(mcpServers.mcpServers || []), ...registryServers],
    skills: [...(skills.skills || []), ...registrySkills],
  };
  // Supply annotations (add-mcp-annotation-overlay D2): merge READ-TIME — the
  // registry's metadata.annotations outranks the repo catalog field-by-field
  // (the entry-level bundled-first rule above governs the ENTRY shape, not the
  // annotation, whose truth is shared across planes). Unannotated entries get
  // no annotation key at all — byte-identical to the pre-change payload.
  const registryMcpAnn = new Map(
    registry.mcpServers.filter((s) => s.annotations).map((s) => [s.name, s.annotations]),
  );
  for (const s of out.mcpServers) {
    const merged = mergeAnnotations({ registry: registryMcpAnn.get(s.name), catalog: s.annotation });
    if (merged) s.annotation = merged;
  }
  const registrySkillAnn = new Map(
    registry.skills.filter((s) => s.annotations).map((s) => [s.name, s.annotations]),
  );
  for (const s of out.skills) {
    const merged = mergeAnnotations({ registry: registrySkillAnn.get(s.name), catalog: s.annotation });
    if (merged) s.annotation = merged;
  }
  return out;
}

// Annotations keyed by supply-object name (MCP servers + skills) — the read
// faces attach these to INSTALLED rows too (a row's own config store does not
// carry annotations; the catalog is the annotation truth).
export async function getAnnotationsByName() {
  const { mcpServers, skills } = await mergedMarketCatalog();
  const byName = new Map();
  for (const s of mcpServers) if (s.annotation) byName.set(s.name, s.annotation);
  for (const s of skills) if (s.annotation) byName.set(s.name, s.annotation);
  return byName;
}

// Canonical briefs for the runtime tool-description overlay (add-tool-
// description-enrichment): `{ tools: { "<server>__<leaf>": { brief, source,
// updatedAt } } }` from the merged annotations' canonical track. Only CURATED
// briefs contribute — a human-only annotation enriches nothing (the runtime
// side must never see machine-inferred text). Server-level canonical briefs
// have no single tool-face target and stay out of this index.
export async function getCanonicalBriefs() {
  const { mcpServers } = await mergedMarketCatalog();
  const tools = {};
  for (const s of mcpServers) {
    const ann = s.annotation;
    if (!ann) continue;
    const source = ann.provenance?.source ?? null;
    const updatedAt = ann.provenance?.updatedAt ?? null;
    for (const [leaf, toolAnnotation] of Object.entries(ann.tools || {})) {
      const brief = toolAnnotation?.canonical?.brief;
      if (typeof brief !== "string" || !brief.trim()) continue;
      tools[`${s.name}__${leaf}`] = {
        brief,
        source,
        updatedAt: toolAnnotation.provenance?.updatedAt ?? updatedAt,
      };
    }
  }
  return { tools };
}

// Light annotation index for the chat tool blocks (add-mcp-annotation-overlay
// D5): `{ servers: { name: {label, summary} }, tools: { "<server>__<leaf>":
// {label, summary} } }`, projected to `locale` through the ONE projection
// helper (zh 唯一回落). A tool sub-annotation contributes under every server
// that carries it; unannotated entries contribute nothing (raw rendering).
export async function getSupplyAnnotationIndex(locale) {
  const { mcpServers } = await mergedMarketCatalog();
  const servers = {};
  const tools = {};
  for (const s of mcpServers) {
    if (!s.annotation) continue;
    const projected = projectAnnotation(s.annotation, locale);
    if (projected) {
      servers[s.name] = { label: projected.name, summary: projected.summary };
    }
    for (const [leaf, toolAnnotation] of Object.entries(s.annotation.tools || {})) {
      const projectedTool = projectAnnotation(toolAnnotation, locale);
      if (projectedTool) {
        tools[`${s.name}__${leaf}`] = { label: projectedTool.name, summary: projectedTool.summary };
      }
    }
  }
  // add-skill-display-annotations 3.1: skill labels join the index so chat
  // skill blocks render the localized human label beside the slug. File-skill
  // annotations come from the repo annotation source's `skills` key
  // (origin yizuo-file); absent skills render unchanged.
  const skills = {};
  try {
    // One namespace across BOTH domains (reconciliation R1=方案 B): consumers
    // look up by skill name, never by origin — registry-sourced and file
    // skills contribute alike from the repo annotation source.
    const { listRepoSkillAnnotations } = await import("./lib/market-annotations.js");
    for (const [name, repo] of listRepoSkillAnnotations()) {
      const ann = projectAnnotation(repo.annotation, locale);
      if (ann) {
        skills[name] = { label: ann.name, summary: ann.summary };
      }
    }
  } catch {
    // index unavailable → skill blocks render unchanged (never a throw)
  }
  return { servers, tools, skills };
}

// Resolve a market MCP entry by name for the install admission check.
// Returns null when no catalog entry carries that name (a hand-entered
// config, not a market install — ungated by definition).
export async function findMarketMcpEntry(name) {
  const { mcpServers } = await mergedMarketCatalog();
  return mcpServers.find((s) => s.name === name) || null;
}

// Group visibility for market entries: an entry with a non-empty groups[] is
// served only when the user's groups intersect it. No user (auth off) means
// the requester is the machine owner and everything is visible — matching
// requireAdmin's auth-off semantics (a deployment with no identities has no
// one to exclude).
export function visibleToUser(entry, user) {
  if (!Array.isArray(entry.groups) || entry.groups.length === 0) return true;
  if (!user) return true;
  return (user.groups ?? []).some((g) => entry.groups.includes(g));
}

// Clear caches (for testing or when catalog files change)
export function clearMarketCatalogCache() {
  marketCatalogCache = null;
  marketCatalogSkillsCache = null;
}
