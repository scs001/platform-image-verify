// ── Binding mint/revoke, credential-owner side (fix-deploy-binding-mint-process)
//
// The connector account a deployment binding attenuates from belongs to ONE
// person and lives in that person's cell. The market plane cannot see it, so it
// asks here — over the same forged-identity channel the gateway already uses for
// every other cell call (owner email + the shared gateway secret, loopback only).
//
// Two doors, one implementation:
//   • gateway → this module (the gateway forwards, it holds no credentials);
//   • single-process deployments where this IS the market plane (server.js).
//
// Nothing here decides policy: which bindings may be minted is the ledger's
// answer (mintableBindings), and the parent credential is the user's own active
// connector account. A refusal is reported, never widened.

import express from "express";
import * as deploymentBindings from "../../deployment-bindings.js";
import * as connectorCredentials from "../../connector-credentials.js";

const MAX_BODY = "16kb";

function badRequest(res, error) {
  return res.status(400).json({ ok: false, code: "invalid_input", error });
}

// Only the gateway may speak here. The cell binds loopback, but a header check
// costs nothing and keeps the door closed if a future topology exposes the port.
function fromGateway(req) {
  const secret = String(process.env.CELL_GATEWAY_SECRET || "");
  return !secret || req.headers["x-cloud-gateway-secret"] === secret;
}

export function registerBindingMintRoutes(app) {
  app.post("/api/gateway/binding-mint", express.json({ limit: MAX_BODY }), async (req, res) => {
    if (!fromGateway(req)) return res.status(401).json({ ok: false, code: "unauthorized" });
    const { email, packId, agentId, bindingKey, provider, operations } = req.body || {};
    if (typeof email !== "string" || !email.trim()) return badRequest(res, "email is required");
    if (typeof packId !== "string" || !packId) return badRequest(res, "packId is required");
    if (typeof agentId !== "string" || !agentId) return badRequest(res, "agentId is required");
    if (typeof bindingKey !== "string" || !bindingKey) return badRequest(res, "bindingKey is required");

    // The parent credential must be this person's live account. Without it the
    // answer is "no account" — the caller's surface reports that honestly.
    if (!connectorCredentials.liveToken(email)) {
      return res.status(409).json({ ok: false, code: "no_account" });
    }
    const minted = await deploymentBindings.mintBindingForAgent({
      email,
      packId,
      agentId,
      bindingKey,
      provider: typeof provider === "string" ? provider : null,
      operations: Array.isArray(operations) ? operations : [],
    });
    if (!minted.ok) return res.status(409).json({ ok: false, code: minted.code ?? "mint_failed" });
    // The value crosses the internal channel only; it lands in the market
    // plane's deployment-secret store, which is what serves the runner.
    res.json({
      ok: true,
      name: minted.name,
      secretRef: minted.secretRef,
      secretValue: minted.secretValue,
      patId: minted.patId ?? null,
    });
  });

  app.post("/api/gateway/binding-revoke", express.json({ limit: MAX_BODY }), async (req, res) => {
    if (!fromGateway(req)) return res.status(401).json({ ok: false, code: "unauthorized" });
    const { email, packId, agentIds, keepKeys } = req.body || {};
    if (typeof email !== "string" || !email.trim()) return badRequest(res, "email is required");
    if (typeof packId !== "string" || !packId) return badRequest(res, "packId is required");
    if (!connectorCredentials.liveToken(email)) {
      return res.status(409).json({ ok: false, code: "no_account" });
    }
    try {
      const out = await deploymentBindings.pruneDeploymentBindings({
        email,
        packId,
        agentIds: Array.isArray(agentIds) ? agentIds : [],
        keepKeys: Array.isArray(keepKeys) ? keepKeys : [],
        // The caller owns the store; this side only revokes tokens.
        secrets: [],
        remove: () => {},
      });
      res.json({ ok: true, revoked: out.revoked ?? [], failed: out.failed ?? [] });
    } catch (e) {
      res.status(502).json({ ok: false, code: "revoke_failed", error: e?.message || String(e) });
    }
  });
}
