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
import { runTrial, createLiveTrialDeps } from "../blueprint-trial.js";
import { resolveJudgeLane } from "../blueprint-judge.js";

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
export function createFacetPublishClient({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    async publish({ manifest, packId, user }) {
      const base = (env.FACET_BASE_URL || "").replace(/\/+$/, "");
      if (!base) {
        return { ok: false, status: 503, error: "market publish channel is not configured (FACET_BASE_URL)" };
      }
      // facetForwardHeaders 的身份头是 base64url({email, groups})——必须传对象；
      // 传裸邮箱串会让 identity 解码出 undefined 邮箱、facet 判匿名 401
      // （2026-10-28 生产走查逮住）。
      const identity = typeof user === "string" ? { email: user, groups: [] } : { email: user?.email, groups: user?.groups ?? [] };
      if (!identity.email) {
        return { ok: false, status: 401, error: "cast needs a resolved caller identity (no email on the request user)" };
      }
      let upstream;
      try {
        upstream = await facetRequest({
          base,
          token: env.FACET_INTERNAL_TOKEN || "",
          user: identity,
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
    // 读一枚包（自愈认回用）：同名闸只回文本，认回前必须证明这枚同名包确实是
    // 本蓝图铸的（manifest._casting.blueprintId），否则会把别人的同名产品覆盖掉。
    async getPack({ packId, user }) {
      const base = (env.FACET_BASE_URL || "").replace(/\/+$/, "");
      if (!base || !packId) return null;
      const identity = typeof user === "string" ? { email: user, groups: [] } : { email: user?.email, groups: user?.groups ?? [] };
      try {
        const upstream = await facetRequest({
          base,
          token: env.FACET_INTERNAL_TOKEN || "",
          user: identity,
          path: `/api/packs/${encodeURIComponent(packId)}`,
          method: "GET",
          fetchImpl,
        });
        if (!upstream.ok) return null;
        return await upstream.json().catch(() => null);
      } catch {
        return null;
      }
    },
  };
}

const defaultPackResolver = ({ refs, viewer }) => resolvePackReferences({ refs, viewer });

export function createBlueprintRoutes(app, ctx = null, { db = null, publishClient = null, packResolver = null, trialDeps = null } = {}) {
  const resolveUser = resolveUserFactory(ctx);
  const store = db ?? getBlueprintDatabase();
  const publisher = publishClient ?? createFacetPublishClient({});
  const resolveRefs = packResolver ?? defaultPackResolver;
  const trial = trialDeps ?? createLiveTrialDeps();
  // 同一蓝图同时只跑一场试跑（进程内锁——试跑是重动作，重复触发只会烧额度）。
  const trialRunning = new Set();
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
    const raw = req.body ?? {};
    const content = raw.content;
    const { name, oneLine, outOfScope } = raw;
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

  // ── 评审模型解析探测（优化③）────────────────────────────────────────────
  //
  // 「跟随部署默认」原来对用户是个黑盒：界面只知道本 cell 的名册，而 cell 的
  // llm-providers.json 常为空（模型配置在网关/部署侧），于是下拉里的空选项
  // 解析成谁无从得知。这里如实报出**试跑时真正会用的那条车道**——与判据同一
  // 个解析函数（resolveJudgeLane），不另立第二套口径。
  // 必须在 /:id 之前注册，否则 'judge-default' 会被当成 id。
  router.get("/judge-default", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const resolved = resolveJudgeLane({ preferredModel: (req.query.for || "").trim() || null });
    if (!resolved) {
      return res.json({
        resolved: null,
        reason: "no judge lane is configured on this deployment (LLM route missing) — a trial with llm-judged assertions would report insufficient-evidence",
      });
    }
    res.json({
      resolved: { model: resolved.model, providerId: resolved.providerId ?? null, judgeSource: resolved.judgeSource ?? null },
      unavailable: resolved.unavailable === true,
      reason: resolved.unavailable ? resolved.reason : (resolved.fallbackReason ?? null),
    });
  });

  router.get("/:id", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    res.json({ blueprint: owned.blueprint });
  });
  router.put("/:id", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    const raw = req.body ?? {};
    const content = raw.content;
    const { expectVersion, name, oneLine, outOfScope } = raw;
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

  // ── 删除（构造间卫生）：从未铸造的草稿/已批准稿可删；已铸造的拒 ──────────

  router.delete("/:id", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    if (owned.blueprint.castPackId) {
      return res.status(409).json({
        error: "this blueprint was cast — the market pack is the record; archive or unpublish the pack instead of deleting the blueprint",
        castPackId: owned.blueprint.castPackId,
      });
    }
    store.deleteBlueprint(owned.blueprint.id);
    res.json({ ok: true, id: owned.blueprint.id });
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
    // 重新封印（add-blueprint-llm-assertions）：可售闸读的是 manifest 里的试跑报告，
    // 而试跑必须在铸造之后（先有包才能装台）——签完字若不重铸，市场里那份永远没有
    // 签字。故允许铸造态下再铸一版，条件是：草稿自批准后未改（version 未变）、
    // 批准人就是本人、且报告已由本人签过名。其余情形一律仍要求先批准。
    const reseal =
      blueprint.status === "cast" &&
      blueprint.approvedBy === user.email &&
      blueprint.trialReport?.signoff?.by === user.email &&
      blueprint.trialReport.signoff.reportRanAt === blueprint.trialReport.ranAt;
    // 前置闸的第二例外（2026-10-30 真机补刀）：reseal 只解锁「绿+签」那一半——而
    // 市场包 id 失效时，坏试跑会把旧报告**覆盖**成 errors=['trial aborted: Pack
    // version not found'] 且签字消失，此时 reseal 必不成立，cast 在门口就被 409 拦死，
    // 下面的 404→重建自愈根本轮不到跑——蓝图照样永久卡死。故：最新报告带着陈旧指针
    // 错误时，同样允许铸造态再铸（这正是修指针的入口），批准人本人纪律不变。
    const pointerStale =
      blueprint.status === "cast" &&
      Boolean(blueprint.castPackId) &&
      Array.isArray(blueprint.trialReport?.errors) &&
      blueprint.trialReport.errors.some((e) => /Pack (version )?not found/i.test(String(e)));
    if (blueprint.status !== "approved" && !reseal && !pointerStale) {
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
        // 可售闸读的就是这一份：绿 + 模型判决 + 主人签字（add-blueprint-llm-assertions）。
        trialReport: blueprint.trialReport ?? null,
      },
    });
    if (missing.length) {
      return res.status(409).json({ error: `dependency pack references unresolved (drift): ${missing.join(", ")}`, missing });
    }
    // 陈旧指针自愈（2026-10-30 生产实录）：市场的 packId 是每部署随机铸造的
    // （gateway/packs.js randomBytes），改名/重建流程换 id 后，蓝图记的旧 id 在
    // 市场里 404——此后试跑一律 `Pack version not found`，而「再铸」又要求先有
    // 绿色签字报告（只能由试跑产出）→ 死锁，蓝图永久卡死。故：以旧 id 发版被
    // 404 拒时，如实再发一枚新包并把指针改到新 id（不是静默换名，而是承认旧包
    // 已不存在、重新建这一份），cast 响应里 `rebuilt: true` 让调用方与台账可见。
    let published = await publisher.publish({ manifest, packId: blueprint.castPackId ?? undefined, user });
    let rebuilt = false;
    let reclaimedPackId = null;
    if (!published.ok && published.status === 404 && blueprint.castPackId) {
      published = await publisher.publish({ manifest, user });
      rebuilt = published.ok;
      // 第三刀（2026-10-30 真机实录）：重建被「同名包已存在」409 拒——旧 id 失效但
      // 本蓝图**自己的活包**仍占着名（改名/重建时新 id 早发出来了，只是指针没跟上）。
      // 盲发新包撞闸 → 指针仍卡死。正确自救=认回自己名下那枚同名活包并在其下发新版。
      // 认回必须证provenance：读那枚包的 manifest._casting.blueprintId 必须等于本蓝图，
      // 否则它是**别人的／另一款同名产品**（如官方种子占回本名），一律不碰、如实透传 409。
      if (!published.ok && published.status === 409 && typeof publisher.getPack === "function") {
        const hint = String(published.body?.packId ?? published.body?.error ?? published.error ?? "").match(/\b([A-Za-z0-9_-]{16,})\b/);
        const candidates = [...new Set([
          ...(published.body?.packId ? [published.body.packId] : []),
          ...(hint ? [hint[1]] : []),
        ])];
        for (const candidate of candidates) {
          const row = await publisher.getPack({ packId: candidate, user });
          const ownerBlueprint = row?.manifest?._casting?.blueprintId;
          const authorEmail = row?.authorEmail ?? row?.author_email ?? null;
          if (ownerBlueprint !== blueprint.id || (authorEmail && authorEmail !== user.email)) continue;
          const adopt = await publisher.publish({ manifest, packId: candidate, user });
          if (adopt.ok) {
            published = adopt;
            rebuilt = true;
            reclaimedPackId = candidate;
            break;
          }
        }
      }
    }
    if (!published.ok) {
      return res.status(published.status ?? 502).json({ error: published.error, upstream: published.body ?? undefined });
    }
    const cast = store.stampCast(blueprint.id, { packId: published.packId, packVersion: published.version });
    res.json({ blueprint: cast, cast: { packId: published.packId, version: published.version, selfPending, rebuilt, reclaimedPackId } });
  });

  // ── 试跑（task 4.1 执行器，design D8）：装一台跑一轮 → 断言判绿 → 报告落账 ──

  router.post("/:id/trial", async (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    if (owned.blueprint.status !== "cast") {
      return res.status(409).json({ error: "trial run requires a cast blueprint — cast before running the trial" });
    }
    if (trialRunning.has(owned.blueprint.id)) {
      return res.status(409).json({ error: "a trial run is already in progress for this blueprint" });
    }
    trialRunning.add(owned.blueprint.id);
    try {
      const report = await runTrial({ blueprint: owned.blueprint, deps: trial });
      const updated = store.saveTrialReport(owned.blueprint.id, report);
      res.json({ report, blueprint: updated });
    } catch (err) {
      res.status(500).json({ error: err?.message || "trial run failed" });
    } finally {
      trialRunning.delete(owned.blueprint.id);
    }
  });

  // ── 试跑签字（add-blueprint-llm-assertions D1 双钥匙：模型判绿是证据，
  // owner 签字是终审）。签字对象是整份报告；重跑覆盖报告后旧签字作废。 ──────

  router.post("/:id/trial-signoff", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    const report = owned.blueprint.trialReport;
    if (!report || !report.ranAt) {
      return res.status(409).json({ error: "no trial report to sign — run the trial first" });
    }
    const signed = store.saveTrialReport(owned.blueprint.id, {
      ...report,
      signoff: { by: owned.user.email, at: new Date().toISOString(), reportRanAt: report.ranAt },
    });
    res.json({ blueprint: signed, report: signed.trialReport });
  });

  router.delete("/:id/trial-signoff", (req, res) => {
    const owned = requireOwnedBlueprint(req, res);
    if (!owned) return;
    const report = owned.blueprint.trialReport;
    if (!report) return res.status(409).json({ error: "no trial report" });
    const { signoff: _drop, ...rest } = report;
    const cleared = store.saveTrialReport(owned.blueprint.id, rest);
    res.json({ blueprint: cleared, report: cleared.trialReport });
  });

  // ── 试跑报告位（task 4.x 存储半） ─────────────────────────────────────────

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
