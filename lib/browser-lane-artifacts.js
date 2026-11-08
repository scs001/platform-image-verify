// ── Shared browser lane: artifacts follow the calling cell ─────────────────
//
// slim-browser-lane-footprint D4. One shared playwright MCP means ONE
// --output-dir, while the pre-shared lane injected a per-cell
// BROWSER_OUTPUT_DIR (the session workspace) so /api/files could serve the
// screenshot and the resource-capture hook would accept it. Two mechanisms put
// this lane's outputs back inside the calling cell's workspace:
//
//   1. Named artifacts — `browser_take_screenshot` / `browser_pdf_save` take a
//      `filename` (and `saveAs`), which the frontend rewrites to an ABSOLUTE
//      path under the cell's artifact dir before forwarding. Basename only: a
//      caller-supplied path must never escape its own cell (nor reach for
//      another one), so directories and `..` are stripped.
//   2. Unnamed artifacts — the CLI's own auto-named snapshots land in the
//      shared --output-dir. After each successful call the frontend sweeps
//      files that appeared during that call and moves them into the caller's
//      artifact dir. Concurrent calls can race on an auto-named file; the
//      window is one call's duration and the loser's file still lands inside a
//      cell dir, which is the property the spec cares about (a cell never reads
//      another cell's artifact — the sweep never crosses a cell dir).
//
// The artifact dir lives INSIDE the cell workspace on purpose: that is the root
// the cell's file API serves, so the spec's "cell A 见到、cell B 见不到" holds by
// the same mechanism as every other workspace file.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export const ARTIFACT_SUBDIR = "browser";
// Tool arguments that name an output file. `path`/`paths` are deliberately
// absent: they are INPUT paths (uploads) and rewriting them would break the
// caller's own file selection.
export const NAMED_OUTPUT_KEYS = Object.freeze(["filename", "saveAs"]);

export function artifactDirForCell({ cellId, cellsRoot, outputRoot, sessionId }) {
  if (cellId && cellsRoot) return join(cellsRoot, cellId, "workspace", ARTIFACT_SUBDIR);
  // No trustworthy identity: a private scratch dir, never a client claim.
  return join(outputRoot || "", `unowned-${sessionId || "session"}`);
}

export function ensureDir(dir) {
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// Basename only, and refuse the degenerate results: a caller may not choose
// where the file goes, only what it is called.
export function safeArtifactName(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const name = basename(raw.replace(/\\/g, "/"));
  if (!name || name === "." || name === ".." || name === "/") return null;
  return name;
}

// Returns { args, rewritten } — a NEW args object; the caller's is untouched so
// an upstream error can be reported against the original request.
export function rewriteArtifactArgs(args, artifactDir) {
  if (!args || typeof args !== "object" || !artifactDir) return { args, rewritten: [] };
  const rewritten = [];
  const next = { ...args };
  for (const key of NAMED_OUTPUT_KEYS) {
    const value = next[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const name = safeArtifactName(value);
    if (!name) {
      delete next[key]; // unusable name → let the CLI auto-name it (swept later)
      continue;
    }
    next[key] = join(artifactDir, name);
    rewritten.push({ key, from: value, to: next[key] });
  }
  return { args: next, rewritten };
}

// Files directly under `root` (not directories, not inside a cell subdir) whose
// mtime is at or after `sinceMs`. Cell dirs are nested under the same root only
// when outputRoot == a cell workspace; the shared root holds flat files, so a
// shallow scan is the honest shape and never walks into another cell.
export function newFilesSince({ root, sinceMs, skip }) {
  if (!root) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skipSet = new Set(skip ? [].concat(skip) : []);
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(root, entry.name);
    if (skipSet.has(full)) continue;
    try {
      const st = statSync(full);
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      out.push({ path: full, name: entry.name, size: st.size });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return out;
}

// Move every file that appeared during one call into the caller's dir.
// Same-name collisions get a numeric suffix instead of overwriting (an
// auto-named file belongs to whoever produced it, not to a later caller).
export function adoptNewFiles({ root, into, sinceMs }) {
  const moved = [];
  if (!root || !into) return moved;
  if (ensureDir(into) === null && !existsSync(into)) return moved;
  for (const file of newFilesSince({ root, sinceMs })) {
    let target = join(into, file.name);
    if (existsSync(target) || target === file.path) {
      const dot = file.name.lastIndexOf(".");
      const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
      const ext = dot > 0 ? file.name.slice(dot) : "";
      let n = 1;
      target = join(into, `${stem}-${n}${ext}`);
      while (existsSync(target)) {
        n += 1;
        target = join(into, `${stem}-${n}${ext}`);
      }
    }
    try {
      renameSync(file.path, target);
      moved.push({ from: file.path, to: target });
    } catch {
      /* cross-device or racing reader — the file stays in the shared root */
    }
  }
  return moved;
}
