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
    preflight: async (ctx) => {
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
    preflight: async (ctx) => ({ ok: true }),
  },
  {
    id: "facet.pack.curation",
    line: "facet",
    tool: "facet_market_pack_curation",
    risk: RISK.publish,
    target: TARGET.cloud,
    impact: (args) => `策展操作：${args.action} 包「${args.id}」(category=${args.category})`,
    preflight: async (ctx) => ({ ok: true }),
  },
  {
    id: "facet.agent.toggle",
    line: "facet",
    tool: "facet_agent_toggle",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `将 agent「${args.path}」${args.enabled ? "启用" : "停用"}`,
    preflight: async (ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.agent.pause",
    line: "wanxing",
    tool: "wanxing_agent_pause",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `暂停 agent「${args.agentId}」(pack=${args.packId})`,
    preflight: async (ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.agent.resume",
    line: "wanxing",
    tool: "wanxing_agent_resume",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `恢复 agent「${args.agentId}」(pack=${args.packId})`,
    preflight: async (ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.callers.add",
    line: "wanxing",
    tool: "wanxing_callers_add",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `向 agent「${args.agentId}」允许清单添加 caller ${args.email}`,
    preflight: async (ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.callers.remove",
    line: "wanxing",
    tool: "wanxing_callers_remove",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `从 agent「${args.agentId}」允许清单移除 caller ${args.user_id}`,
    preflight: async (ctx) => ({ ok: true }),
  },
  {
    id: "wanxing.agent.deploy",
    line: "wanxing",
    tool: "wanxing_agent_deploy",
    risk: RISK.destructive,
    target: TARGET.any,
    impact: (args) => `部署 agent「${args.agentId}」(pack=${args.packId}) 到 ${args.target === "cloud" ? "云端" : args.target}`,
    preflight: async (ctx) => {
      // Preflight for deploy is implemented in routes/actions.js; this stub
      // returns ok and lets the route layer override with real checks.
      return { ok: true };
    },
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
