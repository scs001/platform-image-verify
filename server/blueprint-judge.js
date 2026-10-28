// Blueprint assertion judge (add-blueprint-llm-assertions, design D1-D6).
//
// 模型判据的唯一实现：把一条自由文本 rubric + 已收证据交给 judge 车道，拿三态
// 判决回来，连审计件一起交回试跑报告。三条纪律写死在这里：
//
//   · 三态（D2）：pass / fail / insufficient-evidence。解析不出、超时、不可达、
//     输出不在枚举内 —— 一律 insufficient-evidence，绝不重试到绿。
//   · 禁自证（D4）：judge 车道必须与产出车道不同（同一条 lane 不给自己打分）；
//     产出车道无法解析时同样拒判。比对用既有 laneKeyFor（server/llm-lane.js），
//     不新造车道标识。
//   · 留原件（D5）：模型标识、端点摘要、提示词哈希、证据摘要、原始输出全落。
//     apiKey 只进哈希，永不落盘（沿用 lane 键的既有纪律）。
//
// 成本闸（D6）在调用方钳制（条数/字符），这里只保证「超字符即如实拒」。

import { createHash } from "node:crypto";
import { laneKeyFor } from "./llm-lane.js";
import { buildUserProviderEntries } from "../llm-providers.js";

export const JUDGE_VERDICTS = ["pass", "fail", "insufficient-evidence"];

export const JUDGE_LIMITS = {
  maxAssertions: Number(process.env.BLUEPRINT_JUDGE_MAX || 8),
  maxEvidenceChars: Number(process.env.BLUEPRINT_JUDGE_EVIDENCE_CHARS || 6000),
  timeoutMs: Number(process.env.BLUEPRINT_JUDGE_TIMEOUT_MS || 60_000),
};

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

// ── 车道解析 ────────────────────────────────────────────────────────────────

// 可用的 judge 模型 → { providerId, baseUrl, apiKey, model, laneId }。
// 选型顺序：BLUEPRINT_JUDGE_MODEL 指定 → 否则取第一个在册模型（便宜档由环境定）。
export function resolveJudgeLane({ entries = null } = {}) {
  const doc = entries ?? buildUserProviderEntries();
  const wanted = (process.env.BLUEPRINT_JUDGE_MODEL || "").trim();
  const model = (wanted && doc.models.find((m) => m.id === wanted || m.name === wanted)) || doc.models[0];
  if (!model) return null;
  const provider = doc.providers?.[model.provider];
  if (!provider) return null;
  const apiKey = provider.apiKey || provider.apiKeyValue || process.env[provider.apiKeyEnv] || "";
  const baseUrl = provider.baseURL || provider.baseUrl || "";
  if (!baseUrl) return null;
  return {
    providerId: model.provider,
    baseUrl,
    apiKey,
    model: model.id,
    laneId: laneKeyFor({ id: model.provider, baseURL: baseUrl, apiKey }),
  };
}

// 产出车道：某模型 id 落在哪条 lane。解析不出返回 null（调用方据此拒判）。
export function laneForModel(modelId, { entries = null } = {}) {
  const doc = entries ?? buildUserProviderEntries();
  const model = doc.models.find((m) => m.id === modelId);
  if (!model) return null;
  const provider = doc.providers?.[model.provider];
  if (!provider) return null;
  const apiKey = provider.apiKey || provider.apiKeyValue || process.env[provider.apiKeyEnv] || "";
  return laneKeyFor({ id: model.provider, baseURL: provider.baseURL || provider.baseUrl, apiKey });
}

// ── 提示词（D3 证据接地：只喂已收证据，不喂蓝图自述） ──────────────────────

export function buildJudgePrompt({ rubric, evidenceText }) {
  const system = [
    "你是验收判据的独立评审，不是这份产出的作者。",
    "只依据下面的运行证据判断判据是否满足；证据没有覆盖到的部分，判 insufficient-evidence，不要凭常识补全，也不要因为判据写得漂亮就通过。",
    "输出严格的 JSON，且只输出 JSON：",
    '{"verdict":"pass|fail|insufficient-evidence","reason":"不超过 120 字"}',
    "判定口径：pass=证据直接支持判据；fail=证据明确违反判据；insufficient-evidence=证据不足以判断（含证据为空、只沾边不直接支持）。",
  ].join("\n");
  const user = [`【判据】\n${rubric}`, `【运行证据】\n${evidenceText || "(无证据)"}`].join("\n\n");
  return { system, user };
}

// ── 判决解析（D2 三态；越界一律 insufficient-evidence） ────────────────────

export function parseJudgeOutput(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { verdict: "insufficient-evidence", reason: "judge returned empty output" };
  // 容忍围栏/多余文字：取第一个 { 到最后一个 }。
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { verdict: "insufficient-evidence", reason: "judge output is not JSON" };
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { verdict: "insufficient-evidence", reason: "judge output is not valid JSON" };
  }
  const verdict = String(parsed?.verdict ?? "").trim();
  if (!JUDGE_VERDICTS.includes(verdict)) {
    return { verdict: "insufficient-evidence", reason: `judge returned an unknown verdict '${verdict}'` };
  }
  return { verdict, reason: typeof parsed?.reason === "string" ? parsed.reason.slice(0, 400) : "" };
}

// ── 单条判定 ────────────────────────────────────────────────────────────────

// deps: { lane, entries, fetchImpl, timeoutMs } —— 测试全注入，零真模型调用。
// 返回 { verdict, reason, audit }；audit 是报告里留档的那一份。
export async function judgeAssertion({ assertionId, rubric, evidenceText, productionLanes = [], lane = null, fetchImpl = fetch, timeoutMs = JUDGE_LIMITS.timeoutMs }) {
  const evidence = String(evidenceText ?? "");
  const auditBase = {
    assertionId,
    rubric: String(rubric ?? ""),
    evidenceDigest: sha(evidence),
    judgedAt: new Date().toISOString(),
  };

  if (evidence.length > JUDGE_LIMITS.maxEvidenceChars) {
    return {
      verdict: "insufficient-evidence",
      reason: `evidence exceeds the judge cap (${evidence.length} > ${JUDGE_LIMITS.maxEvidenceChars} chars) — trim the acceptance target, not the evidence`,
      audit: { ...auditBase, verdict: "insufficient-evidence", model: null, endpointDigest: null, promptHash: null, rawVerdict: null },
    };
  }

  const resolved = lane ?? resolveJudgeLane();
  if (!resolved) {
    return {
      verdict: "insufficient-evidence",
      reason: "no judge lane is configured on this deployment (LLM route missing)",
      audit: { ...auditBase, verdict: "insufficient-evidence", model: null, endpointDigest: null, promptHash: null, rawVerdict: null },
    };
  }

  // D4 禁自证：judge 车道不得与任何产出车道相同；产出车道解析不出也拒判。
  const production = productionLanes.filter(Boolean);
  if (production.length === 0) {
    return {
      verdict: "insufficient-evidence",
      reason: "cannot resolve the production lane — refusing to let the producing model grade itself",
      audit: { ...auditBase, verdict: "insufficient-evidence", model: resolved.model, endpointDigest: sha(resolved.baseUrl).slice(0, 16), promptHash: null, rawVerdict: null },
    };
  }
  if (production.includes(resolved.laneId)) {
    return {
      verdict: "insufficient-evidence",
      reason: "judge lane is the same lane that produced the work — self-grading is refused; pin a different BLUEPRINT_JUDGE_MODEL",
      audit: { ...auditBase, verdict: "insufficient-evidence", model: resolved.model, endpointDigest: sha(resolved.baseUrl).slice(0, 16), promptHash: null, rawVerdict: null },
    };
  }

  const { system, user } = buildJudgePrompt({ rubric, evidenceText: evidence });
  const promptHash = sha(`${system}\n${user}`).slice(0, 16);
  const audit = {
    ...auditBase,
    model: resolved.model,
    endpointDigest: sha(resolved.baseUrl).slice(0, 16),
    promptHash,
  };

  let raw = "";
  try {
    const res = await fetchImpl(`${resolved.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: resolved.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        verdict: "insufficient-evidence",
        reason: `judge lane HTTP ${res.status}: ${body.slice(0, 160)}`,
        audit: { ...audit, verdict: "insufficient-evidence", rawVerdict: null },
      };
    }
    const json = await res.json().catch(() => null);
    raw = json?.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    return {
      verdict: "insufficient-evidence",
      reason: `judge lane unreachable: ${err?.message || err}`,
      audit: { ...audit, verdict: "insufficient-evidence", rawVerdict: null },
    };
  }

  const parsed = parseJudgeOutput(raw);
  return {
    verdict: parsed.verdict,
    reason: parsed.reason,
    audit: { ...audit, verdict: parsed.verdict, rawVerdict: String(raw).slice(0, 2000) },
  };
}