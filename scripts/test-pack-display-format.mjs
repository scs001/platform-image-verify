#!/usr/bin/env node
// ── Display format v2 validation matrix (overhaul-market-catalog-presentation
// 4.1) ───────────────────────────────────────────────────────────────────────
//
// The v2 display fields (identity/promise/audience/outcomes/examples/domain)
// are OPTIONAL presentation — the same validator answers for the publish
// endpoint and the install path (spec: 发布面与安装面共用). Pins:
//   1. a full v2 manifest inside every cap validates clean
//   2. every cap fires on the right field PATH (promise width, examples count,
//      outcomes shape, domain vocabulary, accent color)
//   3. an absent field costs nothing: a legacy manifest validates with zero
//      v2-shaped errors (byte-identity of the payload itself is pinned by
//      4.5's projection diff test)
//   4. runtime contracts are untouched by v2 fields — the same manifest
//      validates identically with and without them
//
//   node --test scripts/test-pack-display-format.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { validatePackManifest } = await import("../lib/pack-manifest.js");
const { lineSlugs } = await import("../lib/pack-taxonomy.js");

// A minimal legal pack: one skill, nothing else. Every case below spreads this
// and adds display fields, so a failure names the display field, never a base.
const BASE = {
  name: "显示格式测试包",
  description: "用于钉 v2 校验矩阵的基础包。",
  skills: [{ name: "s", description: "d", content: "# s" }],
};

const FULL_V2 = {
  identity: { mark: { kind: "glyph", value: "柏" }, accent: "wire" },
  promise: "四件套策略工坊：从设计到回测一句话讲清。",
  audience: ["investing", "legal"],
  outcomes: [
    { title: "可跑的因子库", detail: "每周更新的回测工作流" },
    { title: "晨会纪要" },
  ],
  examples: [
    { title: "问风险", prompt: "评估这份组合的回撤风险" },
    { title: "拟策略", prompt: "按动量因子拟一条月度调仓策略" },
  ],
  domain: ["investing"],
};

const displayErrors = (manifest) =>
  validatePackManifest(manifest).filter((e) =>
    ["identity", "promise", "audience", "outcomes", "examples", "domain"].some(
      (k) => String(e.entry ?? e.error).startsWith(k),
    ),
  );

test("完整 v2 manifest 通过校验（全部字段在册且在上限内）", () => {
  assert.deepEqual(displayErrors({ ...BASE, ...FULL_V2 }), []);
});

test("缺省降级：老 manifest 零 v2 错误，新增字段绝不无中生有", () => {
  const legacy = validatePackManifest(BASE);
  assert.equal(legacy.length, 0, `legacy 必须完全干净，实际: ${JSON.stringify(legacy)}`);
});

test("承诺超宽按显示宽拒（31 个 CJK 字 = 宽 61 > 60）", () => {
  const errs = displayErrors({ ...BASE, promise: "长".repeat(31) });
  assert.equal(errs.length, 1);
  assert.match(errs[0].entry, /^promise$/);
  assert.match(errs[0].error, /display-width/);
  // 恰在预算内放行——上限是含等号语义（60 宽）。
  assert.equal(displayErrors({ ...BASE, promise: "长".repeat(30) }).length, 0);
});

test("条数越界拒并说明允许区间（examples 1 条 / 5 条；outcomes 1 条 / 6 条）", () => {
  const one = displayErrors({ ...BASE, examples: [{ title: "t", prompt: "p" }] });
  assert.equal(one.length, 1);
  assert.match(one[0].error, /2-4 entries/);
  const five = displayErrors({
    ...BASE,
    examples: Array.from({ length: 5 }, () => ({ title: "t", prompt: "p" })),
  });
  assert.match(five[0].error, /2-4 entries/);
  const outcomes1 = displayErrors({ ...BASE, outcomes: [{ title: "t" }] });
  assert.match(outcomes1[0].error, /2-5 entries/);
  const outcomes6 = displayErrors({
    ...BASE,
    outcomes: Array.from({ length: 6 }, () => ({ title: "t" })),
  });
  assert.match(outcomes6[0].error, /2-5 entries/);
});

test("词表外领域被拒，错误指名 slug 与字段路径", () => {
  const errs = displayErrors({ ...BASE, domain: ["investing", "crypto"] });
  assert.equal(errs.length, 1);
  assert.equal(errs[0].entry, "domain[1]");
  assert.match(errs[0].error, /controlled vocabulary/);
  // audience 用同一受控词表。
  const aud = displayErrors({ ...BASE, audience: ["investing", "made-up", "legal"] });
  assert.equal(aud.length, 1);
  assert.equal(aud[0].entry, "audience[1]");
});

test("色值不可自由填写：accent 只接受线 slug（十六进制单独点名）", () => {
  const hex = displayErrors({ ...BASE, identity: { accent: "#ff0000" } });
  assert.equal(hex.length, 1);
  assert.equal(hex[0].entry, "identity.accent");
  assert.match(hex[0].error, /free color values are not writable/);
  const bogus = displayErrors({ ...BASE, identity: { accent: "not-a-line" } });
  assert.match(bogus[0].error, new RegExp(lineSlugs().join("/")));
});

test("identity.mark 形状钉死（kind 三选、glyph/emoji 1-2 字、image 受控引用串）", () => {
  assert.equal(displayErrors({ ...BASE, identity: { mark: { kind: "emoji", value: "🐛" } } }).length, 0);
  assert.equal(displayErrors({ ...BASE, identity: { mark: { kind: "glyph", value: "法律" } } }).length, 0, "2 字合法");
  assert.match(
    displayErrors({ ...BASE, identity: { mark: { kind: "glyph", value: "壹座智能体" } } })[0].error,
    /1-2 characters/,
  );
  assert.match(displayErrors({ ...BASE, identity: { mark: { kind: "svg", value: "x" } } })[0].error, /one of glyph\/emoji\/image/);
  assert.match(displayErrors({ ...BASE, identity: { mark: { kind: "image", value: "  " } } })[0].error, /controlled reference/);
});

test("examples/outcomes 条目形状：未知键与空文本报字段路径", () => {
  const e1 = displayErrors({ ...BASE, examples: [{ title: "t", prompt: "p" }, { title: "t", prompt: "p", color: "red" }] });
  assert.equal(e1[0].entry, "examples[1]");
  const e2 = displayErrors({ ...BASE, outcomes: [{ title: "  " }, { title: "t" }] });
  assert.equal(e2[0].entry, "outcomes[0].title");
});

test("运行时契约不因 v2 字段移动：同包带/不带 v2 的其余错误恒等", () => {
  const withV2 = validatePackManifest({ ...BASE, ...FULL_V2 });
  const without = validatePackManifest(BASE);
  assert.deepEqual(withV2, without, "v2 字段不得给 base 合法包带来任何新错误");
  // 坏包不因 v2 字段而洗白：基础违规原样在。
  const broken = validatePackManifest({ ...BASE, skills: [{ name: "s", content: "# s" }], ...FULL_V2 });
  const brokenNoV2 = validatePackManifest({ ...BASE, skills: [{ name: "s", content: "# s" }] });
  assert.ok(broken.length > 0 && broken.length === brokenNoV2.length);
});
