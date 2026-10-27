// Pack marketplace cell-side API (add-pack-marketplace).
//
// Creator drafts (private to this cell), and the subscribe/upgrade/uninstall
// actions whose materialization lives in pack-store.js. All routes sit behind
// the deployment-shaped MCP manage gate — installing a pack writes MCP
// configurations, so it carries exactly the same authority as adding an MCP
// server by hand. The marketplace itself (browse/publish/subscribe records)
// is gateway- or facet-side; installs resolve the manifest server-side
// (pack-install-server-side-manifest) so the browser never carries manifest
// bodies through the edge.

import * as packStore from "../../pack-store.js";
import { fetchMarketManifest, fetchMarketDetail } from "../pack-manifest-source.js";
import { projectPackList } from "../../lib/pack-locale.js";

// Locale track (add-pack-locale-tracks B): installed-pack cards render under
// the SAME rules as the market — the zh base fields are the main track, a
// requested locale overlays the stored manifest's i18n block (lib/pack-locale
// owns the strategy). The stored row is never rewritten; only this response
// copy is projected, and a projected manifest is still a legal manifest (base
// strings + i18n block intact), so a client round-trip stays valid.
export function registerPackRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  const dbGate = (_req, res) => {
    if (!db.isDbReady()) {
      res.status(503).json({ error: "Packs are disabled (database unavailable)" });
      return false;
    }
    return true;
  };
  const requireGate = (req, res) => {
    if (!dbGate(req, res)) return false;
    if (!ctx.requireMcpManage(req, res)) return false;
    return true;
  };

  const respond = (res, fn) => {
    try {
      const result = fn();
      res.json(result ?? { ok: true });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
        ...(err.modifiedSkills ? { modifiedSkills: err.modifiedSkills } : {}),
      });
    }
  };

  // ── Drafts ────────────────────────────────────────────────────────────────

  app.get("/api/pack-drafts", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({ drafts: packStore.listDrafts() }));
  });

  app.post("/api/pack-drafts", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({ draft: packStore.createDraft(req.body || {}) }));
  });

  app.get("/api/pack-drafts/:id", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({ draft: packStore.getDraft(req.params.id) }));
  });

  app.put("/api/pack-drafts/:id", (req, res) => {
    if (!requireGate(req, res)) return;
    const { name, description, tags, entries } = req.body || {};
    respond(res, () => ({ draft: packStore.updateDraft(req.params.id, { name, description, tags, entries }) }));
  });

  app.delete("/api/pack-drafts/:id", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => packStore.deleteDraft(req.params.id));
  });

  // Note a draft's first published pack id, so the editor's next publish
  // targets the same pack (version append) instead of minting a new one.
  app.post("/api/pack-drafts/:id/published", (req, res) => {
    if (!requireGate(req, res)) return;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : "";
    if (!packId) return res.status(400).json({ error: "packId required" });
    respond(res, () => ({ draft: db.setDraftPublishedPack(req.params.id, packId) }));
  });

  // ── Installed packs ────────────────────────────────────────────────────────

  app.get("/api/mypacks", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => ({
      packs: projectPackList(db.listInstalledPacks(), {
        locale: req.query.locale,
        acceptLanguage: req.headers["accept-language"],
      }),
    }));
  });

  // Materialize a pack version snapshot. Two accepted request shapes
  // (pack-install-server-side-manifest):
  //   - {packId, version} — the manifest is retrieved HERE, server-side, over
  //     the market channel (the same facet request/identity construction as
  //     the /api/packs proxy). This is what the web client sends: manifest
  //     bodies legally embed code/SQL in SKILL.md and the deployment edge WAF
  //     resets such browser POSTs.
  //   - {packId, version, manifest} — rolling-window compatibility; processed
  //     through the identical validation pipeline (one installPack call, one
  //     set of rules). A body manifest wins when both are present.
  // Retrieval failure is terminal: clear error, nothing written.
  app.post("/api/mypacks/install", async (req, res) => {
    if (!requireGate(req, res)) return;
    const { packId, version, manifest: bodyManifest } = req.body || {};
    let manifest = bodyManifest;
    // 装前闸（add-market-revenue-share）：市场面证词说「付费且未成交」的
    // 条目不得物化——闸与详情/购买状态同源（fetchMarketDetail）；价格为空
    // = 免费条目不拦；市场暂不可达时如实降级为既往行为（详情/购买两道
    // 写面在同台市场，不可用者自见，不虚构成交）。
    if (packId) {
      const viewer = req.user ?? (ctx.authEnabled ? null : { email: ctx.cellUserEmail || "owner@local", groups: [] });
      try {
        const detail = await fetchMarketDetail({ packId, viewer, localMarket: ctx.localPackMarket ?? null });
        if (detail?.pricing && !detail.purchased) {
          return res.status(402).json({
            error: "This pack is not in your purchases — buy it on the market first",
            code: "market-purchase-required",
          });
        }
      } catch (e) {
        if (e?.status === 404) {
          if (!bodyManifest) return res.status(404).json({ error: "Pack version not found" });
          // body-manifest rolling compat: market says the id does not exist —
          // the legacy manifest-in-body path unchanged (visibility is the
          // market's call at read time, install validation owns the rest).
        } else {
          console.warn(`[packs] install purchase gate degraded (${e?.message || e}); proceeding with legacy flow`);
        }
      }
    }
    try {
      if (!manifest) {
        if (!packId || version === undefined || version === null || !Number.isInteger(Number(version))) {
          return res.status(400).json({ error: "packId and version are required" });
        }
        manifest = await fetchMarketManifest({
          packId,
          version,
          // The caller's identity rides the retrieval: private-pack visibility
          // is evaluated for THIS user, exactly as the market listing does.
          // Auth off (dev/e2e machine owner) resolves to the same fallback
          // identity the in-process market mount uses.
          viewer: req.user ?? (ctx.authEnabled ? null : { email: ctx.cellUserEmail || "owner@local", groups: [] }),
          localMarket: ctx.localPackMarket ?? null,
        });
      }
      const { report, installed } = await packStore.installPack({
        packId,
        version,
        manifest,
        user: req.user,
        // add-packaged-skills D5: script-bearing packs need the explicit
        // acknowledgment; the error carries code "script-confirm-required"
        // which the client maps to the one-time confirm dialog.
        confirm: req.body?.confirm === true,
        hooks: {
          onMcpChanged: () => {
            broadcast({ type: "extensions_changed", resource: "mcp", action: "pack-install", name: manifest?.name || packId });
            ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined)
              .catch((e) => console.warn(`[packs] dsh MCP update failed: ${e.message}`));
          },
          onCatalogChanged: () => {
            broadcast({ type: "catalog_changed" });
            void ctx.syncCatalogAgentPresets?.();
          },
        },
      });
      // The pack's skills materialized under a per-pack root the skills patch
      // must list (full mode) — rewrite it; an idle runtime restarts so the
      // watched-dir set takes effect (add-pack-agent-scoping).
      await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[packs] skills patch update failed: ${e.message}`));
      res.json({ report, installed });
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
        ...(err.details ? { details: err.details } : {}),
      });
    }
  });

  app.get("/api/mypacks/:packId/uninstall-preview", (req, res) => {
    if (!requireGate(req, res)) return;
    respond(res, () => packStore.uninstallPreview(req.params.packId));
  });

  // Uninstall removes pack-owned skills and agent entries. A modified pack
  // skill forces an explicit ?force=1 (the server-side half of the warning
  // gate); MCP configurations are always kept.
  app.delete("/api/mypacks/:packId", async (req, res) => {
    if (!requireGate(req, res)) return;
    const force = req.query.force === "1" || req.query.force === "true";
    try {
      const result = packStore.uninstallPack({
        packId: req.params.packId,
        force,
        hooks: {
          onCatalogChanged: () => {
            broadcast({ type: "catalog_changed" });
            void ctx.syncCatalogAgentPresets?.();
          },
        },
      });
      // The pack root is gone: rewrite the skills patch so it stops listing
      // the dead root (full mode) — same rewrite/restart contract as install.
      await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[packs] skills patch update failed: ${e.message}`));
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message,
        ...(err.modifiedSkills ? { modifiedSkills: err.modifiedSkills } : {}),
      });
    }
  });
}
