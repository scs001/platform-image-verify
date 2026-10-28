// Blueprint studio routes (add-blueprint-studio Slice 1, tasks 1.2/3.1-3.3).
//
// 治包不治舰（design D1）：蓝图→集群模板→上架全链在此；活舰队的现场编排
// 归 agent-fleet-architect，本面不引开停写路径。Auth/identity semantics
// mirror fleets.js: auth-on reads the forward-auth user, auth-off the
// machine owner; every asset is scoped by owner_email — 他人资产答 404
// （存在性不外泄）。

import { Router } from "express";
import { facetRequest } from "../../gateway/facet-proxy.js";
import { getBlueprintDatabase } from "./blueprints-db.js";
import {
  validateBlueprint,
  dataSourceFindings,
  diffBlueprint,
  collectPackRefs,
  buildCastManifest,
} from "../blueprint-validate.js";
import { resolvePackReferences } from "../pack-manifest-source.js";

// Same factory semantics as fleets.js resolveUserFactory — 本地一份小拷贝，
// 与 routes 家族各面一致（fleets/clusters 同款）。
function resolveUserFactory(ctx) {
  return (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
}

function blueprintId() {
  return `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 发布客户端：与 facet-pack-builder/scripts/publish_pack.py 同一 proxy 通道
// （POST {FACET_BASE_URL}/api/packs，x-facet-token + x-facet-user）。铸造上架
// 只有这一道门（design D5）——本地不做 registry 直写回退，直写会绕过发布门
// 闸序（collectPublishVerdict 的工具面/商业集闸）。通道未配置答诚实 503。
function createFacetPublishClient({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    async publish({ manifest, packId, user }) {
      const base = (env.FACET_BASE_URL || "").replace(/\/+$/, "");
      if (!base) {
        return { ok: false, status: 503, error: "market publish channel is not configured (FACET_BASE_URL)" };
      }
      let upstream;
      try {
        upstream = await facetRequest({
          base,
          token: env.FACET_INTERNAL_TOKEN || "",
          user: user?.email ?? user,
          path: "/api/packs",
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify(packId ? { manifest, packId } : { manifest }),
          fetchImpl,
        });
      } catch (e) {
        return { ok: false, status: 502, error: `pack marketplace unreachable: ${e?.message || e}` };
      }
      const body = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return {
          ok: false,
          status: upstream.status,
          error: body?.error ?? `market publish failed (HTTP ${upstream.status})`,
          body,
        };
      }
      return { ok: true, packId: body?.id ?? body?.packId ?? packId ?? null, version: body?.version ?? null, body };
    },
  };
}

const defaultPackResolver = ({ refs, viewer }) => resolvePackReferences({ refs, viewer });

export function createBlueprintRoutes(app, ctx = null, { db = null, publishClient = null, packResolver = null } = {}) {
  const resolveUser = resolveUserFactory(ctx);
  const store = db ?? getBlueprintDatabase();
  const publisher = publishClient ?? createFacetPublishClient({});
  const resolveRefs = packResolver ?? defaultPackResolver;
  const router = Router();

  // Write-path access log (fleet-access 同款)：读面静默，写面留方法行。
  router.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      console.log(`[blueprint-access] ${req.method} ${req.baseUrl}${req.path} ${resolveUser(req)?.email ?? "anon"}`);
    }
    next();
  });

  const requireUser = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return user;
  };

  const requireOwnedBlueprint = (req, res) => {
    const user = requireUser(req, res);
    if (!user) return null;
    const blueprint = store.getBlueprint(req.params.id);
    // 404 而非 403：他人资产的存在性不外泄。
    if (!blueprint || blueprint.ownerEmail !== user.email) {
      res.status(404).json({ error: "Blueprint not found" });
      return null;
    }
    return { user, blueprint };
  };

  const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

  // ── 清单 / 详情 / 创建 / 编辑（task 1.2） ────────────────────────────────

  router.get("/", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    res.json({ blueprints: store.listBlueprints(user.email) });
  });

  router.post("/", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { name, oneLine, outOfScope, content } = req.body ?? {};
    if (!isPlainObject(content)) {
      return res.status(400).json({ error: "content must be a blueprint object (boundary/dataSources/fleet/agents/mcpServers/monitoring/acceptance/board)" });
    }
    const sceneName = name ?? content.boundary?.name ?? content.fleet?.name ?? "";
    if (typeof sceneName !== "string" || !sceneName.trim()) {
      return res.status(400).json({ error: "blueprint needs a scene name (name, boundary.name, or fleet.name)" });
    }
    let created;
    try {
      created = store.createBlueprint({
        id: blueprintId(),
        ownerEmail: user.email,
        name: sceneName.trim(),
        oneLine: oneLine ?? content.boundary?.oneLine ?? "",
        outOfScope: outOfScope ?? content.boundary?.outOfScope ?? "",
        content,
      });
    } catch (err) {
      if (err?.status === 422) return res.status(422).json({ error: err.message, findings: err.findings });
      throw err;
    }
    // shape 闸照报不阻：草稿可以是 WIP——非凭据类契约发现作警告随行；
    // 凭据类已在存储层硬拒，到不了这里。
    const warnings = dataSourceFindings(content);
    res.status(201).json({ blueprint: created, warnings });
  });

  router.get("/:id", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    res.json({ blueprint: owned.blueprint });
  });

  router.put("/:id", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    const { expectVersion, name, oneLine, outOfScope, content } = req.body ?? {};
    if (!Number.isInteger(expectVersion)) {
      return res.status(400).json({ error: "expectVersion (integer) is required" });
    }
    if (expectVersion !== owned.blueprint.version) {
      return res.status(409).json({ error: "version conflict — reload and re-apply your edit", currentVersion: owned.blueprint.version });
    }
    if (!isPlainObject(content)) {
      return res.status(400).json({ error: "content must be a blueprint object" });
    }
    // 归一化 diff 在编辑落定时刻计算（批准凭据同源——批准只盖戳不重算）。
    const diffSummary = JSON.stringify(diffBlueprint(owned.blueprint.content, content));
    let updated;
    try {
      updated = store.updateBlueprintContent(owned.blueprint.id, {
        name: name ?? content.boundary?.name ?? owned.blueprint.name,
        oneLine: oneLine ?? content.boundary?.oneLine ?? owned.blueprint.oneLine,
        outOfScope: outOfScope ?? content.boundary?.outOfScope ?? owned.blueprint.outOfScope,
        content,
        diffSummary,
      });
    } catch (err) {
      if (err?.status === 422) return res.status(422).json({ error: err.message, findings: err.findings });
      throw err;
    }
    res.json({ blueprint: updated, warnings: dataSourceFindings(content) });
  });

  // ── 全链校验（task 2.2 的服务端半） ─────────────────────────────────────

  router.post("/:id/validate", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    const verdict = validateBlueprint(owned.blueprint.content);
    res.json({ ok: verdict.ok, errors: verdict.errors, findings: verdict.findings, manifestPreview: verdict.manifestPreview });
  });

  // ── 批准闸（task 3.1）：显式批准 + 校验必全绿；批准凭据落铸造追溯 ───────

  router.post("/:id/approve", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    const { expectVersion } = req.body ?? {};
    if (!Number.isInteger(expectVersion)) {
      return res.status(400).json({ error: "expectVersion (integer) is required" });
    }
    if (expectVersion !== owned.blueprint.version) {
      return res.status(409).json({ error: "version conflict — reload before approving", currentVersion: owned.blueprint.version });
    }
    const verdict = validateBlueprint(owned.blueprint.content);
    if (!verdict.ok) {
      // 校验不过的批准短路（spec scenario）：指名未过项，铸造/上架不发生。
      return res.status(422).json({ error: "validation must be fully green before approval", errors: verdict.errors, findings: verdict.findings });
    }
    const approved = store.stampApproval(owned.blueprint.id, { by: owned.user.email, at: new Date().toISOString() });
    res.json({ blueprint: approved });
  });

  // ── 铸造与上架（tasks 3.2/3.3）：两段纪律 + 依赖占位补齐 + _casting ──────

  router.post("/:id/cast", async (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    const { user, blueprint } = owned;
    if (blueprint.status !== "approved") {
      return res.status(409).json({ error: `blueprint is '${blueprint.status}' — approval must come first` });
    }
    if (blueprint.approvedBy !== user.email) {
      return res.status(403).json({ error: "only the approver may cast this draft" });
    }
    // apply 重校验兜底（design D4）：对批准时的同一草稿重跑全套校验——版本
    // 纪律保证内容未漂（编辑即清批准），校验不过 = 库状态漂移，如实报错拒绝。
    const verdict = validateBlueprint(blueprint.content);
    if (!verdict.ok) {
      return res.status(422).json({ error: "draft no longer passes validation — re-approval required", errors: verdict.errors, findings: verdict.findings });
    }
    // 依赖占位 {{PACK_ID:<name>}} 经市场按名落实；解析不出 = 依赖漂移拒。
    const refs = collectPackRefs(blueprint.content);
    let resolved = {};
    if (refs.length) {
      try {
        resolved = (await resolveRefs({ refs, viewer: user.email })) ?? {};
      } catch (err) {
        return res.status(502).json({ error: `dependency resolution failed: ${err?.message || err}` });
      }
    }
    const { manifest, missing, selfPending } = buildCastManifest({
      content: blueprint.content,
      resolved,
      selfPackId: blueprint.castPackId,
      casting: {
        blueprintId: blueprint.id,
        version: blueprint.version,
        approvedBy: blueprint.approvedBy,
        approvedAt: blueprint.approvedAt,
        diffSummary: blueprint.diffSummary,
      },
    });
    if (missing.length) {
      return res.status(409).json({ error: `dependency pack references unresolved (drift): ${missing.join(", ")}`, missing });
    }
    const published = await publisher.publish({ manifest, packId: blueprint.castPackId ?? undefined, user });
    if (!published.ok) {
      return res.status(published.status ?? 502).json({ error: published.error, upstream: published.body ?? undefined });
    }
    const cast = store.stampCast(blueprint.id, { packId: published.packId, packVersion: published.version });
    res.json({ blueprint: cast, cast: { packId: published.packId, version: published.version, selfPending } });
  });

  // ── 试跑报告位（task 4.x 存储半；执行器随 Slice 3） ──────────────────────

  router.get("/:id/trial-report", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    res.json({ report: owned.blueprint.trialReport ?? null });
  });

  router.post("/:id/trial-report", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    if (owned.blueprint.status !== "cast") {
      return res.status(409).json({ error: "trial report requires a cast blueprint" });
    }
    if (!isPlainObject(req.body?.report)) {
      return res.status(400).json({ error: "report must be an object (assertions/evidence/first-round marks)" });
    }
    const updated = store.saveTrialReport(owned.blueprint.id, req.body.report);
    res.json({ blueprint: updated });
  });

  app.use("/api/blueprints", router);
}
