#!/usr/bin/env node
// ── Blueprint studio reverse assertions (add-blueprint-studio task 6.3) ─────
//
// 反向断言锁：仓库内**不出现**第二校验器 / 第二上架通道 / 第二调度器。
// 静态审计式测试——读 blueprint 三模块的源码原文，钉住它们的接法：
//   ① 校验只许 import 既有三器（parseFleetTemplate / validatePackManifest /
//      publish-tool-gate 同步两函数），不得本地重实现同名语义；
//   ② 上架只许经 facet proxy 的 POST /api/packs 一道门，不得直摸 registry；
//   ③ 三模块不得引入 cron / task-engine / reconcile —— 调度归任务引擎。
// 错误文案粒度由 test-blueprints.mjs「下限规则」一例钉住（既有原文直出）。
//
//   node --test scripts/test-blueprint-reverse-assertions.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
// 结构审计跑在「去注释」的代码上——注释里提到被禁符号不算违约。
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const VALIDATE = "server/blueprint-validate.js";
const ROUTES = "server/routes/blueprints.js";
const DB = "server/routes/blueprints-db.js";

test("6.3 ① 无第二校验器：只 import 既有三器，本地零重实现", () => {
  const src = code(VALIDATE);
  // 接法钉死：三处 import 各就各位。
  assert.match(src, /import \{ parseFleetTemplate \} from "\.\/fleet-template\.js";/);
  assert.match(src, /import \{ validatePackManifest \} from "\.\.\/lib\/pack-manifest\.js";/);
  assert.match(
    src,
    /import \{ toolFaceErrors, toolClosureErrors \} from "\.\.\/lib\/publish-tool-gate\.js";/,
  );
  // 不本地重实现同名语义（只有编排器 validateBlueprint 一个合法 "validate" 定义）。
  assert.equal(/function validatePackManifest/.test(src), false);
  assert.equal(/function parseFleetTemplate/.test(src), false);
  assert.equal(/function toolFaceErrors|function toolClosureErrors/.test(src), false);
  const validateDefs = src.match(/function validate\w*\(/g) ?? [];
  assert.deepEqual(validateDefs, ["function validateBlueprint("]);
  // 异步带探针的 toolGateErrors 留在发布门，studio 不调用。
  assert.equal(/toolGateErrors/.test(src), false);
});

test("6.3 ② 无第二上架通道：唯一市场写路径是 facet proxy POST /api/packs", () => {
  const src = code(ROUTES);
  assert.match(src, /import \{ facetRequest \} from "\.\.\/\.\.\/gateway\/facet-proxy\.js";/);
  assert.match(src, /path: "\/api\/packs"/);
  assert.match(src, /method: "POST"/);
  // 不得直摸市场 registry（直写会绕过发布门 collectPublishVerdict 的闸序）。
  assert.equal(/createPackRegistry/.test(src), false);
  assert.equal(/from ".*gateway\/packs\.js"/.test(src), false);
  assert.equal(/registry\.publish/.test(src), false);
});

test("6.3 ③ 无第二调度器：三模块零 cron / 任务引擎 / reconcile 引入", () => {
  for (const rel of [VALIDATE, ROUTES, DB]) {
    const src = code(rel);
    assert.equal(/from ".*\bcron(\.js)?"/.test(src), false, `${rel} must not import cron`);
    assert.equal(/from ".*task-engine/.test(src), false, `${rel} must not import the task engine`);
    assert.equal(/from ".*fleet-reconcile/.test(src), false, `${rel} must not import reconcile`);
    assert.equal(/cron\.schedule|engine\.enqueue|reconcileFleet\(/.test(src), false, `${rel} must not drive scheduling`);
  }
});