#!/usr/bin/env node
// ── 快照排除清单 × 测试读路径：两边的判据必须对得上 ──────────────────────────
//
// 2026-11-14 实历：镜像仓（scs001/platform-image-verify）的 CI 从本轮第一次出片
// 起连续 5 轮红，而出片本身不需要 CI 绿（image-publish 与 CI 是两条 workflow），
// 于是「红着出片」两个多小时没人看见。原因不是产品缺陷，是**快照排除清单与测试
// 的读路径脱钩**：
//
//   - `scripts/probe-*.mjs` 按 GLOB 排除 → `test-agent-runner-identity.mjs` 无条件
//     readFileSync 这两个探针 ⇒ unit 分片 ENOENT；
//   - `services/ops-console/` 按 PREDIX 排除 → `test-ops-console-board.mjs` 无条件
//     import ⇒ 同一形态。
//
// 本地永远绿（本地有那两个文件/目录），所以这条只能靠「比对两张清单」判。判据刻意
// 保守：只认**字面量路径**（`path.join(ROOT, "a", "b")` / `new URL("../x",
// import.meta.url)` / `import("../x")`），且只在「这个路径在工作树里真实存在」时
// 才报——这样不会因为注释或拼出来的路径产生噪声。
//
// 例外只有一种：读之前有 `existsSync` 守卫（含 `crossRepoFixture()` 这类封装在
// 20 行内的形态）。守卫是合法的——「在场就必须一致，缺席即在此树不可判」正是
// 探针副本该有的判据；无条件读才是缺陷。
//
//   node --test scripts/test-public-snapshot-test-parity.mjs
//
// 判不出（解析不到排除清单）时 FAIL，不静默通过：清单改名/改形会让这条闸变成
// 「扫了 0 条规则所以绿」，那是比红更坏的形态。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const BUILDER = path.join(ROOT, "scripts", "make-public-snapshot.mjs");

/** 取出 `const NAME = new Set([ … ]);` / `const NAME = [ … ];` 里的双引号字面量。 */
function blockLiterals(src, name) {
  const start = src.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `make-public-snapshot.mjs 里找不到 ${name} —— 闸判不出，先修这里`);
  const open = src.indexOf("[", start);
  assert.ok(open > start);
  // 括号配平扫到对应的 `]`（字面量里没有方括号，注释里的也不会成对到失衡）。
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, `${name} 的数组没有闭合`);
  const body = src.slice(open + 1, end);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

// builder 自己也在 EXCLUDE_PATHS 里（它写着内部拓扑）⇒ 公开快照里没有可比对的清单。
// 那种树上本闸不可判：显式 skip 并写明原因，不让它变成「扫了 0 条所以绿」。
const BUILDER_HERE = existsSync(BUILDER);
const builderSrc = BUILDER_HERE ? readFileSync(BUILDER, "utf8") : "";
// 解析必须在 builder 缺席时**不执行**：解析失败是 assert 抛错，而模块顶层的抛错会让
// 整个文件在公开快照里变成"测试文件加载失败"——本闸自己的第一次出片就这么红的
// （2026-11-14，镜像仓 shard 5/8）。缺席时下面两个用例整体 skip。
const EXCLUDE_PATHS = BUILDER_HERE ? new Set(blockLiterals(builderSrc, "EXCLUDE_PATHS")) : new Set();
const PREFIXES = BUILDER_HERE
  ? [...blockLiterals(builderSrc, "EXCLUDE_PREFIXES"), ...blockLiterals(builderSrc, "EXCLUDE_PREFIXES_EXTRA")]
  : [];
const GLOBS = (BUILDER_HERE ? blockLiterals(builderSrc, "EXCLUDE_GLOBS") : []).map((g) => {
  const src = g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(g.includes("**") ? ".*" : "[^/]*");
  return new RegExp(`^${src}$`);
});

function isExcluded(rel) {
  if (EXCLUDE_PATHS.has(rel)) return true;
  if (PREFIXES.some((p) => rel === p.replace(/\/$/, "") || rel.startsWith(p))) return true;
  if (GLOBS.some((re) => re.test(rel))) return true;
  return false;
}

// 解析到的规则条数必须够多——否则是「清单改形，闸扫了 0 条」的假绿。
const SKIP_NO_BUILDER = BUILDER_HERE
  ? false
  : "make-public-snapshot.mjs 本身被排除：公开快照里没有清单可比对（在此树不可判）";

test("闸自检：排除清单解析得到足够条目", { skip: SKIP_NO_BUILDER }, () => {
  assert.ok(EXCLUDE_PATHS.size >= 20, `EXCLUDE_PATHS 只解析到 ${EXCLUDE_PATHS.size} 条`);
  assert.ok(PREFIXES.length >= 10, `前缀只解析到 ${PREFIXES.length} 条`);
  assert.ok(GLOBS.length >= 3, `GLOB 只解析到 ${GLOBS.length} 条`);
  // 正样本：今天是这几个；改动它们时这条跟着改，别默默放宽。
  for (const known of ["AGENTS.md", "services/ops-console/", "docs/adr/"]) {
    assert.ok(PREFIXES.includes(known) || EXCLUDE_PATHS.has(known), `${known} 不在排除清单里 —— 解析口径变了？`);
  }
  assert.ok(isExcluded("scripts/probe-deployment-secrets.mjs"), "GLOB scripts/probe-*.mjs 未生效");
});

const GUARD_WINDOW = 20;
const PATH_JOIN = /path\.(?:join|resolve)\(\s*(?:ROOT|REPO|ROOT_DIR|REPO_ROOT)\s*((?:,\s*"[^"]*")+)\s*\)/g;
const URL_REL = /new URL\(\s*"((?:\.\.?\/)[^"]*)"\s*,\s*import\.meta\.url\s*\)/g;
const DYN_IMPORT = /(?:await\s+)?import\(\s*"(\.[^"]*)"\s*\)/g;

function candidates(src) {
  const out = [];
  for (const m of src.matchAll(PATH_JOIN)) {
    const segs = [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    out.push({ index: m.index, rel: path.posix.normalize(segs.join("/")) });
  }
  for (const m of src.matchAll(URL_REL)) {
    // new URL 相对于本文件所在目录（scripts/）
    out.push({ index: m.index, rel: path.posix.normalize(path.posix.join("scripts", m[1])) });
  }
  for (const m of src.matchAll(DYN_IMPORT)) {
    out.push({ index: m.index, rel: path.posix.normalize(path.posix.join("scripts", m[1])) });
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

function guarded(src, index) {
  const lines = src.split("\n");
  const at = lineOf(src, index) - 1;
  const from = Math.max(0, at - GUARD_WINDOW);
  const to = Math.min(lines.length, at + GUARD_WINDOW);
  const window = lines.slice(from, to).join("\n");
  // 两种守卫都算：读之前的 existsSync，或 test(..., { skip: … }, …) 形态。
  return /existsSync\s*\(/.test(window) || /\bskip:/.test(window);
}

test("快照排除清单与测试读路径不冲突（镜像仓 CI 不得因排除而红）", { skip: SKIP_NO_BUILDER }, () => {
  const files = readdirSync(HERE).filter((f) => f.startsWith("test-") && f.endsWith(".mjs")).sort();
  assert.ok(files.length >= 100, `只扫到 ${files.length} 个测试文件 —— 判不出`);

  const violations = [];
  let checked = 0;
  for (const file of files) {
    const relFile = `scripts/${file}`;
    if (isExcluded(relFile)) continue; // 测试自己就被排除 ⇒ 镜像仓里根本不存在
    if (relFile === "scripts/test-public-snapshot-test-parity.mjs") continue; // 本闸读 builder 就是它的职责
    const src = readFileSync(path.join(HERE, file), "utf8");
    for (const c of candidates(src)) {
      const outside = c.rel.startsWith("..");
      const excluded = !outside && isExcluded(c.rel);
      if (!outside && !excluded) continue;
      // 「在工作树里真实存在」才报：拼出来的名字、注释里的例子都不算。
      const full = path.join(ROOT, c.rel);
      if (!outside && !existsSync(full)) continue;
      checked++;
      if (guarded(src, c.index)) continue;
      violations.push({ file: relFile, line: lineOf(src, c.index), rel: c.rel, why: outside ? "在仓外（快照里必然没有）" : "被快照排除" });
    }
  }

  // 反空判：必须至少核过一个「确实落在排除范围/仓外」的读点，否则是扫空了。
  assert.ok(checked >= 1, "一个落在排除范围的读点都没核到 —— 解析口径可能失效（判不出，不是通过）");

  assert.deepEqual(
    violations,
    [],
    `以下测试在本地能读、在公开快照里读不到（镜像仓 unit 分片必红）：\n` +
      violations.map((v) => `  ${v.file}:${v.line}  ${v.rel}  —— ${v.why}`).join("\n") +
      `\n修法二选一：① 读之前用 existsSync 守卫（缺席即在此树不可判，别 skip 成通过）；` +
      `② 该测试本身是内部服务的测试，就把测试加进 make-public-snapshot.mjs 的 EXCLUDE_PATHS。`,
  );
});
