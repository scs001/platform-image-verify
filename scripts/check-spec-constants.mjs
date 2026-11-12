#!/usr/bin/env node
// Spec ↔ code numeric agreement (2026-11-11).
//
// A number that binds behaviour must live in BOTH places: the spec (the contract
// people read) and the code (what actually runs). On 2026-11-11 the wrap-up
// budget had drifted — spec said 90 seconds, code ran 240 — for a whole day,
// silently: the code change was deliberate and documented in the ledger, but the
// spec never followed, so anyone reading the contract or writing an acceptance
// check from it would compute the wrong thing (2.7x off).
//
// This pins the pairs that actually bind. Add a row when a new constant becomes
// part of the contract; do not add rows for numbers that are pure implementation
// detail (buffer sizes, retry counts nobody promises).
//
//   node scripts/check-spec-constants.mjs
//
// Exit 0 = every spec claim matches the code constant. Exit 1 = drift, named.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

// scale: the spec expresses the constant in different units than the code
// (ms → seconds), so compare after dividing.
const PAIRS = [
  {
    what: "上下文压力阈值（压缩次数）",
    spec: "openspec/specs/cron-module/spec.md",
    specRe: /压缩上下文（`compaction\/start`）达到阈值（默认 (\d+) 次）/,
    code: "server/cron-runner.js",
    codeRe: /const CONTEXT_PRESSURE_COMPACTIONS = (\d+);/,
  },
  {
    what: "早停压缩次数阈值",
    spec: "openspec/specs/cron-module/spec.md",
    specRe: /硬阈值（默认 \*\*(\d+)\*\* 次/,
    code: "server/cron-runner.js",
    codeRe: /const EARLY_STOP_COMPACTIONS = (\d+);/,
  },
  {
    what: "早停时间下限（秒）",
    spec: "openspec/specs/cron-module/spec.md",
    specRe: /下限（默认 (\d+) 秒）/,
    code: "server/cron-runner.js",
    codeRe: /const EARLY_STOP_MIN_ELAPSED_MS = ([\d_]+);/,
    convert: (v) => v / 1000, // ms → 秒
  },
  {
    what: "收尾补数独立预算（秒）",
    spec: "openspec/specs/cron-module/spec.md",
    specRe: /独立小预算默认 (\d+) 秒/,
    code: "server/cron-runner.js",
    codeRe: /const WRAPUP_TIMEOUT_MS = ([\d_]+);/,
    convert: (v) => v / 1000, // ms → 秒
  },
  {
    what: "提前收口窗口占比（%）",
    spec: "openspec/specs/cron-module/spec.md",
    specRe: /达到解析窗口的 (\d+)%/,
    code: "server/cron-runner.js",
    codeRe: /export const OVERFLOW_PREEMPT_RATIO = ([\d.]+);/,
    convert: (v) => v * 100, // 比率 → 百分比
  },
  {
    what: "桩回合输出阈值（tokens）",
    spec: "openspec/specs/agent-fleet-core/spec.md",
    specRe: /输出 tokens 不超过桩阈值（默认 (\d+)）/,
    code: "server/fleet-events.js",
    codeRe: /export const STUB_OUTPUT_TOKENS = (\d+);/,
  },
];

let bad = 0;
for (const p of PAIRS) {
  if (!existsSync(resolve(ROOT, p.spec)) || !existsSync(resolve(ROOT, p.code))) {
    console.error(`✗ ${p.what}: 缺文件（${p.spec} 或 ${p.code}）—— 在发布线上跑这个脚本`);
    bad++;
    continue;
  }
  const sm = p.specRe.exec(read(p.spec));
  const cm = p.codeRe.exec(read(p.code));
  if (!sm || !cm) {
    console.error(`✗ ${p.what}: 取不到数字（spec ${sm ? "命中" : "未命中"}，code ${cm ? "命中" : "未命中"}）—— 措辞或常量名变了，先修脚本`);
    bad++;
    continue;
  }
  const specVal = Number(sm[1]);
  const rawCode = Number(String(cm[1]).replace(/_/g, ""));
  const codeVal = p.convert ? p.convert(rawCode) : rawCode;
  const ok = Math.abs(specVal - codeVal) < 1e-9;
  if (ok) {
    console.log(`  ✓ ${p.what}: spec ${specVal} = code ${codeVal}`);
  } else {
    console.error(`  ✗ ${p.what}: spec 写 ${specVal}，代码是 ${codeVal} —— 二者必须一致（改一边就改另一边）`);
    bad++;
  }
}

if (bad) {
  console.error(`check-spec-constants: FAIL (${bad} 处)`);
  process.exit(1);
}
console.log("check-spec-constants: PASS");
