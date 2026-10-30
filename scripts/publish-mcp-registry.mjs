#!/usr/bin/env node
// ── publish-mcp-registry — the official MCP Registry channel ─────────────────
//
//   node scripts/publish-mcp-registry.mjs --facet-url <url> [--out <dir>]
//                                         [--dry-run] [--publish]
//
// Fetches the facet's projection (`GET {facet-url}/api/mcp-registry.json`),
// writes one `<out>/<namespace>/<server>/server.json` tree, and optionally
// hands each document to `mcp-publisher publish`.
//
// Authentication is NOT this script's business, and deliberately so: publishing
// under the organization namespace (io.github.FindDataTechnology/*) only works
// through GitHub Actions OIDC with `permissions: id-token: write`. The
// interactive `mcp-publisher login github` device flow grants *personal*
// `io.github.<username>/*` only — it cannot read org membership, so it is not a
// supported path here (design D4). A local run therefore stops at --dry-run.
//
// Last-good is the contract, copied from export-marketplace-repo.mjs: build and
// validate into a staging directory first, swap only when the whole batch is
// clean. A failure leaves the previous tree byte-identical.
//
//   --facet-url  base URL of the facet service (required)
//   --out        output tree (default ./mcp-registry-out)
//   --dry-run    fetch + project + validate + report, write nothing
//   --publish    run `mcp-publisher publish` per server (CI only)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};

const FACET_URL = (opt("facet-url") || process.env.FACET_URL || "").replace(/\/+$/, "");
const OUT = path.resolve(opt("out", "mcp-registry-out"));
const DRY = flag("dry-run");
const PUBLISH = flag("publish");

if (!FACET_URL) {
  console.error("用法：node scripts/publish-mcp-registry.mjs --facet-url <url> [--out <dir>] [--dry-run] [--publish]");
  process.exit(2);
}
if (PUBLISH && DRY) {
  console.error("✗ --publish 与 --dry-run 互斥");
  process.exit(2);
}

// Same name pattern the projector enforces and the registry validates. This is
// a second lock on the same door (the source is our own projection), not a new
// rule — a malformed name must never reach the filesystem as a path.
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

// Second lock on reachability: the registry lists for the whole internet, so an
// internal endpoint (cluster mesh host, bare cheapN node, RFC1918, non-https) is
// both a dead link for a stranger and a permanent public leak of our hostnames
// and port layout. The projector already drops these; this refuses them again
// so a projection regression cannot publish one.
const PRIVATE_IP_RE =
  /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0)$/;
function isPublicUrl(u) {
  if (typeof u !== "string" || !/^https:\/\//.test(u)) return false;
  let host;
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (PRIVATE_IP_RE.test(host)) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/(^|\.)mesh\.finddata\.cn$/.test(host)) return false;
  if (/^cheap\d+(\.|$)/.test(host)) return false;
  return true;
}

// The official schema's required fields, checked again here so a broken
// projection cannot be published by a CI run that skipped the unit tests.
function validateDoc(doc) {
  const problems = [];
  if (typeof doc?.name !== "string" || doc.name.split("/").length !== 2 || !NAME_RE.test(doc.name)) {
    problems.push(`name 不是反向 DNS 形：${JSON.stringify(doc?.name)}`);
  }
  if (typeof doc?.description !== "string" || !doc.description.trim()) problems.push("description 缺失或为空");
  if (typeof doc?.version !== "string" || !doc.version.trim()) problems.push("version 缺失");
  if (!Array.isArray(doc?.remotes) || doc.remotes.length === 0) problems.push("remotes 缺失或为空");
  for (const [i, r] of (doc?.remotes ?? []).entries()) {
    if (!["streamable-http", "sse"].includes(r?.type)) problems.push(`remotes[${i}].type 非法：${JSON.stringify(r?.type)}`);
    if (typeof r?.url !== "string" || !/^https?:\/\//.test(r.url)) problems.push(`remotes[${i}].url 非绝对 URL`);
    else if (!isPublicUrl(r.url)) problems.push(`remotes[${i}].url 不可公网达（内网主机/非 https）：${r.url}`);
    if (r && "headers" in r) problems.push(`remotes[${i}].headers 必须整块省略（免键端点）`);
  }
  return problems;
}

async function fetchProjection() {
  const url = `${FACET_URL}/api/mcp-registry.json`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }
  const doc = await res.json();
  if (!Array.isArray(doc?.servers)) throw new Error("投影响应缺少 servers 数组");
  return doc.servers;
}

const servers = await fetchProjection();
console.log(`投影返回 ${servers.length} 个公开 MCP server`);

// Validate the entire batch before touching disk: a single malformed document
// means the projection face is broken, and publishing the rest would hide it.
const rejects = [];
for (const doc of servers) {
  const problems = validateDoc(doc);
  if (problems.length) rejects.push({ name: doc?.name ?? null, problems });
}
if (rejects.length) {
  console.error("✗ 校验失败，整批不发布（last-good 保持）：");
  for (const r of rejects) console.error(`  - ${r.name}: ${r.problems.join("；")}`);
  process.exit(1);
}

if (DRY) {
  for (const doc of servers) console.log(`  ✓ ${doc.name} → ${doc.remotes[0].url}`);
  console.log("✓ 自检通过（--dry-run，未写盘、未发布）");
  console.log("  发布源可见性：本脚本只消费 facet 的公开投影（groups=[] 的 server），");
  console.log("  不读私有仓、不含凭据（remotes 无 headers 块）。");
  process.exit(0);
}

// Stage → validate → swap (same-filesystem atomic rename, as the repo exporter).
const parent = path.dirname(OUT);
mkdirSync(parent, { recursive: true });
const staging = mkdtempSync(path.join(parent, ".mcp-registry-out-staging-"));

try {
  let files = 0;
  for (const doc of servers) {
    // "<namespace>/<server>" → "<namespace>__<server>" is NOT what the registry
    // wants: mcp-publisher reads the tree relative to cwd and takes name from
    // the document itself, so a flat directory per server is the shape.
    const dir = path.join(staging, doc.name.replace(/\//g, "__"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "server.json"), `${JSON.stringify(doc, null, 2)}\n`);
    files += 1;
  }

  if (existsSync(OUT)) {
    for (const entry of readdirSync(OUT)) rmSync(path.join(OUT, entry), { recursive: true, force: true });
  } else {
    mkdirSync(OUT, { recursive: true });
  }
  for (const entry of readdirSync(staging)) {
    execFileSync("mv", [path.join(staging, entry), path.join(OUT, entry)]);
  }
  console.log(`✓ 已写出 ${files} 个 server.json 到 ${OUT}`);

  if (PUBLISH) {
    let published = 0;
    const failures = [];
    for (const doc of servers) {
      try {
        execFileSync("mcp-publisher", ["publish"], {
          cwd: path.join(OUT, doc.name.replace(/\//g, "__")),
          stdio: "inherit",
        });
        published += 1;
        console.log(`  ✓ 已发布 ${doc.name}`);
      } catch (e) {
        failures.push({ name: doc.name, message: String(e?.message || e).split("\n")[0] });
      }
    }
    console.log(`✓ 发布完成：${published}/${servers.length}`);
    if (failures.length) {
      for (const f of failures) console.error(`  ✗ ${f.name}: ${f.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log("  （未 --publish；仅写出。CI 的 OIDC 登录由 workflow 负责）");
  }
} catch (e) {
  console.error(`✗ 生成失败，已保留上一份（last-good）：${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(staging, { recursive: true, force: true });
}
