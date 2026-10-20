// ── Action gate routes (add-line-boards-and-action-gate) ────────────────────
//
// POST /api/actions/propose — create a proposal (model or board button)
// POST /api/actions/:id/approve — approve (owner-only)
// POST /api/actions/:id/reject — reject
// GET /api/actions/:id — query proposal
//
// All executions go through a single executor path; audit is written here.
// No secrets in logs or responses.

import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { getDb, nowIso } from "../../db.js";
import { getAction, isRegistered, riskToTierMap } from "../../lib/action-registry.js";
import { preflightAction } from "../../lib/action-preflight.js";

/**
 * SHA256 digest of JSON stringified args (for audit, never returns raw args).
 */
function argsDigest(args) {
  const json = JSON.stringify(args);
  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Create a proposal.
 * Body: { actionId, args, proposerSession?, proposerEmail? }
 * Returns: { proposalId, state: "pending", impact, risk, target }
 */
export async function proposeAction(req, res) {
  if (!req.body || typeof req.body.actionId !== "string") {
    return res.status(400).json({ error: "actionId required" });
  }
  const { actionId, args, proposerSession, proposerEmail } = req.body;

  // Check registration
  if (!isRegistered(actionId)) {
    return res.status(400).json({ error: "action not registered" });
  }
  const action = getAction(actionId);

  // Preflight (real checks: deployer key for cloud, seat online for desktop)
  try {
    const pf = await preflightAction(action, { email: proposerEmail }, args);
    if (!pf.ok) {
      return res.status(400).json({ error: "preflight failed", details: pf.details });
    }
  } catch (err) {
    console.error("[actions] preflight failed:", err.message);
    return res.status(500).json({ error: "preflight error" });
  }

  const proposalId = randomUUID();
  const created = nowIso();
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  const stmtInsert = db.prepare(`
    INSERT INTO action_proposals (
      proposal_id, line, action_id, args_digest, args_json, risk, target, impact_text,
      proposer_session, proposer_email, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  try {
    stmtInsert.run(
      proposalId,
      action.line,
      action.id,
      argsDigest(args),
      JSON.stringify(args),
      action.risk,
      action.target,
      action.impact(args),
      proposerSession ?? null,
      proposerEmail ?? null,
      created,
      created
    );
  } catch (err) {
    console.error("[actions] insert failed:", err.message);
    return res.status(500).json({ error: "insert failed" });
  }

  const tier = riskToTierMap()[action.risk] ?? "unknown";
  return res.json({
    proposalId,
    state: "pending",
    impact: action.impact(args),
    risk: action.risk,
    target: action.target,
    tier,
  });
}

/**
 * Approve a proposal (owner-only).
 * Body: {} (no args needed; proposalId in URL)
 * Returns: { state: "approved"|"executed", resultSummary? }
 */
export async function approveAction(req, res) {
  const { id: proposalId } = req.params;
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  // Get proposal
  const row = db.prepare(`
    SELECT * FROM action_proposals WHERE proposal_id = ?
  `).get(proposalId);
  if (!row) {
    return res.status(404).json({ error: "proposal not found" });
  }
  if (row.state !== "pending") {
    return res.status(400).json({ error: `proposal already ${row.state}` });
  }

  // Owner check: proposer_email must match req.user.email (auth middleware sets it)
  const userEmail = req.user?.email;
  if (!userEmail || !row.proposer_email || userEmail.toLowerCase() !== row.proposer_email.toLowerCase()) {
    return res.status(403).json({ error: "only owner can approve" });
  }

  const approvedAt = nowIso();
  const updated = approvedAt;

  // Update to approved
  db.prepare(`
    UPDATE action_proposals SET approver_email = ?, approved_at = ?, state = 'approved', updated_at = ?
    WHERE proposal_id = ?
  `).run(userEmail, approvedAt, updated, proposalId);

  // Execute immediately for non-async tiers (read/write/destructive/cost)
  // Async (publish) stays in approved state until external approval flow completes
  const tier = riskToTierMap()[row.risk];
  let resultSummary = null;

  if (tier !== "async") {
    try {
      resultSummary = await executeAction(proposalId);
      // Update to executed. resultSummary MUST be a string (SQLite bind).
      db.prepare(`
        UPDATE action_proposals SET state = 'executed', result_summary = ?, updated_at = ?
        WHERE proposal_id = ?
      `).run(String(resultSummary), nowIso(), proposalId);

      // Broadcast board_changed event for the line
      if (req.ctx && req.ctx.broadcast) {
        req.ctx.broadcast({ type: "board_changed", line: row.line, resources: [row.action_id.split(".")[0]] });
      }
      return res.json({ state: "executed", resultSummary: String(resultSummary) });
    } catch (err) {
      console.error("[actions] execution failed:", err.message);
      // Spec: execution failure keeps the action inspectable and retryable —
      // state 'failed' (NOT 'rejected', which means the human said no).
      db.prepare(`
        UPDATE action_proposals SET state = 'failed', result_summary = ?, updated_at = ?
        WHERE proposal_id = ?
      `).run(`execution failed: ${err.message}`, nowIso(), proposalId);
      return res.status(500).json({ error: "execution failed", message: err.message });
    }
  }
  // Publish tier: wait for async approval (not implemented in v1)
  return res.json({ state: "approved", resultSummary: "awaiting async approval" });
}

/**
 * Reject a proposal.
 * Returns: { state: "rejected" }
 */
export async function rejectAction(req, res) {
  const { id: proposalId } = req.params;
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  const row = db.prepare(`SELECT * FROM action_proposals WHERE proposal_id = ?`).get(proposalId);
  if (!row) {
    return res.status(404).json({ error: "proposal not found" });
  }
  if (row.state !== "pending") {
    return res.status(400).json({ error: `proposal already ${row.state}` });
  }

  const userEmail = req.user?.email;
  if (!userEmail || !row.proposer_email || userEmail.toLowerCase() !== row.proposer_email.toLowerCase()) {
    return res.status(403).json({ error: "only owner can reject" });
  }

  db.prepare(`
    UPDATE action_proposals SET state = 'rejected', updated_at = ? WHERE proposal_id = ?
  `).run(nowIso(), proposalId);

  return res.json({ state: "rejected" });
}

/**
 * Query proposal by id.
 */
export async function getActionProposal(req, res) {
  const { id: proposalId } = req.params;
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  const row = db.prepare(`
    SELECT proposal_id, line, action_id, risk, target, impact_text, state,
           proposer_session, proposer_email, approved_at, expired_at, result_summary,
           created_at, updated_at
    FROM action_proposals WHERE proposal_id = ?
  `).get(proposalId);

  if (!row) {
    return res.status(404).json({ error: "proposal not found" });
  }

  // Never return args_json or args_digest to client (audit sensitivity)
  return res.json(row);
}

/**
 * Single execution path for all actions.
 * In v1, this calls the underlying MCP tool via loopback REST bridge.
 * Writes an audit row on BOTH outcomes (spec: 执行留痕 — 成功与失败都进台账).
 * Returns a plain-string result summary (SQLite bind safety).
 * TODO: implement actual tool invocation via the platform's loopback REST
 * bridge (same pattern as cron-mcp / delegation-mcp).
 */
export async function executeAction(proposalId) {
  const db = getDb();
  if (!db) throw new Error("database unavailable");

  const row = db.prepare(`
    SELECT * FROM action_proposals WHERE proposal_id = ?
  `).get(proposalId);

  if (!row) throw new Error("proposal not found");
  if (row.state !== "approved") throw new Error("proposal not approved");

  const action = getAction(row.action_id);
  if (!action) throw new Error("action not found");

  // Reconstruct args from JSON storage
  let args;
  try {
    args = row.args_json ? JSON.parse(row.args_json) : {};
  } catch {
    throw new Error("invalid args_json");
  }

  const startedAt = Date.now();
  let resultSummary;
  let errorText = null;
  try {
    // v1 placeholder executor: the real invocation lands in the follow-up
    // change that wires per-action tool calls (wanxing_agent_deploy etc.).
    console.log(`[actions/execute] executing ${action.id} (proposal ${proposalId})`);
    resultSummary = `executed ${action.id} (placeholder executor; ${Object.keys(args).length} arg keys)`;
  } catch (err) {
    errorText = err.message;
    resultSummary = `failed: ${err.message}`;
    throw err;
  } finally {
    // Audit both outcomes; never store args or secrets in the ledger.
    try {
      db.prepare(`
        INSERT INTO action_audit (
          proposal_id, line, action_id, args_digest, risk, target, impact_text,
          executor_info, duration_ms, error_text, result_summary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.proposal_id,
        row.line,
        row.action_id,
        row.args_digest,
        row.risk,
        row.target,
        row.impact_text,
        "v1-placeholder-executor",
        Date.now() - startedAt,
        errorText,
        resultSummary,
        nowIso(),
      );
    } catch (auditErr) {
      // Audit failure must never mask the action's own outcome.
      console.error("[actions] audit write failed:", auditErr.message);
    }
  }
  return resultSummary;
}

// Register routes
export function registerActionsRoutes(ctx) {
  const { app } = ctx;

  // Attach ctx to requests so handlers can broadcast board_changed events
  app.use((req, _res, next) => {
    req.ctx = ctx;
    next();
  });

  app.post("/api/actions/propose", async (req, res) => {
    try {
      await proposeAction(req, res);
    } catch (err) {
      console.error("[actions/propose] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/api/actions/:id/approve", async (req, res) => {
    try {
      await approveAction(req, res);
    } catch (err) {
      console.error("[actions/approve] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/api/actions/:id/reject", async (req, res) => {
    try {
      await rejectAction(req, res);
    } catch (err) {
      console.error("[actions/reject] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/api/actions/:id", async (req, res) => {
    try {
      await getActionProposal(req, res);
    } catch (err) {
      console.error("[actions/get] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });
}
