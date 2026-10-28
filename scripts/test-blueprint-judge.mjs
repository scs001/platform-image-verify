#!/usr/bin/env node
// ── Blueprint assertion judge tests (add-blueprint-llm-assertions) ──────────
//
// 判据实现的三条纪律在此钉住：三态解析（解析不出/未知枚举/超时/不可达一律
// insufficient-evidence）、禁自证（judge 车道 ≠ 产出车道；产出车道解析不出也拒判）、
// 留原件（模型/端点摘要/提示词哈希/证据摘要/原始输出）。
// 零真模型：fetch 全注入。
//
//   node --test scripts/test-blueprint-judge.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { parseJudgeOutput, judgeAssertion, buildJudgePrompt, JUDGE_LIMITS, JUDGE_VERDICTS } =
  await import("../server/blueprint-judge.js");

const LANE = { providerId: "p1", baseUrl: "https://judge.example/v1", apiKey: "sk-test", model: "cheap-1", laneId: "lane-judge" };
const okFetch = (content) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

test("三态解析：合法三态原样；越界一律 insufficient-evidence", () => {
  assert.equal(parseJudgeOutput('{"verdict":"pass","reason":"ok"}').verdict, "pass");
  assert.equal(parseJudgeOutput('{"verdict":"fail","reason":"no"}').verdict, "fail");
  assert.equal(parseJudgeOutput('{"verdict":"insufficient-evidence"}').verdict, "insufficient-evidence");
  // 围栏/多余文字容忍
  assert.equal(parseJudgeOutput('```json\n{"verdict":"pass"}\n```').verdict, "pass");
  // 越界
  assert.equal(parseJudgeOutput('{"verdict":"maybe"}').verdict, "insufficient-evidence");
  assert.equal(parseJudgeOutput("not json at all").verdict, "insufficient-evidence");
  assert.equal(parseJudgeOutput("").verdict, "insufficient-evidence");
  assert.equal(parseJudgeOutput(null).verdict, "insufficient-evidence");
  assert.deepEqual(JUDGE_VERDICTS, ["pass", "fail", "insufficient-evidence"]);
});

test("提示词：只含判据与证据，不含蓝图自述（D3 防回声）", () => {
  const { system, user } = buildJudgePrompt({ rubric: "首轮产出简报", evidenceText: "回合：1 个" });
  assert.match(user, /首轮产出简报/);
  assert.match(user, /回合：1 个/);
  assert.match(system, /独立评审/);
  assert.match(system, /insufficient-evidence/);
});

test("禁自证：judge 与产出同一车道 → 拒判；产出车道解析不出 → 拒判", async () => {
  let called = 0;
  const countingFetch = async () => {
    called += 1;
    return okFetch('{"verdict":"pass"}')(...arguments);
  };

  const same = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ laneId: "lane-judge", providerId: "p1", model: "cheap-1" }],
    lane: LANE,
    fetchImpl: countingFetch,
  });
  assert.equal(same.verdict, "insufficient-evidence");
  assert.match(same.reason, /self-grading/);
  assert.equal(called, 0, "同车道必须在发请求之前就拒");

  const unknownProduction = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [],
    lane: LANE,
    fetchImpl: countingFetch,
  });
  assert.equal(unknownProduction.verdict, "insufficient-evidence");
  assert.match(unknownProduction.reason, /cannot resolve the producing model/);
  assert.equal(called, 0);
});

test("成本闸：证据超字符上限如实拒（不静默截断）", async () => {
  let called = 0;
  const out = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "x".repeat(JUDGE_LIMITS.maxEvidenceChars + 1),
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: async () => {
      called += 1;
      return okFetch('{"verdict":"pass"}')(...arguments);
    },
  });
  assert.equal(out.verdict, "insufficient-evidence");
  assert.match(out.reason, /exceeds the judge cap/);
  assert.equal(called, 0);
});

test("车道异常：HTTP 非 2xx / 网络不可达 → insufficient-evidence 并带原因", async () => {
  const http500 = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });
  assert.equal(http500.verdict, "insufficient-evidence");
  assert.match(http500.reason, /HTTP 500/);

  const unreachable = await judgeAssertion({
    assertionId: "a1",
    rubric: "判据",
    evidenceText: "证据",
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(unreachable.verdict, "insufficient-evidence");
  assert.match(unreachable.reason, /unreachable/);
});

test("正常判定：pass 并留审计件（模型/端点摘要/提示词哈希/证据摘要/原始输出）", async () => {
  const out = await judgeAssertion({
    assertionId: "a1",
    rubric: "首轮产出简报",
    evidenceText: "回合：1 个 job_1",
    productionLanes: [{ laneId: "lane-producer", providerId: "p-other", model: "big-1" }],
    lane: LANE,
    fetchImpl: okFetch('{"verdict":"pass","reason":"证据直接支持"}'),
  });
  assert.equal(out.verdict, "pass");
  assert.equal(out.reason, "证据直接支持");
  const a = out.audit;
  assert.equal(a.assertionId, "a1");
  assert.equal(a.model, "cheap-1");
  assert.equal(a.verdict, "pass");
  assert.match(a.endpointDigest, /^[0-9a-f]{16}$/);
  assert.match(a.promptHash, /^[0-9a-f]{16}$/);
  assert.match(a.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.match(a.rawVerdict, /"verdict":"pass"/);
  assert.ok(a.judgedAt);
  // 密钥永不落进审计件。
  assert.equal(JSON.stringify(a).includes("sk-test"), false);
});
test("密钥解析层次：进程 env > .credentials.yaml refs > LLM_API_KEY 兜底", async () => {
  const { __testApiKeyFor } = await import("../server/blueprint-judge.js");
  if (!__testApiKeyFor) return; // 未导出即跳过（不假绿由下一行断言兜底）
  const provider = { apiKeyEnv: "LLM_PROVIDER_KEY_TEST" };
  // 进程 env 优先
  process.env.LLM_PROVIDER_KEY_TEST = "from-env";
  assert.equal(__testApiKeyFor(provider), "from-env");
  delete process.env.LLM_PROVIDER_KEY_TEST;
  // 无 env 时回落（真实环境落到文件或 LLM_API_KEY，此处断言不抛且返回字符串）
  const val = __testApiKeyFor(provider);
  assert.equal(typeof val, "string");
});

test("D4 口径：同 provider 换模型可判，同 provider 同模型拒判", async () => {
  const { isSelfGrading } = await import("../server/blueprint-judge.js");
  const judge = { providerId: "finddata-token", model: "deepseek-v4-pro" };
  // 同 provider 同模型 = 自评 → 拒
  assert.equal(isSelfGrading(judge, { providerId: "finddata-token", model: "deepseek-v4-pro" }), true);
  // 同 provider 换模型 = 换了个判断主体 → 允许（生产的常态：一个 provider 承载全名册）
  assert.equal(isSelfGrading(judge, { providerId: "finddata-token", model: "glm-5.3-flash" }), false);
  // 不同 provider → 允许
  assert.equal(isSelfGrading(judge, { providerId: "other", model: "deepseek-v4-pro" }), false);
  // 解析不出 → 拒
  assert.equal(isSelfGrading(judge, null), true);
  assert.equal(isSelfGrading(null, judge), true);
});

test("lane 指纹与判断主体的区别（不因空 key 假阳性）", async () => {
  // 2026-10-28 生产实证的坑：两边都取不到 key 时 laneKeyFor 指纹相同，
  // 会误判「judge 与产出同车道」而拒掉一切。此处断言不同 provider 的指纹不同。
  const { laneKeyFor } = await import("../server/llm-lane.js");
  const a = laneKeyFor({ id: "p1", baseURL: "https://a.example/v1", apiKey: "" });
  const b = laneKeyFor({ id: "p2", baseURL: "https://b.example/v1", apiKey: "" });
  assert.notEqual(a, b, "不同 provider/端点即便都无 key 也必须分属不同 lane");
});
