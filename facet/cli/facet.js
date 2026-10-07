#!/usr/bin/env node
// ── @finddatatechnology/facet — 谦面 CLI (add-facet-platform S3) ───────────
//
// Installs a published pack's skills from the facet marketplace into editor
// targets (Claude Code, Cursor). Marketplace fetches are the same anonymous
// public routes the registry uses; a pack reference is its id (or any
// URL/string containing it). The install is a version snapshot — no
// subscription is created, no update push follows (spec: facet-editor-cli).
//
// MCP references are printed with their real connection endpoint and the
// credential requirement; v1 deliberately writes NO MCP configuration into
// any editor — connecting needs a per-user registry credential that this CLI
// does not hold (spec: MCP references are honest about credentials).
//
//   npx @finddatatechnology/facet install <packRef> [--target claude-code|cursor]
//                                [--project <dir>] [--base <facet-url>]
//                                [--registry <registry-url>]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Version lives in package.json only — a hardcoded copy shipped 0.1.0 for
// three releases (caught by `npx @finddatatechnology/facet@0.1.2 --version`).
const VERSION = JSON.parse(
  await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
).version;
const DEFAULT_BASE = process.env.FACET_BASE || "https://facet.finddatatech.cloud";
const DEFAULT_REGISTRY = process.env.FACET_REGISTRY || "https://mcp.finddatatech.cloud";

const USAGE = `facet v${VERSION} — 谦面功能集安装器 / 萬星调用者偏好

用法：
  facet install <packRef> [--target claude-code|cursor] [--project <dir>]
                          [--base <url>] [--registry <url>]
  facet prefs <agent-slug> [--key sk-…] [--wanxing <url>]
                          [--set-callback <url> <secret>] [--set-reap <minutes>]
                          [--clear callback|reap|all] [--show]
  facet help | --version

  <packRef>  功能集 id（市场详情页可见）或含 id 的 URL
  --target   安装目标（默认 claude-code）：写技能到目标编辑器的技能目录
  --project  项目级安装：写进 <dir>/.<target>/skills/ 而非用户级目录
  --base     谦面地址（默认 ${DEFAULT_BASE}）
  --registry 注册处地址——只用于打印 MCP 连接端点，不写任何配置

  prefs 子命令（萬星调用者偏好，调用键即凭证）：
  <agent-slug>   目录页的 agent 标识（如 packs-xxxx-agent）
  --key          sub2api 调用键（sk-…）；缺省读环境变量 FACET_CALLER_KEY
  --wanxing      萬星门面地址（默认 https://wanxing.finddatatech.cloud）
  --set-callback 回合完成回调：URL 与 HMAC 签名密钥（两者同设同清）
  --set-reap     上下文收割窗（分钟）；--clear 显式清除即回落平台默认

目标布局：
  claude-code 用户级 ~/.claude/skills/<skill>/SKILL.md ／ 项目级 <dir>/.claude/skills/…
  cursor      用户级 ~/.cursor/skills/<skill>/SKILL.md ／ 项目级 <dir>/.cursor/skills/…

说明：安装即版本快照（不产生订阅）；MCP 需 registry 账号凭据，端点仅打印。`;

function parseArgs(argv) {
  const out = { command: null, packRef: null, target: "claude-code", project: null, base: DEFAULT_BASE, registry: DEFAULT_REGISTRY, key: null, wanxing: process.env.FACET_WANXING || "https://wanxing.finddatatech.cloud", setCallback: null, setReap: undefined, clear: null };
  const rest = [...argv];
  out.command = rest.shift() ?? null;
  // A bare flag in command position (`facet --version`, `facet -h`) is the
  // flag, not an unknown command.
  if (out.command === "--version" || out.command === "-v") out.command = "version";
  else if (out.command === "--help" || out.command === "-h") out.command = "help";
  while (rest.length > 0) {
    const a = rest.shift();
    if (a === "--target") out.target = rest.shift();
    else if (a === "--project") out.project = rest.shift();
    else if (a === "--base") out.base = rest.shift();
    else if (a === "--registry") out.registry = rest.shift();
    else if (a === "--key") out.key = rest.shift();
    else if (a === "--wanxing") out.wanxing = rest.shift();
    else if (a === "--set-callback") {
      const url = rest.shift();
      const secret = rest.shift();
      if (!url || !secret) throw new Error("--set-callback 需要两个值：<url> <secret>");
      out.setCallback = [url, secret];
    }
    else if (a === "--set-reap") out.setReap = rest.shift();
    else if (a === "--clear") out.clear = rest.shift();
    else if (a === "--show") { /* read-only is the default when no set/clear flag is given */ }
    else if (a === "--help" || a === "-h") out.command = "help";
    else if (a === "--version" || a === "-v") out.command = "version";
    else if (!a.startsWith("-") && !out.packRef) out.packRef = a;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// Accepts a bare id, a URL, or any string containing the id as a path segment.
function extractPackId(ref) {
  if (!ref) return null;
  try {
    const url = new URL(ref);
    const segs = url.pathname.split("/").filter(Boolean);
    const i = segs.indexOf("packs");
    if (i >= 0 && segs[i + 1]) return segs[i + 1];
  } catch {
    /* not a URL */
  }
  return String(ref).trim();
}

const SKILLS_SUBDIR = { "claude-code": ".claude", cursor: ".cursor" };

function targetDir({ target, project }) {
  const dotdir = SKILLS_SUBDIR[target];
  if (!dotdir) {
    throw new Error(`不支持的目标「${target}」——支持：${Object.keys(SKILLS_SUBDIR).join("、")}`);
  }
  const root = project ? path.resolve(project) : homedir();
  return { dir: path.join(root, dotdir, "skills"), scope: project ? "项目级" : "用户级" };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function install(opts) {
  const base = String(opts.base).replace(/\/+$/, "");
  const registry = String(opts.registry).replace(/\/+$/, "");
  const packId = extractPackId(opts.packRef);
  if (!packId) throw new Error("缺少功能集引用——用法见 facet help");

  const detail = await fetchJson(`${base}/api/packs/${encodeURIComponent(packId)}`).catch(() => null);
  if (!detail?.id) throw new Error(`功能集未找到：${packId}（检查 id，或该包为私有/已下架）`);

  const { dir, scope } = targetDir(opts);
  const version = detail.version;
  const skills = detail.manifest?.skills ?? [];

  console.log(`谦面 Facet · 安装 ${detail.name}（${detail.id}）v${version} → ${opts.target}（${scope}）`);
  if (skills.length === 0) console.log("  （该功能集没有技能条目）");
  for (const skill of skills) {
    const mdUrl = `${base}/api/packs/${encodeURIComponent(detail.id)}/versions/${version}/skills/${encodeURIComponent(skill.name)}.md`;
    const r = await fetch(mdUrl, { headers: { Accept: "text/markdown" } });
    if (!r.ok) {
      console.log(`  ✗ ${skill.name} — 下载失败 HTTP ${r.status}`);
      continue;
    }
    const body = await r.text();
    const skillDir = path.join(dir, skill.name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
    console.log(`  ✓ ${path.join(skillDir, "SKILL.md")}`);
  }

  const mcp = detail.manifest?.mcpServers ?? [];
  if (mcp.length > 0) {
    console.log("\nMCP 引用（未写入任何编辑器配置）：");
    for (const s of mcp) {
      const endpoint = `${registry}/${s.registryName}/mcp`;
      const group = s.requiredGroup ? `（需要组：${s.requiredGroup}）` : "";
      console.log(`  · ${s.registryName}${group}`);
      console.log(`    端点 ${endpoint} — 连接需 registry 账号凭据`);
    }
    console.log("  凭据获取：登录注册处 → 生成个人令牌 → 在编辑器 MCP 配置中作为 Authorization 头。");
  }

  if (opts.target === "cursor") {
    console.log("\n注：Cursor 的技能目录支持随版本而异；若该目录未被读取，可将 SKILL.md 内容接入 Cursor Rules（.cursor/rules/）。");
  }
  console.log(`\n完成：${detail.id} v${version}（快照安装，无订阅副作用）。`);
  console.log(`把功能集装进运行时（对话/Agent 服务）请到壹座：设置 → 功能集 → 我的功能集（订阅后一键安装）。`);
}

// ── prefs: 萬星调用者偏好（add-caller-preferences） ─────────────────────────
// The caller's own surface for their per-agent preferences: the sub2api
// caller key is the credential (no login, matching the A2A door's rule).
async function prefs(opts) {
  const base = String(opts.wanxing).replace(/\/+$/, "");
  const slug = opts.packRef;
  if (!slug) throw new Error("缺少 agent slug——用法见 facet help");
  const key = opts.key || process.env.FACET_CALLER_KEY || "";
  if (!key) throw new Error("需要调用键：--key sk-… 或环境变量 FACET_CALLER_KEY");

  const call = async (method, body) => {
    const r = await fetch(`${base}/api/wanxing/v1/prefs/${encodeURIComponent(slug)}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const doc = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(doc?.error?.message || doc?.error || `HTTP ${r.status}`);
    return doc;
  };

  const patch = {};
  if (opts.setCallback) {
    patch.callbackUrl = opts.setCallback[0];
    patch.callbackSecret = opts.setCallback[1];
  }
  if (opts.setReap !== undefined) {
    const n = Number(opts.setReap);
    if (!Number.isInteger(n) || n < 1) throw new Error("--set-reap 需要正整数分钟数");
    patch.reapMinutes = n;
  }
  if (opts.clear !== null) {
    if (!["callback", "reap", "all"].includes(opts.clear)) throw new Error("--clear 只接受 callback | reap | all");
    if (opts.clear === "callback" || opts.clear === "all") {
      patch.callbackUrl = null;
      patch.callbackSecret = null;
    }
    if (opts.clear === "reap" || opts.clear === "all") patch.reapMinutes = null;
  }

  const show = (p) => {
    console.log(`调用者偏好 · ${slug}`);
    console.log(`  回合完成回调：${p.callbackUrl ?? "（未设）"}${p.callbackSecretSet ? "（签名密钥已设）" : ""}`);
    console.log(`  上下文收割窗：${p.reapMinutes != null ? `${p.reapMinutes} 分钟` : "（平台默认）"}`);
  };
  if (Object.keys(patch).length > 0) {
    show((await call("PUT", patch)).prefs);
    console.log("已保存。");
  } else {
    show((await call("GET")).prefs);
  }
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === "help" || opts.command === null) console.log(USAGE);
  else if (opts.command === "version") console.log(VERSION);
  else if (opts.command === "install") await install(opts);
  else if (opts.command === "prefs") await prefs(opts);
  else {
    console.error(`未知命令：${opts.command}\n\n${USAGE}`);
    process.exit(2);
  }
} catch (e) {
  console.error(`facet: ${e.message}`);
  process.exit(1);
}