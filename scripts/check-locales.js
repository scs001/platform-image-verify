#!/usr/bin/env node
// check-locales: enforce translation-resource parity.
//
// Loads every web/src/locales/<locale>/common.json and asserts:
//   1. each non-English locale exposes exactly the same key set as `en`
//      (no missing keys, no extra/stale keys);
//   2. no value is empty.
//
// Exits non-zero on any drift so a mis-translated or half-translated bundle
// fails the build (wired into `web:build`). English is the source of truth.
//
// Run: `npm run check:locales` (root) or `node scripts/check-locales.js`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = path.join(root, "web", "src", "locales");

const SOURCE = "en";

/** Collect every leaf key path (dotted) from a nested object. */
function collectKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...collectKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

function loadLocale(locale) {
  const file = path.join(localesDir, locale, "common.json");
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

if (!fs.existsSync(localesDir)) {
  console.error(`[check-locales] locales dir not found: ${localesDir}`);
  process.exit(1);
}

const locales = fs
  .readdirSync(localesDir)
  .filter((d) => fs.statSync(path.join(localesDir, d)).isDirectory());

if (!locales.includes(SOURCE)) {
  console.error(`[check-locales] source locale '${SOURCE}' missing from ${localesDir}`);
  process.exit(1);
}

const sourceKeys = new Set(collectKeys(loadLocale(SOURCE)));
let errors = 0;

for (const locale of locales) {
  if (locale === SOURCE) {
    // Still assert no empty values in the source.
    const data = loadLocale(locale);
    for (const key of collectKeys(data)) {
      const parts = key.split(".");
      let val = data;
      for (const p of parts) val = val?.[p];
      if (val === "" || val == null) {
        console.error(`[check-locales] ${SOURCE}: empty value at '${key}'`);
        errors++;
      }
    }
    continue;
  }

  const data = loadLocale(locale);
  const keys = new Set(collectKeys(data));

  const missing = [...sourceKeys].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !sourceKeys.has(k));
  const empty = [...keys].filter((k) => {
    const parts = k.split(".");
    let val = data;
    for (const p of parts) val = val?.[p];
    return val === "" || val == null;
  });

  if (missing.length || extra.length || empty.length) {
    errors++;
    console.error(`[check-locales] ${locale}: drift from '${SOURCE}'`);
    for (const k of missing) console.error(`  - missing: ${k}`);
    for (const k of extra) console.error(`  - extra:   ${k}`);
    for (const k of empty) console.error(`  - empty:   ${k}`);
  } else {
    console.log(`[check-locales] ${locale}: OK (${keys.size} keys)`);
  }
}

if (errors) {
  console.error(`\n[check-locales] ${errors} locale(s) with drift. Fix the above.`);
  process.exit(1);
}

// ── 代码侧键存在性（2026-10-29 增补） ─────────────────────────────────────
//
// 上面的比对只证「各语言之间一致」——**一致地缺失**照样全绿。真实事故：
// BlueprintStudioPage 用的是 `blueprints.judge.model.*`，而资源里那批键躺在
// `blueprints.model.*` 下（无人引用的孤儿块），于是评审模型下拉的标签与提示
// 全渲染成原始键名，而 locale 门五语「OK (2456 keys)」照过。
//
// 分级处置（fix-zhiyu-pass-mark-and-delivery-failure-surface 2026-11-18 改版）：
//   · 存量缺口进 scripts/locale-coverage-baseline.txt（一行一键，带车道与日期）；
//   · 覆盖门只对**基线之外**的缺键判红——存量按各自车道的节奏清，新代码再也进不来裸键；
//   · ENFORCED_PREFIXES 保留：本 change 直属的界面（zhiyu）连存量都不许有。
//
// 旧版是「白名单前缀判红 + 其余只告警（156 条长年告警）」。告警没人看，等于没有门：
// 11-18 的 `zhiyu.event.im_delivery_failed` 就是这么漏到生产屏幕上的。棘轮把
// 「永远绿的告警」换成「一次记账、之后一步不许退」。
const webSrc = path.join(root, "web", "src");
const LITERAL_T_RE = /\bt\(\s*["'`]([A-Za-z0-9_$][A-Za-z0-9_$.\-]*)["'`]/g;
const KEY_ALLOWLIST = new Set();
// 本 change 直属的界面：连存量都不豁免。
const ENFORCED_PREFIXES = ["blueprints.", "zhiyu."];
// ...但 zhiyu 下有一个前缀不属于本 change：会议采集（MeetingPanel /
// CaptureSession）是 meeting-capture 那条在途车道的界面，它自己缺 18 个键，
// 归它自己清。把它划出去而不是替它补文案，理由同基线文件的开头。
const ENFORCED_EXEMPT = ["zhiyu.meeting."];
const BASELINE_FILE = path.join(root, "scripts", "locale-coverage-baseline.txt");

const baselineKeys = new Set();
let baselineStale = 0;
if (fs.existsSync(BASELINE_FILE)) {
  for (const raw of fs.readFileSync(BASELINE_FILE, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    baselineKeys.add(line.split(/\s+#/)[0].trim());
  }
}

// i18next 把 `t("x.y", { count })` 解析成 `x.y_one` / `x.y_other`（以及
// `_zero`/`_two`/`_few`/`_many`）。代码写的是不带后缀的基名，资源里只有带后缀
// 的复数形式——只按字面查会把真存在的键报成缺失（首版就这样误报了
// `fleet.live.summary`）。任一带复数后缀的形式在场即视为已解析。
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];
const hasKey = (base) => sourceKeys.has(base) || PLURAL_SUFFIXES.some((s) => sourceKeys.has(base + s));

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

const unknownKeys = new Map(); // key → Set(files)
if (fs.existsSync(webSrc)) {
  for (const file of walk(webSrc)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(LITERAL_T_RE)) {
      const key = m[1];
      // 只审「像资源键」的字面量（含点）；纯单词多为变量名或非 i18n 调用。
      if (!key.includes(".")) continue;
      if (KEY_ALLOWLIST.has(key)) continue;
      if (hasKey(key)) continue;
      if (!unknownKeys.has(key)) unknownKeys.set(key, new Set());
      unknownKeys.get(key).add(path.relative(root, file));
    }
  }
}

const isEnforced = (k) =>
  ENFORCED_PREFIXES.some((p) => k.startsWith(p)) && !ENFORCED_EXEMPT.some((p) => k.startsWith(p));
const enforced = [...unknownKeys.entries()].filter(([k]) => isEnforced(k));
const baselined = [...unknownKeys.entries()].filter(([k]) => !isEnforced(k) && baselineKeys.has(k));
const fresh = [...unknownKeys.entries()].filter(([k]) => !isEnforced(k) && !baselineKeys.has(k));

// 基线缩水的两种情形都只是提示，不判红：键被补上了（好事，删基线行跟上）、
// 或那处 t() 被删了（也是好事）。基线**长期**不缩水才是该被问的问题。
const stillMissing = new Set([...enforced.map(([k]) => k), ...baselined.map(([k]) => k)]);
for (const k of baselineKeys) if (!stillMissing.has(k)) baselineStale++;

if (baselined.length) {
  console.log(
    `[check-locales] ${baselined.length} key(s) still missing but baselined (see scripts/locale-coverage-baseline.txt).`,
  );
}
if (baselineStale) {
  console.log(
    `[check-locales] ${baselineStale} baseline line(s) no longer needed — delete them from scripts/locale-coverage-baseline.txt.`,
  );
}

if (enforced.length) {
  console.error(`\n[check-locales] ${enforced.length} key(s) referenced in code but absent from '${SOURCE}':`);
  for (const [key, files] of enforced) console.error(`  - ${key}  ← ${[...files].join(", ")}`);
  console.error(`\nThese are in ${ENFORCED_PREFIXES.join(" / ")} — this change owns them and they cannot be baselined.`);
}

if (fresh.length) {
  console.error(`\n[check-locales] ${fresh.length} NEW key(s) referenced in code but absent from '${SOURCE}':`);
  for (const [key, files] of fresh) console.error(`  - ${key}  ← ${[...files].join(", ")}`);
  console.error("\nThese would render as raw key strings at runtime. Add the string to every locale,");
  console.error("or (rarely) record it in scripts/locale-coverage-baseline.txt with a lane and a date.");
}

// One exit, after both lists — a run that trips both must show both.
if (enforced.length || fresh.length) process.exit(1);
console.log(`[check-locales] code-side key references OK (${ENFORCED_PREFIXES.join(", ")}; baseline ${baselineKeys.size}).`);

console.log(`[check-locales] all ${locales.length} locales OK.`);
