// Per-line operation-MCP credential API (add-line-credential-refs, design D4).
//
// Family shape (connector/facet-market routes): token write-only, projections
// carry state only, identity-keyed, auth off = machine owner. Line-specific
// shape validation: wire-customer/lex accept a minted Logto ID token (3 JWT
// segments + parseable exp); wanxing-caller accepts a sub2api `sk-` paste.
// Unknown line → 404.

import * as lineCredentials from "../../line-credentials.js";

const LINES = new Set(["wire-customer", "lex", "wanxing-caller"]);

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

function jwtExpiry(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function connectionPayload(email, line) {
  return { line, ...lineCredentials.status(email, line) };
}

function reapplyProfile(ctx, email, groups) {
  ctx
    .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, groups, email)
    ?.catch((e) => console.warn(`[line-credentials] profile update failed: ${e.message}`));
}

export function registerLineCredentialRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/lines/:line/connection", (req, res) => {
    const line = req.params.line;
    if (!LINES.has(line)) return res.status(404).json({ error: "Unknown line" });
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Line credentials are disabled (database unavailable)" });
    }
    res.json(connectionPayload(identity(req)?.email ?? null, line));
  });

  app.post("/api/lines/:line/credential", async (req, res) => {
    const line = req.params.line;
    if (!LINES.has(line)) return res.status(404).json({ error: "Unknown line" });
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Line credentials are disabled (database unavailable)" });
    }
    const { token } = req.body || {};
    if (typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ error: "Missing token" });
    }
    const value = token.trim();
    if (value.length > 8192) {
      return res.status(400).json({ error: "Token is too long" });
    }
    if (line === "wanxing-caller") {
      if (!value.startsWith("sk-")) {
        return res.status(400).json({
          error: "That is not a Wanxing caller key — caller keys start with sk_ (mint one at token.finddatatech.cloud)",
        });
      }
    } else {
      // wire-customer / lex: a minted Logto ID token (3 JWT segments + exp).
      const exp = jwtExpiry(value);
      if (exp === null) {
        return res.status(400).json({
          error: "That is not an ID token — connect via the line's silent mint (or paste a fresh ID token)",
        });
      }
      if (exp <= Date.now()) {
        return res.status(400).json({ error: "That ID token is already expired — mint a fresh one" });
      }
    }
    const user = identity(req);
    const status = lineCredentials.store({ email: user?.email ?? null, line, token: value });
    if (!status) {
      return res.status(500).json({ error: "Failed to store the credential" });
    }
    res.json(connectionPayload(user?.email ?? null, line));
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });

  app.delete("/api/lines/:line/connection", (req, res) => {
    const line = req.params.line;
    if (!LINES.has(line)) return res.status(404).json({ error: "Unknown line" });
    if (!requireOwner(req, res, ctx)) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Line credentials are disabled (database unavailable)" });
    }
    const user = identity(req);
    lineCredentials.disconnect(user?.email ?? null, line);
    res.json({ ok: true, ...connectionPayload(user?.email ?? null, line) });
    reapplyProfile(ctx, user?.email ?? null, user?.groups ?? null);
  });
}
