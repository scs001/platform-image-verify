// ── Action registry (add-line-boards-and-action-gate) ────────────────────────
//
// Central declaration of all gated actions: id, line, underlying tool, risk,
// target requirements, impact template, and preflight hook. Risk determines the
// confirmation tier; unregistered actions MUST NOT be executed by the copilot.
//
// v1 entries (design D3):
//   facet.pack.publish           → publish    → cloud     → async approval
//   facet.pack.visibility        → write      → cloud     → inline confirm
//   facet.pack.curation          → publish    → cloud     → async approval
//   facet.agent.toggle           → write      → cloud     → inline confirm
//   wanxing.agent.pause          → write      → cloud     → inline confirm
//   wanxing.agent.resume         → write      → cloud     → inline confirm
//   wanxing.callers.add          → write      → cloud     → inline confirm
//   wanxing.callers.remove       → write      → cloud     → inline confirm
//   wanxing.agent.deploy         → destructive→ cloud/desktop → second confirm + impact
//
// wire entries (add-wire-line-board, design D2): ids are verbatim fd-wire
// REGISTRY ids; tool + risk are pinned to lib/wire-tool-risk.js (the vendored
// tool_risk snapshot) by scripts/test-wire-tool-risk.mjs. Every wire action
// executes with the user's own wire-customer credential, so preflight refuses
// when that credential is absent.
//
// `userFilledArgs` (design D5): parameters the USER must type at confirmation.
// The gate strips any model-supplied value for these keys at propose time and
// only accepts them from the approve body — the mechanism behind "never
// auto-fill the compliance fields".

import { requireLineCredential } from "./action-preflight.js";

const RISK = Object.freeze({
  read: "read",
  write: "write",
  destructive: "destructive",
  cost: "cost",
  publish: "publish",
});

const TARGET = Object.freeze({
  cloud: "cloud",
  desktop: "desktop",
  any: "any",
});

// Mapping from risk to confirmation tier (spec: action-gate).
const riskToTier = {
  [RISK.read]: "auto",
  [RISK.write]: "inline",
  [RISK.destructive]: "second",
  [RISK.cost]: "second",
  [RISK.publish]: "async",
};

// v1 action roster (nine items). Each entry is immutable after registration.
const ACTIONS = Object.freeze([
  {
    id: "facet.pack.publish",
    line: "facet",
    tool: "facet_market_pack_publish",
    risk: RISK.publish,
    target: TARGET.cloud,
    impact: (args) => `发布/更新包「${args.manifest?.name || args.packId}」v${args.version || "new"} 到市场`,
    preflight: async (_ctx) => {
      // Requires creators group membership (already enforced by the underlying tool);
      // here we just return ok. Real validation happens at executor.
      return { ok: true };
    },
  },
  {
    id: "facet.pack.visibility",
    line: "facet",
    tool: "facet_market_pack_visibility",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `将包「${args.id}」可见性改为 ${args.visibility}`,
    preflight: async (_ctx) => ({ ok: true }),
  },
  {
    id: "facet.pack.curation",
    line: "facet",
    tool: "facet_market_pack_curation",
    risk: RISK.publish,
    target: TARGET.cloud,
    impact: (args) => `策展操作：${args.action} 包「${args.id}」(category=${args.category})`,
    preflight: async (_ctx) => ({ ok: true }),
  },
  {
    id: "facet.agent.toggle",
    line: "facet",
    tool: "facet_agent_toggle",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `将 agent「${args.path}」${args.enabled ? "启用" : "停用"}`,
    preflight: async (_ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.agent.pause",
    line: "wanxing",
    tool: "wanxing_agent_pause",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `暂停 agent「${args.agentId}」(pack=${args.packId})`,
    preflight: async (_ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.agent.resume",
    line: "wanxing",
    tool: "wanxing_agent_resume",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `恢复 agent「${args.agentId}」(pack=${args.packId})`,
    preflight: async (_ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.callers.add",
    line: "wanxing",
    tool: "wanxing_callers_add",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `向 agent「${args.agentId}」允许清单添加 caller ${args.email}`,
    preflight: async (_ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.callers.remove",
    line: "wanxing",
    tool: "wanxing_callers_remove",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `从 agent「${args.agentId}」允许清单移除 caller ${args.user_id}`,
    preflight: async (_ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.agent.deploy",
    line: "wanxing",
    tool: "wanxing_agent_deploy",
    risk: RISK.destructive,
    target: TARGET.any,
    impact: (args) => `部署 agent「${args.agentId}」(pack=${args.packId}) 到 ${args.target === "cloud" ? "云端" : args.target}`,
    preflight: async (_ctx) => {
      // Preflight for deploy is implemented in routes/actions.js; this stub
      // returns ok and lets the route layer override with real checks.
      return { ok: true };
    },
  },

  // ── wire（柏讯）──────────────────────────────────────────────────────────
  {
    id: "wire.demand.submit",
    line: "wire",
    tool: "wire_demand_submit",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `提交需求单「${args.title || ""}」（公开源 URL 与公开数据声明由你亲自填写，不采纳模型取值）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    // Field names verbatim from fd-wire api/fd_wire_api/demands/schemas.py
    // DemandCreate (source_urls: list[SourceUrl] min 1; public_data_asserted: bool must be true).
    userFilledArgs: [
      { key: "source_urls", label: "公开源 URL", kind: "url[]", required: true },
      { key: "public_data_asserted", label: "公开数据声明", kind: "boolean", required: true },
    ],
  },
  {
    id: "wire.market.subscribe",
    line: "wire",
    tool: "wire_market_subscribe",
    risk: RISK.cost,
    target: TARGET.cloud,
    impact: (args) => `订阅市场数据集「${args.dataset_id ?? args.datasetId ?? ""}」（产生费用；approval 档数据集将转为访问申请）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
  },
  {
    id: "wire.market.unsubscribe",
    line: "wire",
    tool: "wire_market_unsubscribe",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `退订市场数据集「${args.dataset_id ?? args.datasetId ?? ""}」`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
  },
  {
    id: "wire.dataset.create",
    line: "wire",
    tool: "wire_dataset_create",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `创建数据集「${args.name || ""}」（免费档走 CSV 导入，其余档位建列声明空集——由柏讯按档位判定）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
  },
  {
    id: "wire.artifact.publish",
    line: "wire",
    tool: "wire_artifact_publish",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `发布产物 #${args.artifact_id ?? args.artifactId ?? ""}（队内可见；对外分享需另经柏讯审批）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
  },
  {
    id: "wire.artifact.archive",
    line: "wire",
    tool: "wire_artifact_archive",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `归档产物 #${args.artifact_id ?? args.artifactId ?? ""}（可逆：可在柏讯控制台 restore）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
  },
  {
    id: "wire.dataset.correct",
    line: "wire",
    tool: "wire_dataset_correct",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `对数据集「${args.dataset_id ?? args.datasetId ?? ""}」写入一条修正（${args.op || args.kind || "insert/update/delete"}，须带 source 来源标记）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
  },
  {
    id: "wire.dataset.correction.revert",
    line: "wire",
    tool: "wire_dataset_correction_revert",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `撤销数据集「${args.dataset_id ?? args.datasetId ?? ""}」的修正 #${args.correction_id ?? args.correctionId ?? ""}（只置 reverted_at，基行不改写）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
  },
]);

/**
 * Get an action by id. Returns null if not found.
 */
export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) ?? null;
}

/**
 * List actions filtered by line. Optional: only include those matching target.
 */
export function listActions({ line, target } = {}) {
  let out = ACTIONS;
  if (line) out = out.filter((a) => a.line === line);
  if (target) out = out.filter((a) => a.target === target || a.target === TARGET.any);
  return out;
}

/**
 * Check if an action is registered.
 */
export function isRegistered(id) {
  return !!getAction(id);
}

/**
 * The user-filled parameter schema for an action ([] when it declares none).
 */
export function userFilledArgsFor(id) {
  const action = getAction(id);
  return Array.isArray(action?.userFilledArgs) ? action.userFilledArgs : [];
}

/**
 * Drop every user-filled key from model-supplied args (design D5: the model's
 * value for a compliance field is discarded, never surfaced). Returns a new
 * object; the input is not mutated.
 */
export function stripUserFilledArgs(id, args) {
  const schema = userFilledArgsFor(id);
  const out = { ...(args && typeof args === "object" ? args : {}) };
  for (const field of schema) delete out[field.key];
  return out;
}

/**
 * Validate approve-time user values against the schema. Returns
 * { ok: true, values } with only declared keys, or { ok: false, error }.
 */
export function validateUserFilledArgs(id, userArgs) {
  const schema = userFilledArgsFor(id);
  const supplied = userArgs && typeof userArgs === "object" && !Array.isArray(userArgs) ? userArgs : {};
  const allowed = new Set(schema.map((f) => f.key));
  for (const key of Object.keys(supplied)) {
    if (!allowed.has(key)) return { ok: false, error: `unexpected user arg: ${key}` };
  }
  const values = {};
  for (const field of schema) {
    const v = supplied[field.key];
    const present = !isBlank(field.kind, v);
    if (field.required && !present) return { ok: false, error: `missing required user arg: ${field.key}` };
    if (present) values[field.key] = normalizeUserValue(field.kind, v);
  }
  return { ok: true, values };
}

function isBlank(kind, v) {
  if (v === undefined || v === null) return true;
  if (kind === "boolean") return typeof v !== "boolean";
  if (kind === "url[]") return !Array.isArray(v) || v.filter((s) => typeof s === "string" && s.trim()).length === 0;
  return typeof v !== "string" || !v.trim();
}

function normalizeUserValue(kind, v) {
  if (kind === "url[]") return v.map((s) => String(s).trim()).filter(Boolean);
  if (kind === "text") return String(v).trim();
  return v;
}

/**
 * Map risk → tier (for UI rendering and spec compliance).
 */
export function riskToTierMap() {
  return riskToTier;
}

/**
 * Get the tier for a given risk.
 */
export function tierForRisk(risk) {
  return riskToTier[risk] ?? "unknown";
}

// Export constants for tests
export { RISK, TARGET };
