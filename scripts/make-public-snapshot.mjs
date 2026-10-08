#!/usr/bin/env node
// Build the open-source snapshot of this private repository.
//
//   node scripts/make-public-snapshot.mjs [--ref HEAD] [--out dist-opensource/platform]
//        [--skip-gitleaks] [--init]
//
// Pipeline:
//   1. Export the committed tree via `git archive <ref>` — gitignored secrets
//      (.env, mcp.json, agents.json, llm-providers.json, .credentials.yaml, …)
//      never enter the snapshot, and neither does uncommitted work.
//   2. Overlay allowlisted working-tree files (README*, LICENSE) so the public
//      docs ship even before the next commit lands them.
//   3. Delete internal-only files/dirs (deploy runbook, cluster manifests,
//      ops tooling, openspec change archives, live-probe scripts, AI-tooling
//      dirs, and this script + its runbook).
//   4. Rewrite internal-infrastructure references in the files that stay.
//      Every scrub is a regex with an expected match count — a refactor that
//      invalidates one fails the build instead of silently shipping a leak.
//   5. Move the tree into dist-opensource/, then verify in place: structural
//      asserts, forbidden-pattern grep over every text file, gitleaks scan.
//      Any finding ⇒ the output is removed and the run exits non-zero.
//
// The output has no git history BY DESIGN: publish it as a NEW public repo.
// Full manual runbook (key rotation, repo creation, facade trio):
// docs/opensource-release.md.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const REF = argValue("--ref", "HEAD");
const OUT = resolve(REPO_ROOT, argValue("--out", "dist-opensource/platform"));
const SKIP_GITLEAKS = args.includes("--skip-gitleaks");
const DO_INIT = args.includes("--init");

if (!/^[A-Za-z0-9._/-]+$/.test(REF)) {
  console.error(`invalid --ref: ${REF}`);
  process.exit(2);
}
const outRel = relative(REPO_ROOT, OUT);
if (outRel.startsWith("..") || !outRel.startsWith("dist-opensource")) {
  // rm -rf safety: this script only ever replaces paths under dist-opensource/.
  console.error(`--out must live under dist-opensource/ (got ${outRel})`);
  process.exit(2);
}

// ─── Tables ───────────────────────────────────────────────────────────────────

// Working-tree files copied over the archived tree (public docs that may not
// be committed yet). All three are REQUIRED.
const OVERLAY_FILES = ["README.md", "README.zh-CN.md", "LICENSE", ".gitleaks.toml"];

const EXCLUDE_PATHS = new Set([
  // internal docs
  "DEPLOY.md", // live prod runbook: clusters, IPs, registries, jenkins
  "PRODUCT.md", // internal product-strategy doc
  "demands.md", // scratch demand notes
  "lawcraw-architecture.md", // legacy pre-rename product notes
  "docs/opensource-release.md", // this feature's private runbook
  "docs/registry-maintenance.md", // internal registry ops runbook (tailnet/jenkins/ips)
  "docs/spider-heal-pack.md", // spider-heal pack ops manual (sub2api keys, mesh dsn)
  "facet/cli/NPM-SCOPE-FIX.md", // npm scope ops runbook: account/org internals
  "docs/facet-cutover-repair-handoff.md", // cross-session repair handoff: live host facts, paths, incident log
  // internal deploy plumbing
  "Makefile", // k8s/argocd deploy wrapper + prod live-service URL
  "Jenkinsfile",
  ".github/workflows/image.yml", // internal TCR/Harbor image pipeline
  // internal ops artifacts
  "docs/vertical-packs.md", // market-registration runbook (internal registry)
  // this tool itself
  "scripts/make-public-snapshot.mjs",
  // internal ops test: fleet board URL (tailnet) + jenkins/harbor/argocd state
  "scripts/test-ops-console-board.mjs",
]);
// internal health MCP: README is operator-facing (tailnet mesh IPs, SSRF
// allowlists, DSN handling) — not curated for the public drop (2026-10-06).
const EXCLUDE_PREFIXES_EXTRA = ["servers/fd-health-mcp/"];

const EXCLUDE_PREFIXES = [
  "k8s/",
  "argocd/",
  "openspec/changes/", // change archives carry live-ops notes (IPs, builds)
  "openspec/specs/ops-console/", // internal operator console capability
  "openspec/specs/live-service-testing/", // probing our live deployment
  "openspec/specs/registry-market-deployment/", // internal market deployment
  "services/ops-console/", // internal operator dashboard
  "docs/vertical-packs/", // sample pack registration data (Logto org ids)
  ".claude/",
  ".pi/",
  ".impeccable/",
  "docs/adr/", // internal decision records: cluster names, registries, ops
  "docs/registry-fork-patches/", // mcp-gateway fork patch notes (internal)
  "docs/dsh-lock-peer-deadlock.md", // internal handoff: private CI runner repo + TCR secrets
];

const EXCLUDE_GLOBS = [
  "scripts/probe-*.mjs", // live probes against company deployments
  "scripts/verify-*live*.mjs", // live verification against company deployments
  "scripts/push_audit_to_wire.py", // internal metering bridge (tailnet fd-wire endpoint)
];

// [file, regex source, replacement, expected count] — applied with flags "g".
// A count mismatch (including 0) on a present file is a hard failure so the
// table cannot rot silently.
const SCRUBS = [
  [".env.example", "\\bDEPLOY\\.md\\b", "the ops runbook", 2],
  [".env.example", "# MC_URL=http://100\\.64\\.0\\.N:3333", "# MC_URL=http://<mission-console-host>:3333", 1],
  [".env.example", "# MC_AGENT_NAME=fd-operator-cell", "# MC_AGENT_NAME=my-operator-cell", 1],
  ["Dockerfile", "harbor\\.local/paas_private/platform", "your-registry/platform", 2],
  [
    "Dockerfile",
    "host \\(Jenkins on cheap-3\\) cannot reach registry-1\\.docker\\.io at all and pulls",
    "host cannot reach registry-1.docker.io and pulls",
    1,
  ],
  [
    "Dockerfile",
    "the cluster's Harbor mirror instead — its Jenkinsfile passes that as",
    "a registry mirror instead — its CI passes that as",
    1,
  ],
  ["Dockerfile", "The China build host \\(Jenkins on cheap-3\\)", "The China build host", 1],
  [
    "Dockerfile",
    'the cheap-1 runner lived "unhealthy" for a generation — 2026-10-07',
    'one runner lived "unhealthy" for a generation',
    1,
  ],
  ["Dockerfile", "DEPLOY\\.md runbook carry the 8790", "ops runbook carries the 8790", 1],
  [
    "agent-runner/manager.js",
    "accumulated evidence on cheap-1: three stale wx dirs",
    "observed in production: three stale wx dirs",
    1,
  ],
  [
    "scripts/release-sync.mjs",
    "production serves /dl/\\* from the platform host via cheap-1 Caddy\\.",
    "production serves /dl/* from the platform host via its edge proxy.",
    1,
  ],
  [
    "Dockerfile",
    "is a 4GB machine that ALSO runs the production pod:",
    "is memory-constrained and shares the node with other workloads:",
    1,
  ],
  [
    "Dockerfile",
    "\\(see DEPLOY\\.md → Agent workspace\\)\\.",
    "(operator's responsibility when /data is a host mount).",
    1,
  ],
  [
    "agent-runner/docker-compose.yml",
    "the tailnet IP in",
    "the private-network IP in",
    1,
  ],
  [
    "agent-runner/docker-compose.yml",
    "\\(ccr yizuo/platform:sha-<short>\\)",
    "(the platform image)",
    1,
  ],
  [
    "agent-runner/docker-compose.yml",
    "ccr\\.ccs\\.tencentyun\\.com/yizuo/platform:latest",
    "platform:latest",
    1,
  ],
  ["agent-runner/config.js", "\\(DEPLOY\\.md runbook\\)\\.", "(operator runbook).", 1],
  [
    "agent-runner/index.js",
    "Runbook: DEPLOY\\.md § agent-runner\\.",
    "Runbook: see the agent-runner design (docs/adr/0004).",
    1,
  ],
  ["services/search-relay/index.js", "documented in DEPLOY\\.md", "documented in the ops runbook", 1],
  ["e2e/mc-bridge.spec.js", "see DEPLOY\\.md\\)", "see the ops runbook)", 1],
  ["registry-bridge.js", "recorded in DEPLOY\\.md", "recorded in the ops runbook", 1],
  [
    "dsh-profile.js",
    "// token\\.finddatatech\\.cloud gateway model catalog\\. 2026-09-30 refresh: every id",
    "// Model gateway catalog (2026-09-30 refresh): every id",
    1,
  ],
  ["docs/pack-marketplace.md", "（DEPLOY\\.md §2）", "（运维手册）", 1],
  [
    "gateway/packs.js",
    "https://token\\.finddatatech\\.cloud",
    "https://your-billing-panel.example",
    2,
  ],
  [
    "gateway/wanxing/index.js",
    "https://token\\.finddatatech\\.cloud",
    "https://your-billing-panel.example",
    1,
  ],
  ["e2e/live-helpers.js", "http://23\\.144\\.68\\.246:30950", "http://127.0.0.1:3000", 2],
  ["e2e/live.spec.js", "http://23\\.144\\.68\\.246:30950", "http://127.0.0.1:3000", 1],
  ["playwright.config.js", "http://23\\.144\\.68\\.246:30950", "http://127.0.0.1:3000", 2],
  ["playwright.config.js", "targets deployed k3s NodePort at", "targets a deployed instance at", 1],
  [
    "docs/spider-heal-pack.md",
    "baseURL \`token\.finddatatech\.cloud/v1\`",
    "baseURL（模型网关，内网）",
    1,
  ],
  [
    "openspec/specs/vertical-packs/spec.md",
    "the OpenAI-compatible endpoint `token\\.finddatatech\\.cloud/v1` \\(model `deepseek-v4-pro`\\)",
    "an OpenAI-compatible endpoint (model `deepseek-v4-pro`)",
    1,
  ],
];

// Deliberate exceptions: content that matches a forbidden pattern but is
// itself spec-mandated public surface. A hit is skipped when the offending
// file lives under one of the listed paths.
const ALLOWED = [
  {
    label: "personal identifier",
    paths: ["facet/web/src/PageFooter.tsx", "openspec/specs/facet-platform/spec.md"],
    why: "facet footer contact (email/phone) is mandated by the facet-platform spec and already live on facet.finddatatech.cloud",
  },
];

// Any match in any snapshot text file fails the build. Patterns are
// deliberately specific: public surfaces (www./craw./demo./mcp.
// finddatatech.cloud, WeChat app ids) are allowed on purpose.
const FORBIDDEN = [
  [/100\.64\.\d+\.\d+/, "tailnet IP"],
  [/103\.236\.\d+\.\d+/, "public server IP"],
  [/23\.144\.68\.\d+/, "public server IP"],
  [/cheap-\d/, "cluster node name"],
  [/guangzhou-xinru/, "internal host name"],
  [/harbor\.finddatatech\.cloud/, "internal registry"],
  [/harbor\.local\/paas_private/, "internal registry path"],
  [/hkccr|tencentcontainers|ccr\.cfs/, "internal image registry"],
  [/[Jj]enkins/, "internal CI"],
  [/token\.finddatatech\.cloud|paas-admin\.finddatatech\.cloud/, "internal-only domain"],
  [/fd-craw-private|fd-infra-deploy/, "private repo name"],
  [/mo2z9kllx2j7|hpe07qejcwk7|sl63fy08ruh9/, "Logto organization id"],
  [/\bDEPLOY\.md\b/, "internal runbook reference"],
  [/1253774197|3106241601/, "personal identifier"],
];

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".woff", ".woff2",
  ".ttf", ".otf", ".gz", ".zip", ".tar", ".node", ".dylib", ".so",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sh(cmd) {
  return execFileSync("bash", ["-c", cmd], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function globToRegExp(glob) {
  const src = glob
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(glob.includes("**") ? ".*" : "[^/]*");
  return new RegExp(`^${src}$`);
}
const GLOB_RES = EXCLUDE_GLOBS.map(globToRegExp);

function isExcluded(relPath) {
  if (EXCLUDE_PATHS.has(relPath)) return true;
  if (EXCLUDE_PREFIXES.some((p) => relPath === p.slice(0, -1) || relPath.startsWith(p))) return true;
  if (EXCLUDE_PREFIXES_EXTRA.some((p) => relPath.startsWith(p))) return true;
  if (GLOB_RES.some((re) => re.test(relPath))) return true;
  return false;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isTextFile(path) {
  if (BINARY_EXT.has(path.slice(path.lastIndexOf(".")))) return false;
  const buf = readFileSync(path);
  return !buf.subarray(0, 8000).includes(0);
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
}

// ─── 1. Export the committed tree ─────────────────────────────────────────────

const commit = sh(`git rev-parse --short ${REF}`);
const dirty = sh("git status --porcelain");
if (dirty) {
  console.log(
    `note: working tree is dirty — only OVERLAY_FILES come from the worktree; everything else is ${REF} (${commit}).`,
  );
}

const tmp = mkdtempSync(join(tmpdir(), "paas-oss-"));
try {
  execFileSync("bash", [
    "-c",
    `git -C ${JSON.stringify(REPO_ROOT)} archive --format=tar ${REF} | tar -x -C ${JSON.stringify(tmp)}`,
  ]);
  console.log(`exported ${REF} (${commit})`);

  // ─── 2. Overlay public docs from the working tree ───────────────────────────

  for (const f of OVERLAY_FILES) {
    const src = join(REPO_ROOT, f);
    if (!existsSync(src)) fail(`overlay file missing in working tree: ${f}`);
    copyFileSync(src, join(tmp, f));
    console.log(`overlay  ${f}`);
  }

  // ─── 3. Exclusions ──────────────────────────────────────────────────────────

  let excluded = 0;
  for (const full of [...walk(tmp)]) {
    if (isExcluded(relative(tmp, full))) {
      rmSync(full);
      excluded++;
    }
  }
  // Prune directories left empty by the exclusions (git archive materializes
  // them; structural asserts require the dirs themselves to be gone).
  const pruneEmpty = (dir) => {
    let empty = true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!pruneEmpty(full)) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && dir !== tmp) rmdirSync(dir);
    return empty;
  };
  pruneEmpty(tmp);
  console.log(`excluded ${excluded} internal file(s)`);

  // ─── 4. Scrubs ──────────────────────────────────────────────────────────────

  let scrubbed = 0;
  for (const [file, find, replace, expect] of SCRUBS) {
    const full = join(tmp, file);
    if (!existsSync(full)) continue; // excluded upstream; asserts below guard structure
    const before = readFileSync(full, "utf8");
    const re = new RegExp(find, "g");
    const count = (before.match(re) || []).length;
    if (count !== expect) {
      fail(`scrub rot in ${file}: pattern matched ${count}×, expected ${expect}× — update the SCRUBS table: ${find}`);
    }
    writeFileSync(full, before.replace(re, replace));
    scrubbed++;
  }
  console.log(`scrubbed ${scrubbed}/${SCRUBS.length} file(s)`);

  // ─── 5. Move into place, then verify ────────────────────────────────────────

  mkdirSync(join(OUT, ".."), { recursive: true });
  rmSync(OUT, { recursive: true, force: true });
  cpSync(tmp, OUT, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`placed   ${relative(REPO_ROOT, OUT)}/`);

  const structural = [
    [existsSync(join(OUT, "README.md")), "README.md present"],
    [existsSync(join(OUT, "README.zh-CN.md")), "README.zh-CN.md present"],
    [existsSync(join(OUT, "LICENSE")), "LICENSE present"],
    [!existsSync(join(OUT, "DEPLOY.md")), "DEPLOY.md absent"],
    [!existsSync(join(OUT, "openspec/changes")), "openspec/changes/ absent"],
    [!existsSync(join(OUT, "Jenkinsfile")), "Jenkinsfile absent"],
    [!existsSync(join(OUT, "k8s")), "k8s/ absent"],
    [
      readFileSync(join(OUT, "README.md"), "utf8").includes("/products/base") &&
        readFileSync(join(OUT, "README.md"), "utf8").includes("README.zh-CN.md"),
      "README.md: base-line banner + zh interlink",
    ],
    [
      readFileSync(join(OUT, "README.zh-CN.md"), "utf8").includes("/products/base") &&
        readFileSync(join(OUT, "README.zh-CN.md"), "utf8").includes("](README.md)"),
      "README.zh-CN.md: base-line banner + en interlink",
    ],
  ];
  for (const [ok, label] of structural) {
    if (!ok) fail(`structural check failed: ${label}`);
    console.log(`assert   ✓ ${label}`);
  }

  const hits = [];
  let textFiles = 0;
  for (const full of walk(OUT)) {
    if (!isTextFile(full)) continue;
    textFiles++;
    const rel = relative(OUT, full);
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const [re, label] of FORBIDDEN) {
        if (!re.test(line)) continue;
        const allow = ALLOWED.find((a) => a.label === label && a.paths.some((p) => rel === p || rel.startsWith(p)));
        if (allow) continue;
        hits.push(`${rel}:${i + 1} [${label}] ${line.trim().slice(0, 100)}`);
      }
    });
  }
  if (hits.length) {
    console.error(`\n✗ forbidden patterns found (${hits.length}):`);
    for (const h of hits) console.error(`  ${h}`);
    fail("scrub or exclude the files above, then re-run");
  }
  console.log(`scan     ✓ no forbidden patterns across ${textFiles} text files`);

  if (!SKIP_GITLEAKS) {
    const cfg = ["--config", join(OUT, ".gitleaks.toml")];
    let res = spawnSync("gitleaks", ["dir", OUT, ...cfg, "--no-banner", "--redact"], { encoding: "utf8" });
    if (/unknown command/i.test(res.stderr || "")) {
      res = spawnSync(
        "gitleaks",
        ["detect", "--no-git", "--source", OUT, ...cfg, "--no-banner", "--redact"],
        { encoding: "utf8" },
      );
    }
    if (res.error) {
      fail(`gitleaks unavailable (${res.error.code}) — brew install gitleaks, or pass --skip-gitleaks`);
    }
    if (res.status !== 0) {
      console.error(res.stdout || res.stderr);
      fail("gitleaks reported findings in the snapshot");
    }
    console.log("gitleaks  ✓ clean");
  }

  // ─── 6. Optional: make it a push-ready git repo ─────────────────────────────

  if (DO_INIT) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: OUT });
    execFileSync("git", ["add", "-A"], { cwd: OUT });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Platform Release",
        "-c",
        "user.email=release@localhost",
        "commit",
        "-q",
        "-m",
        `Platform v1.3.0 — initial open-source release (snapshot of ${REF} ${commit})`,
      ],
      { cwd: OUT },
    );
    console.log("git      ✓ initialized, single release commit");
  }

  console.log(
    `\n✓ snapshot ready: ${OUT}\n  next: follow docs/opensource-release.md §发布.`,
  );
} catch (err) {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
