// ── Desktop fleet console lane (add-desktop-fleet-console) ───────────────────
//
// The desktop fleet page's read face: the cell server proxies the LOCAL
// runner's /health (loopback, same machine) and the PUBLIC registry's a2a
// directory (with the seat's existing registry credential). No new desktop
// credentials are introduced and the renderer never crosses origins.
//
// Both endpoints degrade honestly: a runner that is not enabled/running and a
// registry that is not configured are 503 + a machine-readable code the page
// renders as guidance, not an error toast.

import { Router } from "express";

const RUNNER_TIMEOUT_MS = 2000;

export function registerWanxingFleetRoutes(ctx) {
  const router = Router();
  const env = ctx.env || process.env;
  // Injection seam for tests; production always uses the global fetch.
  const doFetch = ctx.fleetFetchImpl || ((u, i) => fetch(u, i));
  const runnerBase = () =>
    String(env.WANXING_RUNNER_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
  const registryBase = () =>
    String(env.AGENT_SERVING_REGISTRY_URL || "").replace(/\/+$/, "");
  const registryToken = () => String(env.AGENT_SERVING_REGISTRY_TOKEN || "");

  router.get("/live", async (_req, res) => {
    try {
      const r = await doFetch(`${runnerBase()}/health`, { signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS) });
      if (!r.ok) {
        return res.status(503).json({ error: "runner_not_running", status: r.status });
      }
      const body = await r.json();
      return res.json(body);
    } catch {
      // Not enabled, still booting, or gone: the page's guidance state.
      return res.status(503).json({ error: "runner_not_running" });
    }
  });

  router.get("/catalog", async (_req, res) => {
    if (!registryBase()) {
      return res.status(503).json({ error: "registry_not_configured" });
    }
    try {
      const r = await doFetch(`${registryBase()}/api/agents?limit=500`, {
        headers: {
          Accept: "application/json",
          ...(registryToken() ? { Authorization: `Bearer ${registryToken()}` } : {}),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        return res.status(502).json({ error: "registry_unreachable", status: r.status });
      }
      const doc = await r.json();
      const rows = Array.isArray(doc) ? doc : (doc?.agents ?? doc?.items ?? []);
      // Read-only projection: metadata internals never reach the renderer.
      const agents = rows
        .filter((a) => a && a.is_enabled !== false && String(a.supported_protocol || "").toLowerCase() === "a2a")
        .map((a) => ({
          path: a.path ?? null,
          name: a.name ?? null,
          description: a.description ?? null,
          version: a.version ?? null,
          tags: Array.isArray(a.tags) ? a.tags : [],
        }));
      return res.json({ agents });
    } catch {
      return res.status(502).json({ error: "registry_unreachable" });
    }
  });

  ctx.app.use("/api/wanxing/fleet", router);
}
