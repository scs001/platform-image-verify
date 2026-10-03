// ── Wanxing facade wiring (add-wanxing-serving-api) ──────────────────────────
//
// ADR-0014's external front door, mounted on the gateway process: the A2A
// protocol face over the protocol-agnostic kernel, the deployer's caller
// allowlist management (packs-surface auth), and the ops usage view. The
// registry stays internal — the facade reaches runtime routes through the
// registry proxy with the platform's own credentials, exactly like the
// platform's internal a2a client. Deployment bookkeeping is likewise read
// over HTTP (add-facet-platform S0): the packs surface's internal API, so
// the facet extraction (S1) repoints one env and no code.

import path from "node:path";
import express from "express";
import { createWanxingStore } from "./store.js";
import { createWanxingCore, slugFor } from "./core.js";
import { createA2aFace } from "./a2a.js";
import { createSub2apiClient } from "../../lib/sub2api-admin.js";

export function registerWanxingRoutes(app, {
  dataRoot,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups = [],
  adminGroups = [],
  env = process.env,
  // Injection seams for tests.
  fetchImpl = null,
  store: storeOpt = null,
  sub2api: sub2apiOpt = null,
}) {
  const store = storeOpt ?? createWanxingStore({ file: path.join(dataRoot, "wanxing.db") });

  const registryUrl = () => (env.AGENT_SERVING_REGISTRY_URL || env.REGISTRY_URL || "").replace(/\/+$/, "");
  const registryToken = () => env.AGENT_SERVING_REGISTRY_TOKEN || env.MARKET_REGISTRY_TOKEN || "";
  const backendToken = () => env.AGENT_SERVING_BACKEND_TOKEN || "";

  const sub2api =
    sub2apiOpt ??
    (env.SUB2API_ADMIN_KEY
      ? createSub2apiClient({
          baseUrl: env.SUB2API_BASE_URL || "http://127.0.0.1:32080",
          adminKey: env.SUB2API_ADMIN_KEY,
          ...(fetchImpl ? { fetchImpl } : {}),
        })
      : null);

  const core = createWanxingCore({ store, sub2api });

  const doFetch = (p, init = {}) =>
    (fetchImpl ?? fetch)(`${registryUrl()}${p}`, {
      ...init,
      headers: {
        ...(registryToken() ? { Authorization: `Bearer ${registryToken()}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  // Dual internal credentials for runtime forwarding — the same pair the
  // platform's a2a client rides (registry service credential on
  // X-Authorization, deployment backend credential on Authorization).
  const forwardHeaders = () => ({
    "X-Authorization": `Bearer ${registryToken()}`,
    Authorization: `Bearer ${backendToken()}`,
  });

  // ── Deployment bookkeeping over the packs internal API (S0) ────────────────
  // Read-only, service-credential gated (the same registry token the runner
  // rides). Base URL is env-driven and read per call so S1's extraction (and
  // tests) repoint it without touching this module; the loopback default is
  // the marketplace mounted in this same process.
  const packsInternalBase = () =>
    (env.PACKS_INTERNAL_BASE_URL || `http://127.0.0.1:${env.GATEWAY_PORT || 3080}`).replace(/\/+$/, "");
  const packsInternalFetch = async (p) => {
    let r;
    try {
      r = await (fetchImpl ?? fetch)(`${packsInternalBase()}${p}`, {
        headers: { Authorization: `Bearer ${registryToken()}` },
      });
    } catch {
      throw Object.assign(new Error(`packs internal API unreachable (${p})`), { code: "PACKS_INTERNAL_UNAVAILABLE" });
    }
    if (!r.ok) {
      throw Object.assign(new Error(`packs internal API ${p} -> ${r.status}`), { code: "PACKS_INTERNAL_UNAVAILABLE" });
    }
    return r.json();
  };

  // Slug resolution scans the full deployment bookkeeping; the registry entry
  // (visibility/paused/card) is the live truth the face layers on top.
  const resolveDeployment = async (slug) => {
    if (!slug) return null;
    const deployments = (await packsInternalFetch("/api/packs/internal/deployments")).deployments ?? [];
    return deployments.find((d) => slugFor(d.agentPath) === slug) ?? null;
  };
  const listDeployments = async () => {
    const deployments = (await packsInternalFetch("/api/packs/internal/deployments")).deployments ?? [];
    return deployments.map((d) => ({ slug: slugFor(d.agentPath), agentPath: d.agentPath }));
  };

  const face = createA2aFace({
    core,
    resolveDeployment,
    listDeployments,
    forwardHeaders,
    registryFetch: doFetch,
    config: {
      // Runtime route through the registry proxy (ADR-0004's distribution
      // plane) — the facade never addresses runner origins directly.
      agentUrlFor: (agentPath) => `${registryUrl()}/agent${agentPath}/`,
    },
    ...(fetchImpl ? { upstreamFetch: fetchImpl } : {}),
  });
  face.register(app);

  // ── Caller allowlist management (spec: agent admission) ──────────────────
  // Pack author or creator group — the same gate as deploy. Emails resolve
  // to sub2api user ids at add time (an account must exist before it can be
  // allowlisted); the stored id is what admission checks.
  const packAuth = async (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    let isAuthor = false;
    let rows = [];
    try {
      const author = (await packsInternalFetch(`/api/packs/internal/author/${encodeURIComponent(req.params.id)}`)).authorEmail ?? null;
      isAuthor = author === user.email;
      rows = (await packsInternalFetch(`/api/packs/internal/deployments/${encodeURIComponent(req.params.id)}`)).deployments ?? [];
    } catch {
      res.status(503).json({ error: "deployment source unreachable" });
      return null;
    }
    if (!isAuthor && !creatorGroups.some((g) => (user.groups || []).includes(g))) {
      res.status(403).json({ error: "Pack author or creator group required" });
      return null;
    }
    const row = rows.find((d) => d.agentId === req.params.agentId);
    if (!row) {
      res.status(404).json({ error: "Deployment not found" });
      return null;
    }
    return { user, row };
  };

  app.get("/api/packs/:id/deployments/:agentId/callers", async (req, res) => {
    const ctx = await packAuth(req, res);
    if (!ctx) return;
    res.json({ callers: store.allowlistList(slugFor(ctx.row.agentPath)) });
  });

  app.post("/api/packs/:id/deployments/:agentId/callers", express.json({ limit: "16kb" }), async (req, res) => {
    const ctx = await packAuth(req, res);
    if (!ctx) return;
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return res.status(400).json({ error: "email required" });
    if (!sub2api || sub2api.degraded()) return res.status(503).json({ error: "billing plane not configured — allowlists are inactive" });
    let account;
    try {
      account = await sub2api.findUserByEmail(email);
    } catch (e) {
      return res.status(502).json({ error: `billing account lookup failed: ${e.message}` });
    }
    if (!account) {
      return res.status(404).json({
        error: "no sub2api account for that email yet — the caller signs in once at the billing panel (Logto) to create it",
        code: "NO_SUB2API_ACCOUNT",
        panelUrl: env.SUB2API_PANEL_URL || "https://token.finddatatech.cloud",
      });
    }
    store.allowlistAdd(slugFor(ctx.row.agentPath), account.userId, email);
    res.json({ ok: true, caller: { userId: account.userId, email } });
  });

  app.delete("/api/packs/:id/deployments/:agentId/callers", express.json({ limit: "16kb" }), async (req, res) => {
    const ctx = await packAuth(req, res);
    if (!ctx) return;
    const userId = Number(req.body?.userId ?? req.query?.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: "userId required" });
    store.allowlistRemove(slugFor(ctx.row.agentPath), userId);
    res.json({ ok: true });
  });

  // ── Ops usage view (spec: the ops board shows both dimensions) ────────────
  // Authenticated like the billing board: an admin user, or the runner
  // service credential (the ops console already rides one of these).
  app.get("/api/wanxing/v1/ops/usage", (req, res) => {
    const asAdmin = (() => {
      const user = resolveUser(req);
      return user && adminGroups.some((g) => (user.groups || []).includes(g));
    })();
    const token = registryToken();
    if (!asAdmin && (!token || req.headers.authorization !== `Bearer ${token}`)) {
      return res.status(401).json({ error: "admin or runner service credential required" });
    }
    res.json(store.usageBoard());
  });

  // Pending-settlement sweep: retries everything the turn path could not
  // settle inline (sub2api hiccup, process restart). Row ids are the
  // deduction idempotency keys, so a sweep is always safe to re-run.
  const sweep = setInterval(() => void core.settlePending().catch(() => {}), 60_000);
  sweep.unref?.();
  void core.settlePending().catch(() => {});

  return {
    core,
    store,
    face,
    close() {
      clearInterval(sweep);
      if (!storeOpt) store.close();
    },
  };
}
