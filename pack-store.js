// pack-store.js
// Business logic for the pack marketplace's cell side (add-pack-marketplace):
// creator drafts, and the materialization of a subscribed pack's version
// snapshot into this cell — skills into the custom-skills store (hot-reloaded
// via skill-materialize), MCP references through the existing registry-market
// install path (subscriber's own credential; never a secret in the pack),
// agent personas picked up by the catalog's pack source (which turns them into
// local persona presets through the existing catalog machinery), and bot
// units into the cell's bot storage (pack-bot-units — a generic-type row
// born disabled and awaiting the operator's channel credentials).
//
// Conflict policy is uniform and one-directional: packs never overwrite
// foreign content. A skill, agent, or bot id owned by anyone else is skipped
// with a reported reason; the pack's own rows are replaced on
// reinstall/upgrade; MCP server configurations are shared utilities — reused
// when present, never removed on uninstall. Uninstalling a pack removes its
// own bot rows but keeps the operator's channel credentials in a detach
// ledger, so a later install (of any pack declaring the same bot id)
// reattaches them instead of demanding the operator re-enter everything.

import crypto from "node:crypto";
import { join, dirname } from "node:path";
import fs from "node:fs";
import * as db from "./db.js";
import * as skillMaterialize from "./skill-materialize.js";
import * as extensionStore from "./extension-store.js";
import * as credentialRefs from "./credential-refs.js";
import * as bots from "./server/bots.js";
import { validatePackManifest, skillScriptFiles } from "./lib/pack-manifest.js";
import {
  PACK_BOT_CREDENTIAL_KEY,
  packBotMeta,
} from "./lib/generic-bot-types.js";
import { storeDir } from "./paths.js";

function notFound(msg) {
  return Object.assign(new Error(msg), { status: 404 });
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export function listDrafts() {
  return db.listPackDrafts();
}

export function getDraft(id) {
  const draft = db.getPackDraft(id);
  if (!draft) throw notFound("Draft not found");
  return draft;
}

export function createDraft({ name, description, tags, entries }) {
  if (!name || !String(name).trim()) {
    throw Object.assign(new Error("Draft name required"), { status: 400 });
  }
  return db.createPackDraft({ name: String(name).trim(), description, tags, entries });
}

export function updateDraft(id, patch) {
  getDraft(id);
  return db.updatePackDraft(id, patch);
}

export function deleteDraft(id) {
  if (!db.deletePackDraft(id)) throw notFound("Draft not found");
  return { ok: true };
}

// ── Install (subscribe / upgrade) ────────────────────────────────────────────

// Who owns an agent id besides the installing pack (conflict check). Returns
// { kind: "pack", name } for another installed pack, { kind: "custom", name }
// for a custom preset holding the id (add-custom-presets D6 — the market's
// one-directional never-overwrite-foreign-content policy treats custom
// presets as owners too), or null when the id is free.
function agentOwner(agentId, excludePackId) {
  for (const installed of db.listInstalledPacks()) {
    if (installed.packId === excludePackId) continue;
    if ((installed.manifest?.agents ?? []).some((a) => a?.id === agentId)) {
      return { kind: "pack", name: installed.name };
    }
  }
  const preset = db.getUserPreset(agentId);
  if (preset) return { kind: "custom", name: preset.name };
  return null;
}

// ── Bot units (pack-bot-units) ───────────────────────────────────────────────

// Who owns a bot id besides the installing pack (design D2 — the exact mirror
// of agentOwner's never-overwrite-foreign-content policy, adapted to the fact
// that bots materialize as ROWS: the row is the occupation on the ground).
// Resolution order:
//   1. a row exists carrying THIS pack's metadata → null (the pack's own row:
//      upgrade replaces it);
//   2. a row exists carrying ANOTHER pack's metadata → { kind: "pack", name };
//   3. a row exists with no pack metadata → { kind: "local", name } (the
//      operator's own bot);
//   4. no row, but another INSTALLED pack's manifest declares the id →
//      { kind: "pack", name } — the same claim-based mirror agentOwner uses
//      (its install skipped the id, but the claim still holds the id against
//      this pack while that pack stays installed).
function botOwner(botId, excludePackId) {
  const row = db.getBot(botId);
  if (row) {
    const ownerPackId = packBotMeta(row.credentials)?.packId ?? null;
    if (ownerPackId === excludePackId) return null;
    if (ownerPackId) {
      return { kind: "pack", name: db.getInstalledPack(ownerPackId)?.name ?? ownerPackId };
    }
    return { kind: "local", name: row.name };
  }
  for (const installed of db.listInstalledPacks()) {
    if (installed.packId === excludePackId) continue;
    if ((installed.manifest?.bots ?? []).some((b) => b?.id === botId)) {
      return { kind: "pack", name: installed.name };
    }
  }
  return null;
}

// Detached channel-credential ledger (spec pack-bot-units, uninstall
// boundary): uninstalling a pack deletes its own bot rows but must not
// destroy the channel credentials the OPERATOR configured on them — they are
// the operator's, reusable by any later bot of the same id. A JSON sidecar
// under the platform data dir keyed by bot id; every access is
// failure-isolated (a broken ledger must never fail an install/uninstall).
const KEPT_BOT_CREDENTIALS_PATH = join(storeDir("data"), "kept-bot-credentials.json");

function readKeptBotCredentials() {
  try {
    return JSON.parse(fs.readFileSync(KEPT_BOT_CREDENTIALS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeKeptBotCredentials(ledger) {
  try {
    fs.mkdirSync(dirname(KEPT_BOT_CREDENTIALS_PATH), { recursive: true });
    fs.writeFileSync(KEPT_BOT_CREDENTIALS_PATH, JSON.stringify(ledger, null, 2));
  } catch (e) {
    console.warn(`[packs] could not persist the kept-bot-credential ledger: ${e.message}`);
  }
}

// The operator-owned part of a bot row's credentials — everything except the
// pack bookkeeping key. Empty when the operator never configured the channel.
function operatorCredentials(bot) {
  const { [PACK_BOT_CREDENTIAL_KEY]: _meta, ...rest } = bot.credentials ?? {};
  return rest;
}

// True when the row carries a complete, usable channel binding (the same
// rule the config face enforces on save).
function botConnected(bot) {
  return bots.validateCredentials(bot.type, bot.credentials) === null;
}

// Materialize one pack bot entry into the cell's bot storage. Mirrors the
// skills/agents report shape; never throws (an id conflict skips the entry,
// it never fails the pack). Born posture: disabled, generic-type row, no
// channel credentials — enabling and credentialing are the operator's
// explicit actions (design D2: installing a pack must not widen the webhook
// attack surface). Kept credentials from a previous install of the same bot
// id are reattached (still born disabled) so an uninstall/reinstall cycle
// does not demand re-entering the operator's setup.
function installPackBot(packId, botEntry, report) {
  const owner = botOwner(botEntry.id, packId);
  if (owner) {
    report.bots.push({
      id: botEntry.id,
      name: botEntry.name,
      status: "skipped",
      reason: owner.kind === "local"
        ? `bot id is held by local bot "${owner.name}"`
        : `bot id is owned by installed pack "${owner.name}"`,
    });
    return;
  }
  const meta = {
    packId,
    skill: botEntry.skill ?? null,
    generic: botEntry.generic,
  };
  const existing = db.getBot(botEntry.id);
  if (existing) {
    // The pack's own row on upgrade: replace the authored identity and the
    // pack metadata, keep the operator's channel credentials, webhook secret
    // and enabled state (the operator's explicit choices are never reset by
    // an upgrade).
    const credentials = { ...existing.credentials, [PACK_BOT_CREDENTIAL_KEY]: meta };
    const bot = db.updateBot(botEntry.id, { name: botEntry.name, credentials });
    bots.reload(bot);
    report.bots.push({
      id: botEntry.id,
      name: botEntry.name,
      status: "replaced",
      awaitingCredential: !botConnected(bot),
      ...(botConnected(bot) ? {} : { reason: "awaiting the operator's channel credentials (configure and enable it in the bots panel)" }),
    });
    return;
  }
  // Fresh materialization: born disabled. Restore any credentials the
  // operator configured for this bot id before an earlier uninstall.
  const kept = readKeptBotCredentials()[botEntry.id];
  const credentials = { [PACK_BOT_CREDENTIAL_KEY]: meta, ...(kept ?? {}) };
  const bot = db.addBot({
    id: botEntry.id,
    // The row's type names the GENERIC type; the platform adapter is chosen
    // later by the operator's credentials.platform binding (adapterForBot).
    type: botEntry.generic,
    name: botEntry.name,
    credentials,
    secret: crypto.randomBytes(24).toString("base64url"),
    enabled: false,
    ownerEmail: null,
  });
  bots.reload(bot);
  const connected = botConnected(bot);
  report.bots.push({
    id: botEntry.id,
    name: botEntry.name,
    status: "installed",
    awaitingCredential: !connected,
    ...(connected
      ? { reason: "channel credentials restored from a previous install; enable it in the bots panel to go live" }
      : { reason: "awaiting the operator's channel credentials (configure and enable it in the bots panel)" }),
  });
  // Restored credentials are consumed by this row now; drop the ledger entry.
  if (kept) {
    const ledger = readKeptBotCredentials();
    delete ledger[botEntry.id];
    writeKeptBotCredentials(ledger);
  }
}

// Materialize one MCP reference through the market install path. Returns a
// report item; never throws (an unresolvable reference must not block the
// rest of the pack — spec: pack-installation).
//
// Local binding (add-mcp-tool-scoping D4): a reference whose name has no
// registry-market entry may bind to a locally installed server of that name
// (the user's own deployment). The binding records NOTHING — no extension
// row is written, the local row's configuration is untouched, no group gate
// or market credential applies (the row carries its own). The allowlist
// travels with the pack's stored manifest, so the focused composition picks
// the binding up purely by name intersection — and a reference that matches
// neither surface awaits one instead of failing the pack.

// Credential-ref install dispatch (add-facet-market-credentials D4) now lives
// on the dispatch table itself (credential-refs.js) — a second install path
// (the market card install in routes/extensions) consumes it too. These
// forwarders keep this module's established imports working; new code should
// import from credential-refs.js.
export const credentialRefForEntry = credentialRefs.credentialRefForEntry;
export const credentialConnected = credentialRefs.credentialConnected;
export const credentialMissingReason = credentialRefs.credentialMissingReason;
export const connectPathForRef = credentialRefs.connectPathForRef;

async function installMcpRef(ref, { user }) {
  const name = ref.registryName;
  const item = { name, status: "unavailable" };
  const entry = await extensionStore.findMarketMcpEntry(name);
  if (entry && entry.origin === "registry") {
    if (!extensionStore.visibleToUser(entry, user)) {
      return { ...item, reason: `requires group: ${(entry.groups ?? []).join(", ")}` };
    }
    if (extensionStore.getMcpServer(name)) {
      return { name, status: "reused" };
    }
    // Credential dispatch (add-facet-market-credentials D4): the registering
    // line declares which 壹座-side credentialRef its entry needs
    // (metadata.credential_ref); absent = the incumbent registry credential.
    const refName = credentialRefForEntry(entry);
    const connected = credentialConnected(refName, user?.email ?? null);
    if (!connected) {
      return {
        ...item,
        reason: credentialMissingReason(refName),
        code: "credential-required",
        connectPath: connectPathForRef(refName),
      };
    }
    // Registry-origin installs are credential-shaped: strip the template's
    // placeholder auth and reference the stored credential for that ref.
    const { headers: _placeholderHeaders, ...rest } = entry.configTemplate ?? {};
    const config = { ...rest, credentialRef: refName };
    extensionStore.addMcpServer({
      name,
      config,
      enabled: true,
      requiredGroups: entry.groups?.length ? entry.groups : null,
    });
    return { name, status: "installed" };
  }
  if (entry) {
    return { ...item, reason: "not a registry server (packs may only reference registry entries or bind a local server of the same name)" };
  }
  // No market entry: a local row of this name is a binding (registry entries
  // take precedence when both exist — the branch above).
  if (extensionStore.getMcpServer(name)) {
    return { name, status: "bound", reason: "bound to the local server of this name (its configuration is untouched)" };
  }
  return {
    name,
    status: "awaiting-local-binding",
    reason: "no registry entry and no local server of this name yet — install or connect one to activate this reference",
  };
}

// Install (or upgrade to) a pack version snapshot. `manifest` arrives via the
// browser (design D8) so it is re-validated here — the same rules the gateway
// enforced at publish. Returns { report, installed, effects } where `effects`
// tells the route which downstream refreshes to fire.
//
// add-packaged-skills: a pack whose skills carry script files installs only
// with an explicit `confirm` (D5 — one upfront acknowledgment, enforced here
// so both request shapes, body manifest and server-side fetch, are gated).
export async function installPack({ packId, version, manifest, user, confirm = false, hooks = {} }) {
  if (!packId || !manifest?.name || !Number.isInteger(Number(version))) {
    throw Object.assign(new Error("packId, version, and manifest are required"), { status: 400 });
  }
  const errors = validatePackManifest(manifest);
  if (errors.length > 0) {
    throw Object.assign(new Error("Invalid manifest"), { status: 400, details: errors });
  }
  // Script confirm gate: name the offending skills and their scripts so the
  // client can render the acknowledgment without a second round-trip.
  const scriptBearers = (manifest.skills ?? [])
    .map((s) => ({ name: s.name, scriptFiles: skillScriptFiles(s) }))
    .filter((b) => b.scriptFiles.length > 0);
  if (scriptBearers.length > 0 && confirm !== true) {
    throw Object.assign(
      new Error("This pack carries executable script files; explicit confirmation is required to install it"),
      { status: 400, code: "script-confirm-required", details: scriptBearers },
    );
  }
  const ver = Number(version);
  const report = { skills: [], mcpServers: [], agents: [], bots: [] };
  const effects = { mcpChanged: false, catalogChanged: false, botsChanged: false };

  for (const skill of manifest.skills ?? []) {
    const existing = db.getCustomSkill(skill.name);
    if (existing && existing.originPackId !== packId) {
      report.skills.push({
        name: skill.name,
        status: "skipped",
        reason: "a skill with this name already exists and is not owned by this pack",
      });
      continue;
    }
    // files/frontmatter ride both write paths wholesale (`?? null` — an
    // upgrade that drops a file clears it; updateCustomSkill treats undefined
    // as untouched). The materializer/DB columns are 刀二's, unchanged.
    const pkg = { files: skill.files ?? null, frontmatter: skill.frontmatter ?? null };
    let row;
    if (existing) {
      db.updateCustomSkill(skill.name, { description: skill.description, content: skill.content, ...pkg });
      row = db.stampSkillPackVersion(skill.name, ver);
    } else {
      row = db.addCustomSkill({
        name: skill.name,
        description: skill.description,
        content: skill.content,
        originPackId: packId,
        originPackVersion: ver,
        ...pkg,
      });
    }
    skillMaterialize.writeSkill(row);
    // Report disclosure (D5): fileCount + scriptFiles on tree skills only —
    // legacy single-document rows keep their byte-identical shape.
    const item = { name: skill.name, status: existing ? "replaced" : "installed" };
    if (skill.files) {
      item.fileCount = Object.keys(skill.files).length;
      item.scriptFiles = skillScriptFiles(skill);
    }
    report.skills.push(item);
  }

  for (const ref of manifest.mcpServers ?? []) {
    const item = await installMcpRef(ref, { user });
    report.mcpServers.push(item);
    if (item.status === "installed") effects.mcpChanged = true;
  }

  for (const agent of manifest.agents ?? []) {
    const owner = agentOwner(agent.id, packId);
    if (owner) {
      report.agents.push({
        id: agent.id,
        name: agent.name,
        status: "skipped",
        reason: owner.kind === "custom"
          ? `agent id is held by custom preset "${owner.name}"`
          : `agent id is owned by installed pack "${owner.name}"`,
      });
      continue;
    }
    report.agents.push({ id: agent.id, name: agent.name, status: "installed" });
    effects.catalogChanged = true;
  }

  // Bot units (pack-bot-units): materialize into the cell's bot storage.
  // Never fails the pack — a conflicting id skips with a reported reason.
  for (const botEntry of manifest.bots ?? []) {
    installPackBot(packId, botEntry, report);
    effects.botsChanged = true;
  }

  const installed = db.upsertInstalledPack({ packId, name: manifest.name, version: ver, manifest, report });

  // Downstream refreshes: MCP configs reach dsh through the profile patch;
  // pack agents reach the picker through the catalog's pack source, and their
  // persona presets regenerate from it.
  if (effects.mcpChanged) {
    hooks.onMcpChanged?.();
  }
  if (effects.catalogChanged) {
    hooks.onCatalogChanged?.();
  }
  return { report, installed, effects };
}

// ── Uninstall (unsubscribe) ──────────────────────────────────────────────────

// The bot rows this pack owns — its manifest's bot entries whose live row
// still carries this pack's metadata. A bot id the pack declared but never
// materialized (foreign owner at install time) has either no row or someone
// else's row, and is NOT listed: uninstall deletes pack-own rows only.
function packOwnedBots(packId, manifest) {
  const out = [];
  for (const entry of manifest?.bots ?? []) {
    const row = db.getBot(entry?.id);
    if (row && packBotMeta(row.credentials)?.packId === packId) out.push({ entry, row });
  }
  return out;
}

// What an uninstall would remove, before it happens — the confirmation UI's
// data. MCP configurations are never listed as removed: they are shared
// utilities other packs and manual installs may reference. Pack-owned bot
// rows ARE removed, but the operator's channel credentials on them are kept
// in the detach ledger (reported as botsCredentialsKept, the same
// "kept items" philosophy as mcpServersKept).
export function uninstallPreview(packId) {
  const installed = db.getInstalledPack(packId);
  if (!installed) throw notFound("Pack not installed");
  const manifest = installed.manifest ?? {};
  const modifiedSkills = [];
  for (const s of manifest.skills ?? []) {
    const row = db.getCustomSkill(s.name);
    if (row?.originPackId !== packId) continue;
    // add-packaged-skills D8: "modified" covers the whole stored shape — body,
    // auxiliary files, frontmatter — any drift from the installed snapshot
    // warns (JSON key order is stable here: both sides round-trip the stored
    // manifest / row exactly as written).
    const filesChanged = JSON.stringify(row.files ?? null) !== JSON.stringify(s.files ?? null);
    const fmChanged = JSON.stringify(row.frontmatter ?? null) !== JSON.stringify(s.frontmatter ?? null);
    if (row.content !== s.content || filesChanged || fmChanged) modifiedSkills.push(s.name);
  }
  const ownedBots = packOwnedBots(packId, manifest);
  return {
    packId,
    name: installed.name,
    version: installed.version,
    skills: (manifest.skills ?? []).map((s) => s.name),
    modifiedSkills,
    agents: (manifest.agents ?? []).map((a) => ({ id: a.id, name: a.name })),
    bots: ownedBots.map(({ entry, row }) => ({
      id: entry.id,
      name: row.name,
      // The mounted pack skill stops governing the bot's turns with the pack
      // gone; surfaced so the operator knows what the removal changes.
      skill: entry.skill ?? null,
    })),
    // Credentials the operator configured on the pack-owned bots; they go to
    // the detach ledger, not the void — reinstall reattaches them.
    botsCredentialsKept: ownedBots
      .filter(({ row }) => Object.keys(operatorCredentials(row)).length > 0)
      .map(({ entry }) => entry.id),
    mcpServersKept: (manifest.mcpServers ?? []).map((m) => m.registryName),
  };
}

// Remove pack-owned skills, agent entries, and bot rows. Refuses (409) when
// a pack skill was modified after installation unless `force` — the warning
// is a server-side gate, not just a UI nicety. Bot removal deletes the
// pack's own rows only; the operator's channel credentials on them are kept
// in the detach ledger, and nothing on the platform side (webhook
// registrations, platform bot configurations) is touched.
export function uninstallPack({ packId, force = false, hooks = {} }) {
  const preview = uninstallPreview(packId);
  if (preview.modifiedSkills.length > 0 && !force) {
    throw Object.assign(
      new Error(`Modified pack skill(s) will be lost: ${preview.modifiedSkills.join(", ")}`),
      { status: 409, modifiedSkills: preview.modifiedSkills },
    );
  }
  const manifest = db.getInstalledPack(packId).manifest ?? {};
  db.deleteCustomSkillsByPack(packId);
  // Pack skills materialize under the pack's own root (add-pack-agent-
  // scoping): remove the root wholesale. Names skipped at install (foreign
  // owner) never materialized here, so their dirs in other roots survive.
  skillMaterialize.removePackSkills(packId);
  // Pack-owned bot rows: stop the runtime entry, stash the operator's
  // channel credentials in the detach ledger, then delete the row.
  if (preview.bots.length > 0) {
    const ledger = readKeptBotCredentials();
    for (const { entry, row } of packOwnedBots(packId, manifest)) {
      const operatorPart = operatorCredentials(row);
      if (Object.keys(operatorPart).length > 0) ledger[entry.id] = operatorPart;
      bots.stop(row.id);
      db.deleteBot(row.id);
    }
    writeKeptBotCredentials(ledger);
  }
  const hadAgents = (manifest.agents ?? []).length > 0;
  db.deleteInstalledPack(packId);
  // The catalog's pack source drops the entries; syncing now prunes their
  // persona presets and resets a stale selection.
  if (hadAgents) hooks.onCatalogChanged?.();
  if (preview.bots.length > 0) hooks.onBotsChanged?.();
  return {
    packId,
    removedSkills: preview.skills,
    removedAgents: preview.agents.map((a) => a.id),
    removedBots: preview.bots.map((b) => b.id),
    botsCredentialsKept: preview.botsCredentialsKept,
    modifiedSkillsLost: preview.modifiedSkills,
    mcpServersKept: preview.mcpServersKept,
  };
}
