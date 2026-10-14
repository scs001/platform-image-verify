#!/usr/bin/env node
// ── Post-build verification: bundled resources are present ──────────────────
//
// Asserts the bundled standalone Node exists in resources/ before packing an
// installer — server.js always runs on it, so a missing one produces a broken
// app. Also warns when macOS code-signing credentials are absent.
//
// OpenConnector/LiteLLM/Postgres are no longer bundled (dsh's native plugins
// cover LLM routing and SaaS connectors), so the bundled Node is the only
// resource to check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RESOURCES_ROOT = path.join(PROJECT_ROOT, "resources");

const IS_WIN = process.platform === "win32";
const nodePath = path.join(RESOURCES_ROOT, "node", ...(IS_WIN ? ["node.exe"] : ["bin", "node"]));

console.log("🔍 Verifying bundled resources...");

let allGood = true;
if (fs.existsSync(nodePath)) {
  console.log("✅ Bundled Node: OK");
} else {
  console.error(`❌ Bundled Node missing at: ${nodePath}`);
  allGood = false;
}

// The dsh runtime must be present in the tree the installer packs — a packaged
// install cannot fall back to a global `dsh` (win-install-smoke 2026-10-08:
// spawn dsh ENOENT on a clean machine). The bundled bin.js is exactly the path
// dsh-bridge.js resolves at runtime.
//
// Single-source assertion (single-source-desktop-runtime D2/D5): the runtime
// closure is installed from dsh-matrix by scripts/install-dsh-matrix.mjs, so
// the packed dsh version MUST equal the matrix's intent row. A drift here
// means the desktop and the server image are on different runtimes — exactly
// the class of split this change removed.
const bundledDshBin = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const bundledDshPkg = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", "dsh", "package.json");
const matrixManifestPath = path.join(PROJECT_ROOT, "dsh-matrix", "package.json");
if (fs.existsSync(bundledDshBin) && fs.existsSync(bundledDshPkg)) {
  console.log("✅ Bundled dsh runtime bin: OK");
  try {
    const installed = JSON.parse(fs.readFileSync(bundledDshPkg, "utf8")).version;
    const intent = JSON.parse(fs.readFileSync(matrixManifestPath, "utf8")).dependencies?.["@deepseek-ai/dsh"];
    if (intent && installed !== intent) {
      console.error(`❌ Bundled dsh version drift: app tree has ${installed}, dsh-matrix intends ${intent}.`);
      console.error("   Run `node scripts/install-dsh-matrix.mjs` (or the full predist) to re-sync from the matrix.");
      allGood = false;
    } else {
      console.log(`✅ Bundled dsh version matches the matrix intent: ${installed}`);
    }
  } catch (err) {
    console.error(`❌ dsh version assertion could not run: ${err?.message || err}`);
    allGood = false;
  }
} else {
  console.error(`❌ Bundled dsh runtime missing at: ${bundledDshBin}`);
  console.error("   Run predist (scripts/install-dsh-matrix.mjs installs it from dsh-matrix).");
  allGood = false;
}

// The profile bridge plugins import these by bare specifier, and the dsh
// loader resolves them ONLY up the profile dir's own node_modules (dsh-profile
// links them from here on packaged installs). npm auto-installed them as
// peers in dev trees, but legacy-peer-deps installs prune them — a missing
// one resurfaces as a packaged-only bridge boot failure (v1.3.5 round).
const bridgePackages = ["schemastery", "dsh-session", "dsh-tools", "dsh-sdk-jsonrpc-server", "dsh-llm-deepseek"];
for (const pkg of bridgePackages) {
  const pkgDir = path.join(PROJECT_ROOT, "node_modules", "@deepseek-ai", pkg);
  if (fs.existsSync(path.join(pkgDir, "package.json"))) {
    console.log(`✅ Bridge dependency @deepseek-ai/${pkg}: OK`);
  } else {
    console.error(`❌ Bridge dependency @deepseek-ai/${pkg} missing from node_modules — pin it in package.json dependencies.`);
    allGood = false;
  }
}

// Warn about signing if no credentials set
if (!process.env.CSC_LINK && process.platform === "darwin") {
  console.log("\n⚠️  CSC_LINK / CSC_KEY_PASSWORD not set in environment.");
  console.log("   The resulting .dmg will not pass Gatekeeper on other machines.");
  console.log("   Set these env vars before building for a signed, notarized release.\n");
}

if (!allGood) {
  console.error("\n❌ Verification failed: bundled resources are incomplete.");
  console.error("   Run `npm run predist` to build them before `npm run dist`.");
  process.exit(1);
}

console.log("\n✅ Bundled resources OK.");
process.exit(0);
