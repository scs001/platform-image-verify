// skill-materialize.js — DB custom skills → SKILL.md files in a watched dir.
//
// dsh-skill-filesystem Chokidar-watches every dir in its customSkillDirs and
// hot-reloads SKILL.md add/change/unlink live (no process restart). The DB is
// the durable store; this module mirrors each custom_skills row into a
// <name>/SKILL.md file so the agent sees DB skills exactly like file skills —
// at startup AND on runtime CRUD.
//
// add-pack-agent-scoping: pack-owned rows (originPackId) materialize under a
// per-pack root (custom-skills/packs/<safePackId>/…), because the skills
// patch scopes by listing roots and discovery does not recurse — a pack's
// skills must live in a root of their own to be focusable. User rows keep the
// flat root. The DB stays the durable store: an installed pack re-materializes
// into the pack root on the first boot after upgrade, no user action.
//
// Atomic writes (temp+rename) match documents.js / writeMcpPatch. The dir is a
// runtime artifact under PLATFORM_DATA_DIR (gitignored), rebuilt idempotently
// from the DB on startup.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteTextSync } from "./lib/persistence.js";
import { storeDir } from "./paths.js";

const MATERIALIZE_DIR = storeDir("custom-skills");
// The reserved per-pack subtree. safeDir() can produce this segment for a
// skill literally named "packs" — see rebuildFromDb for how the two coexist.
const PACKS_SEGMENT = "packs";
const PACKS_DIR = join(MATERIALIZE_DIR, PACKS_SEGMENT);

// Sanitize a skill name into a safe filesystem segment. dsh-skill-filesystem
// keys skills off the frontmatter `name`, not the dir, so the dir name only
// needs to be filesystem-safe and stable across writes.
function safeDir(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, "_");
}

// The root holding one pack's materialized skills.
export function packSkillsRoot(packId) {
  return join(PACKS_DIR, safeDir(packId));
}

// Every pack root that exists on disk — the full-mode skills patch lists them
// all (a focused preset lists only its own; see dsh-profile.deriveScope).
export function listPackSkillsRoots() {
  try {
    return readdirSync(PACKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(PACKS_DIR, d.name));
  } catch {
    return []; // no packs subtree yet — nothing installed
  }
}

// A row's root: pack-owned rows live under the pack root, user rows flat.
function rootFor(skill) {
  return skill?.originPackId ? packSkillsRoot(skill.originPackId) : MATERIALIZE_DIR;
}

function skillFilePath(skill) {
  return join(rootFor(skill), safeDir(skill.name), "SKILL.md");
}

// Render a custom_skills row into a SKILL.md the filesystem plugin can load.
// The body is the user's `content`; the frontmatter carries name+description.
function renderSkillMd({ name, description, content }) {
  const desc = (description || "").replace(/\n/g, " ");
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${content || ""}\n`;
}

// Write one skill's SKILL.md atomically (temp+rename). Returns true on success.
export function writeSkill(skill) {
  if (!skill || !skill.name) return false;
  if (skill.enabled === false) {
    removeSkill(skill);
    return true;
  }
  const file = skillFilePath(skill);
  atomicWriteTextSync(file, renderSkillMd(skill));
  return true;
}

// Remove one skill's materialized dir (Chokidar fires unlink → hot-remove).
// Accepts the row (or a row-shaped { name, originPackId }) so pack-owned
// skills remove from the pack root; a bare string keeps the legacy flat-root
// meaning (user skills).
export function removeSkill(skillOrName) {
  const skill = typeof skillOrName === "string" ? { name: skillOrName } : skillOrName;
  if (!skill?.name) return;
  const dir = join(rootFor(skill), safeDir(skill.name));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

// Remove a whole pack's root (uninstall). Skills skipped at install never
// materialized here — foreign same-named skills live in other roots and are
// untouched by design.
export function removePackSkills(packId) {
  try { rmSync(packSkillsRoot(packId), { recursive: true, force: true }); } catch { /* already gone */ }
}

// Rebuild both materialization roots from the DB: wipe stale entries, write
// every enabled row. Idempotent — safe to call on every startup. Returns the
// list of skills that failed to write (caller may retry).
export function rebuildFromDb(listCustomSkills) {
  let failures = [];
  mkdirSync(MATERIALIZE_DIR, { recursive: true });
  const rows = listCustomSkills() || [];
  const userRows = rows.filter((s) => !s.originPackId);
  const packRows = rows.filter((s) => s.originPackId);

  // Flat root: wipe stale dirs not backed by a current USER row. This is also
  // the no-action migration — pack rows no longer belong here, so their
  // pre-scoping flat dirs are stale by definition and are rewritten into the
  // pack root below. The reserved `packs` subtree is skipped here and
  // reconciled next; the one collision (a user skill literally named "packs")
  // materializes as packs/SKILL.md and survives like any user dir.
  const liveFlat = new Set(userRows.map((s) => safeDir(s.name)));
  let entries = [];
  try { entries = readdirSync(MATERIALIZE_DIR); } catch { /* dir absent */ }
  for (const entry of entries) {
    if (entry === PACKS_SEGMENT) continue;
    if (!liveFlat.has(entry)) {
      try { rmSync(join(MATERIALIZE_DIR, entry), { recursive: true, force: true }); }
      catch { /* best-effort */ }
    }
  }

  // Pack roots: a root with no current rows is stale (uninstalled pack, or
  // junk); inside a live root, skill dirs the pack no longer owns go too
  // (an upgrade that dropped a skill).
  const byPack = new Map();
  for (const s of packRows) {
    const key = safeDir(s.originPackId);
    if (!byPack.has(key)) byPack.set(key, []);
    byPack.get(key).push(s);
  }
  for (const packRoot of listPackSkillsRoots()) {
    const packKey = basename(packRoot);
    if (!byPack.has(packKey)) {
      try { rmSync(packRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
      continue;
    }
    const livePack = new Set(byPack.get(packKey).map((s) => safeDir(s.name)));
    let skillDirs = [];
    try { skillDirs = readdirSync(packRoot); } catch { /* root absent */ }
    for (const d of skillDirs) {
      if (!livePack.has(d)) {
        try { rmSync(join(packRoot, d), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  for (const skill of rows) {
    try {
      if (!writeSkill(skill)) failures.push(skill.name);
    } catch (e) {
      console.warn(`[skill-materialize] write failed for "${skill.name}": ${e.message}`);
      failures.push(skill.name);
    }
  }
  return { dir: MATERIALIZE_DIR, failures };
}

export { MATERIALIZE_DIR };
