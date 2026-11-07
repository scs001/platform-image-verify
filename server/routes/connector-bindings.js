// Connector binding routes (add-connector-bindings D6/D7).
//
// The status face, the declarative grant, the progressive grant and revoke.
// Shapes follow the connector credential routes next door: identity-scoped,
// token-free projections, auth-required in hosted mode, auth off = the machine
// owner. Nothing here returns a token or a PAT id to the browser — the scope and
// the state are the UI's business, the credential is not.

import * as bindings from "../../connector-bindings.js";
import * as grants from "../../connector-grants.js";

function identity(req) {
  return req.ssoUser || req.user || null;
}

function requireOwner(req, res, ctx) {
  if (!ctx.authEnabled) return true;
  if (!identity(req)?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return false;
  }
  return true;
}

function dbReady(res, ctx) {
  if (ctx.db.isDbReady()) return true;
  res.status(503).json({ error: "Connector bindings are disabled (database unavailable)" });
  return false;
}

// The client-facing projection of one binding: what the pack asked for, what the
// world says, and what the user must do next. Deliberately no token, no PAT id,
// no connection id (an id is a handle; the name is what a human recognizes).
function projectRow(row) {
  return {
    packId: row.packId,
    bindingKey: row.bindingKey,
    provider: row.provider,
    operations: row.operations,
    connectionName: row.connectionName ?? null,
    connectionVirtual: !!row.connectionVirtual,
    status: row.status,
    reason: row.reason,
    optional: !!row.optional,
    grantedAt: row.grantedAt ?? null,
    packVersion: row.packVersion ?? null,
  };
}

export function registerConnectorBindingRoutes(ctx) {
  const { app } = ctx;
  const owner = (req) => identity(req)?.email ?? null;

  // Every binding this identity has a ledger row for (optionally one pack).
  app.get("/api/connector/bindings", (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const email = owner(req);
    const packId = typeof req.query.packId === "string" ? req.query.packId : null;
    res.json({
      bindings: bindings
        .listBindings(email, packId)
        .map((row) => projectRow({ ...row, connectionName: null })),
    });
  });

  // Re-resolve a pack's bindings against the connector right now (the surface's
  // refresh, and what install/activate call server-side).
  app.post("/api/connector/bindings/refresh", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    if (!packId) return res.status(400).json({ error: "packId is required" });
    const result = await grants.refreshPackBindings({ email: owner(req), packId });
    if (!result.ok) return res.status(404).json({ error: "pack is not installed", code: result.code });
    res.json({ gate: result.gate, bindings: result.bindings.map(projectRow) });
  });

  // The declarative grant: one confirmation, every resolvable binding of the
  // pack. The body may narrow the set (bindingKeys) but never widen it.
  app.post("/api/connector/bindings/grant", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    if (!packId) return res.status(400).json({ error: "packId is required" });
    const bindingKeys = Array.isArray(req.body?.bindingKeys) ? req.body.bindingKeys.filter((k) => typeof k === "string") : null;
    const result = await grants.grantPack({ email: owner(req), packId, bindingKeys });
    if (result.granted.length === 0 && result.failed.length === 0) {
      return res.status(404).json({ error: "no bindings to grant", code: "no_bindings" });
    }
    if (result.granted.length === 0) {
      // Nothing was granted: name why (the first failure is the actionable one).
      return res.status(409).json({ error: "no binding could be granted", code: result.failed[0]?.code ?? "grant_failed", failed: result.failed });
    }
    res.json({ granted: result.granted, failed: result.failed });
  });

  // Progressive grant: one action was rejected for scope; widen the binding that
  // owns it. The rejected call is NOT replayed here.
  app.post("/api/connector/bindings/grant-for-action", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    const actionId = typeof req.body?.actionId === "string" ? req.body.actionId : "";
    if (!packId || !actionId) return res.status(400).json({ error: "packId and actionId are required" });
    const result = await grants.grantForAction({ email: owner(req), packId, actionId });
    if (!result.ok) {
      const status = result.code === "unknown_action" ? 404 : result.code === "not_grantable" ? 400 : 409;
      return res.status(status).json({ error: "grant not applied", ...result });
    }
    res.json(result);
  });

  // Revoke one binding: connector-side PAT (best effort) + local rows.
  app.post("/api/connector/bindings/revoke", async (req, res) => {
    if (!requireOwner(req, res, ctx) || !dbReady(res, ctx)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    const bindingKey = typeof req.body?.bindingKey === "string" ? req.body.bindingKey : "";
    if (!packId || !bindingKey) return res.status(400).json({ error: "packId and bindingKey are required" });
    const result = await grants.revokeBinding({ email: owner(req), packId, bindingKey });
    res.json({
      revoked: result.removed,
      revokedOnConnector: result.revokedOnConnector,
      status: bindings.listBindings(owner(req), packId).find((row) => row.bindingKey === bindingKey)?.status ?? null,
    });
  });
}
