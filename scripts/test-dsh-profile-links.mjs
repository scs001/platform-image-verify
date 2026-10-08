// Regression self-check for the profile bridge-package linking
// (dsh-profile.js → linkProfilePinnedModules).
//
// The deployment may hand the profile its WHOLE module tree as one symlink —
// the image layout ($DSH_HOME/profiles/platform/node_modules →
// /opt/dsh/node_modules). The four bridge packages then already resolve
// inside that frozen tree, and "clearing" an existing entry rms THROUGH the
// symlink: the real package leaves the install and the app's copy takes its
// place (mixed rc generations). Observed on image-publish 37847464206 — the
// boot passed /api/config, the platform's own boot mutated /opt/dsh, and the
// dsh-contracts step then reported four packages "resolving outside the
// candidate tree". This test pins both halves: the frozen tree survives, and
// the packaged-desktop layout (profile dir without a tree link) still gets
// its links.
//
// Runs entirely inside a temp DSH_HOME (set before the module loads, because
// dsh-profile resolves its paths at import time), so the developer's real
// ~/.dsh is never written.
//
// Run: node scripts/test-dsh-profile-links.mjs

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const PKGS = [
  "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-sdk-jsonrpc-server",
];

const root = mkdtempSync(path.join(tmpdir(), "dsh-profile-links-"));
const home = path.join(root, "home");
const shared = path.join(root, "shared"); // the deployment's frozen tree

process.env.DSH_HOME = home;
process.env.DSH_SHARED_HOME = path.join(root, "no-shared-home"); // ensureDshHome must not auto-link

// The frozen tree: real directories carrying a marker version.
for (const pkg of PKGS) {
  const dir = path.join(shared, "node_modules", pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version: "0.1.1-rc.2-matrix" }));
}

const profileDir = path.join(home, "profiles", "platform");
const moduleDir = path.join(profileDir, "node_modules");
const profile = await import("../dsh-profile.js");

// ── case 1: deployment-provided whole-tree link (the image layout) ──────────
mkdirSync(profileDir, { recursive: true });
symlinkSync(path.join(shared, "node_modules"), moduleDir, "dir");
profile.ensureDshHome();
for (const pkg of PKGS) {
  const entry = path.join(shared, "node_modules", pkg);
  assert.ok(existsSync(entry), `${pkg}: frozen-tree entry survived`);
  assert.equal(lstatSync(entry).isSymbolicLink(), false, `${pkg}: frozen-tree entry was replaced by a symlink`);
  assert.equal(
    JSON.parse(readFileSync(path.join(entry, "package.json"), "utf8")).version,
    "0.1.1-rc.2-matrix",
    `${pkg}: frozen version intact`,
  );
}

// ── case 2: packaged desktop — profile dir without any tree link ────────────
// The v1.3.6 shape: nothing provides the profile's node_modules, so the app's
// own copies must be linked in or the child dies on the first bare import.
rmSync(path.join(home, "profiles"), { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
profile.ensureDshHome();
for (const pkg of PKGS) {
  const link = path.join(moduleDir, pkg);
  assert.ok(lstatSync(link).isSymbolicLink(), `${pkg}: desktop link created`);
  assert.equal(realpathSync(link), realpathSync(path.join(APP_NODE_MODULES, pkg)), `${pkg}: desktop link points at the app copy`);
}

// ── case 3: a stale real entry in OUR dir is still cleared and relinked ─────
rmSync(moduleDir, { recursive: true, force: true });
mkdirSync(path.join(moduleDir, PKGS[0]), { recursive: true }); // an earlier build's leftover
profile.ensureDshHome();
assert.ok(lstatSync(path.join(moduleDir, PKGS[0])).isSymbolicLink(), "stale real entry replaced with the app copy link");

// ── case 4: the frozen tree is NEVER written to — even to "repair" it ───────
// A foreign symlink inside the deployment's tree (damage from an earlier
// build) must be left exactly as found: re-pointing it is the same
// write-through-the-link the fix exists to prevent, and the frozen content it
// replaced cannot be restored from here. The matrix gate reports the damage
// at boot; the operator rebuilds. Real entries beside it stay untouched too.
rmSync(path.join(home, "profiles"), { recursive: true, force: true });
mkdirSync(profileDir, { recursive: true });
symlinkSync(path.join(shared, "node_modules"), moduleDir, "dir");
const foreign = path.join(root, "foreign-dsh-tools");
mkdirSync(foreign, { recursive: true });
rmSync(path.join(shared, "node_modules", PKGS[0]), { recursive: true, force: true });
symlinkSync(foreign, path.join(shared, "node_modules", PKGS[0]), "dir");
profile.ensureDshHome();
assert.equal(
  realpathSync(path.join(shared, "node_modules", PKGS[0])),
  realpathSync(foreign),
  "foreign symlink left exactly as found",
);
assert.equal(
  lstatSync(path.join(shared, "node_modules", PKGS[1])).isSymbolicLink(),
  false,
  "sibling real entry untouched",
);

rmSync(root, { recursive: true, force: true });
console.log("dsh-profile links: 4/4 cases pass");
