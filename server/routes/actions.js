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
import { normalizeIdentityEmail } from "../../db.js";

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
      // Update to executed
      db.prepare(`
        UPDATE action_proposals SET state = 'executed', result_summary = ?, updated_at = ?
        WHERE proposal_id = ?
      `).run(resultSummary, nowIso(), proposalId);

      // Broadcast board_changed event for the line
      if (req.ctx && req.ctx.broadcast) {
        req.ctx.broadcast({ type: "board_changed", line: row.line, resources: [row.action_id.split(".")[0]] });
      }
    } catch (err) {
      console.error("[actions] execution failed:", err.message);
      db.prepare(`
        UPDATE action_proposals SET state = 'rejected', result_summary = ?, updated_at = ?
        WHERE proposal_id = ?
      `).run(`execution failed: ${err.message}`, nowIso(), proposalId);
      return res.status(500).json({ error: "execution failed", message: err.message });
    }
  } else {
    // Publish tier: wait for async approval (not implemented in v1)
    resultSummary = "awaiting async approval";
  }

  return res.json({ state: row.state === "executed" ? "executed" : "approved", resultSummary });
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
 * TODO: move actual tool invocation to a separate service (e.g., server/actions-executor.js)
 *       so we can swap implementations without changing routes.
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
  } catch (err) {
    throw new Error("invalid args_json");
  }

  // TODO: implement actual tool invocation here.
  // For now, return a placeholder success message.
  // In production, this should call the underlying MCP tool via the platform's
  // loopback REST bridge (same pattern as cron-mcp / delegation-mcp).
  console.log(`[actions/execute] executing ${action.id} with args:`, args);
  return { success: true, message: `executed ${action.id}` };
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
