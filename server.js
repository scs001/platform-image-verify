import 'dotenv/config';
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import multer from "multer";
import compression from "compression";
import * as chatHistory from "./chat-history.js";
import * as documents from "./documents.js";
import * as resources from "./resources.js";
import * as db from "./db.js";
import * as trace from "./server/trace.js";
import { startUsagePruneTimer } from "./server/usage-telemetry.js";
import * as bots from "./server/bots.js";
import { attachCronRunner } from "./server/cron-runner.js";
import * as migrate from "./migrate.js";
import * as cron from "./cron.js";
import * as extensionStore from "./extension-store.js";
import * as catalog from "./catalog.js";
import { initRegistryBridge, stopRegistryBridge } from "./registry-bridge.js";
import { resolveBundleSafe } from "./bundle-manifest.js";
import { createAppContext } from "./server/context.js";
import { registerAuth, normalizeAuthPath } from "./server/auth.js";
import { createLogtoAuth } from "./server/logto-auth.js";
import { resolveSessionSecret } from "./server/session.js";
import { createMpAuth } from "./gateway/mp-auth.js";
import { createAppAuth } from "./gateway/app-auth.js";
import { createMpBindings } from "./gateway/mp-bindings.js";
import { storeDir } from "./paths.js";
import { registerDocumentRoutes } from "./server/routes/documents.js";
import { registerMiscRoutes, registerStaticAndFallback } from "./server/routes/misc.js";
import { registerLlmRoutes } from "./server/routes/llm.js";
import { registerExtensionRoutes } from "./server/routes/extensions.js";
import { registerChatHistoryRoutes } from "./server/routes/chat-history.js";
import { registerTraceRoutes } from "./server/routes/trace.js";
import { registerUserBindingRoutes } from "./server/routes/user-bindings.js";
import { registerCronRoutes } from "./server/routes/cron.js";
import { registerTaskRoutes } from "./server/routes/tasks.js";
import { registerWanxingFleetRoutes } from "./server/routes/wanxing-fleet.js";
import { registerDelegationRoutes } from "./server/routes/delegation.js";
import { registerFleetArchitectRoutes } from "./server/fleet-architect.js";
import { attachDelegationAggregator } from "./server/delegation-aggregator.js";
import { attachWorkerPool } from "./server/worker-slots.js";
import { attachMcBridge } from "./server/mc-bridge.js";
import { registerMpRoutes } from "./server/routes/mp.js";
import { registerAppRoutes } from "./server/routes/app.js";
import { registerRegistryRoutes } from "./server/routes/registry.js";
import { registerConnectorRoutes } from "./server/routes/connector.js";
import { registerFacetMarketRoutes } from "./server/routes/facet-market.js";
import { registerLineCredentialRoutes } from "./server/routes/line-credentials.js";
import { registerChatwootCredentialRoutes } from "./server/routes/chatwoot-credentials.js";
import { registerDeskEmbedRoutes } from "./server/routes/desk-embed.js";
import { registerPaperTradingRoutes } from "./server/routes/paper-trading.js";
import { registerCiyuanAccountRoutes } from "./server/routes/ciyuan-account.js";
import { registerVoiceRoutes } from "./server/routes/voice.js";
import { registerPackUsageRoutes } from "./server/routes/pack-usage.js";
import { registerFileRoutes } from "./server/routes/files.js";
import { registerResourceRoutes } from "./server/routes/resources.js";
import { registerBotRoutes, WEBHOOK_PREFIX } from "./server/routes/bots.js";
import { registerBotRelayRoutes, RELAY_PREFIX } from "./server/routes/bot-relay.js";
import { createClusterRoutes, startAutoTerminationJob } from "./server/routes/clusters.js";
import { createFleetRoutes, resolveFleetTarget } from "./server/routes/fleets.js";
import { getFleetDatabase } from "./server/routes/fleets-db.js";
import { reconcileAllFleets, deriveMemberStatus } from "./server/fleet-reconcile.js";
import { buildFleetContext } from "./server/fleet-context.js";
import { derivedReportFromTask, fleetIdentityFor, fleetModelFor } from "./server/fleet-reports.js";
import { recordTurnEvent } from "./server/fleet-events.js";
import { outgoingHandoffs, outgoingFanouts, constraintsOf } from "./server/fleet-orchestration.js";
import { triggerFleetEventWake } from "./server/fleet-event-wake.js";
import * as engine from "./task-engine.js";
import { renderDecisionSegment } from "./server/fleet-decisions.js";
import { rosterPresetId } from "./dsh-profile.js";
import * as lineTokenRenewal from "./server/line-token-renewal.js";
import * as lineCredentialsLib from "./line-credentials.js";
import { createCredentialDelivery } from "./server/dsh-mcp-delivery.js";
import { createMonitoringRoutes } from "./server/routes/monitoring.js";
import { createAdminRoutes } from "./server/routes/admin.js";
import { registerExternalServiceRoutes } from "./server/routes/external-services.js";
import { registerPackRoutes as registerCellPackRoutes } from "./server/routes/packs.js";
import { registerOverlayRoutes } from "./server/routes/overlay.js";
import { registerCustomPresetRoutes } from "./server/routes/custom-presets.js";
import { createPackRegistry, registerPackRoutes as registerMarketPackRoutes } from "./gateway/packs.js";
import { attachDshEvents } from "./server/dsh-events.js";
import { attachRuntimeBindings } from "./server/runtime-bindings.js";
import { attachAgentSession, resolveBootWorkspace } from "./server/agent-session.js";
import { attachTurnDispatch } from "./server/turn-dispatch.js";
import { attachWebSocket } from "./server/ws.js";
import { matrixGate } from "./lib/dsh-matrix-verify.js";
import { registerActionsRoutes } from "./server/routes/actions.js";
import { startActionExpiryJob } from "./lib/action-expiry.js";
import { registerBoardRoutes } from "./server/routes/boards.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";
const MCP_CONFIG_PATH = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// ── Optional forward-auth (AUTH_MODE=forward_auth) ───────────────────────────
// Identity = proxy-injected X-Forwarded-Email / X-Forwarded-Groups headers
// (Caddy forward_auth → oauth2-proxy → Logto). TRUST BOUNDARY: enabling this
// asserts the server is reachable ONLY through the forward-auth proxy — bind
// to localhost / firewall it, otherwise these headers are attacker-controlled.

// ── Custom provider config (Volces / 火山引擎) ────────────────────────────────

// Volces (火山引擎) chat provider is optional: an unset LLM_API_KEY means the
// provider is not registered and the server starts with no chat provider (chat
// non-functional, logged) — the project's graceful-degrade convention.
// The document library no longer consumes any LLM provider config (local
// extraction only); LLM_API_KEY here feeds chat exclusively.

// Default chat model. When set, the dsh session starts on this model id;
// otherwise the first declared profile model is used. See initDshAgent().

// LiteLLM proxy removed — dsh-llm manages LLM natively via settings.yaml +
// .credentials.yaml hot-reload (no child process, no management-UI reverse
// proxy). The dsh LLM profile (dsh-profile.js writeLlmProfile, loaded from .env
// by dotenv/config above) now writes only the Volces route; chat falls back to
// the Volces gateway (when LLM_API_KEY is set) or starts with no chat provider
// (logged, graceful degrade).

// ── Bundle manifest (packaged component selection + pre-installed extensions) ─
// Resolved once at startup. In the packaged app platform.bundle.json sits next
// to this file (Resources/app/); in dev it is the repo root. resolveBundleSafe
// never throws — a corrupt manifest falls back to all-components defaults.
const bundle = resolveBundleSafe();

const app = express();
const server = http.createServer(app);
// noServer + manual handleUpgrade so WS upgrades pass the same forward-auth
// gate as HTTP requests (missing identity ⇒ handshake rejected with 401).
const wss = new WebSocketServer({ noServer: true });

// Shared application context: config + services + agent-session state.
// Every handler below reads/writes through ctx (see server/context.js).
const ctx = createAppContext({
  PORT,
  HOST,
  AUTH_MODE: process.env.AUTH_MODE || "none",
  SSO_ENABLED: process.env.SSO_ENABLED === "true",
  // Hosted-cell mode. Set by the cloud gateway's spawner, never by a human:
  // it turns on the active identity-trust gate in server/auth.js (see
  // CLOUD_MODE / CELL_GATEWAY_SECRET in .env.example).
  CLOUD_MODE: process.env.CLOUD_MODE === "1" || process.env.CLOUD_MODE === "true",
  CELL_GATEWAY_SECRET: process.env.CELL_GATEWAY_SECRET || "",
  // Accountless demo sandbox (openspec: mp-demo-sandbox): a dedicated
  // deployment-wide mode — every connection is demo-capped, uploads are
  // rejected and chat sessions are wiped periodically. Never set on the
  // account deployment.
  DEMO_SANDBOX: process.env.DEMO_SANDBOX === "true",
  DEMO_SANDBOX_WIPE_SECS: Number(process.env.DEMO_SANDBOX_WIPE_SECS || 7200),
  AUTH_LOGIN_PATH: normalizeAuthPath(process.env.AUTH_LOGIN_PATH, "/oauth2/start"),
  AUTH_LOGOUT_PATH: normalizeAuthPath(process.env.AUTH_LOGOUT_PATH, "/oauth2/sign_out"),
  PAAS_BASE_URL: process.env.PAAS_BASE_URL || "",
  LOGTO_ENDPOINT: process.env.LOGTO_ENDPOINT || "",
  LOGTO_APP_ID: process.env.LOGTO_APP_ID || "",
  LOGTO_APP_SECRET: process.env.LOGTO_APP_SECRET || "",
  LOGTO_CLIENT_TYPE: process.env.LOGTO_CLIENT_TYPE || "confidential",
  LOGTO_END_SESSION: process.env.LOGTO_END_SESSION || "false",
  SESSION_TTL_HRS: process.env.SESSION_TTL_HRS || "24",
  resolveSessionSecret: () => resolveSessionSecret({ env: process.env }),
  LLM_API_KEY: process.env.LLM_API_KEY?.trim(),
  LLM_BASE_URL: process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3",
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || "",
  bundle,
});
ctx.app = app;
ctx.server = server;
ctx.wss = wss;
ctx.upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Document collection: JSON bodies for text/url submissions; multipart file
// uploads are kept in memory (LlamaIndex readers read the buffer directly).
// Bot webhooks are excluded: they need the RAW request bytes (WeCom/WeChat send
// XML, and every platform signs the body exactly as sent), so they mount their
// own express.raw parser. Consuming the stream here would leave them with an
// empty body and break signature verification.
// The bot relay is excluded for a different reason: its bearer token must be
// verified before the payload is parsed, so it mounts its own JSON parser
// inside the route, behind that check.
// Pack surfaces (add-packaged-skills) get the raised parser: the in-process
// market's publish route, creator drafts carrying skill packages, and the
// install endpoint's rolling-window body-manifest shape all legitimately
// exceed the default 100kb.
const jsonBodyParser = express.json();
const packJsonBodyParser = express.json({ limit: "24mb" });
const PACK_BODY_PREFIXES = ["/api/packs", "/api/pack-drafts", "/api/mypacks"];
app.use((req, res, next) => {
  if (req.path.startsWith(WEBHOOK_PREFIX) || req.path.startsWith(RELAY_PREFIX)) return next();
  const parser = PACK_BODY_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + "/"))
    ? packJsonBodyParser
    : jsonBodyParser;
  parser(req, res, next);
});
// HTTP compression for static assets + API JSON (the entry chunk ships ~600KB
// raw). Must mount before express.static (registered in routes/misc.js).
app.use(compression());

// Forward-auth/Logto HTTP gate + ctx.requireAdmin (WS upgrade gate below).
// Mini-program identity (openspec: miniprogram-auth) — the same bind-code
// path the gateway serves, shared modules imported verbatim. Inert until
// MP_APPID/MP_SECRET/MP_TOKEN_SECRET are set: login endpoints report
// not-configured and Bearer tokens never verify, so browser flows are
// unchanged. Bindings persist in this deployment's data dir, same file
// format as the gateway's <CELL_DATA_ROOT>/mp-bindings.json.
ctx.mpBindings = createMpBindings({ file: path.join(storeDir("data"), "mp-bindings.json") });
await ctx.mpBindings.load();
ctx.mpAuth = createMpAuth({
  appid: process.env.MP_APPID || "",
  mpSecret: process.env.MP_SECRET || "",
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
  codeUrl: process.env.MP_JS_CODE_URL || "https://api.weixin.qq.com/sns/jscode2session",
  bindings: ctx.mpBindings,
  // Demo mode stays gateway-only even if MP_DEMO_MODE leaks into this env: a
  // single-process deployment has ONE shared runtime, so an anonymous demo
  // identity would land in the owner's data (openspec: mp-demo-mode —
  // self-hosted deployments never serve anonymous WeChat users).
  demoMode: false,
});
// App device pairing (openspec: add-device-pairing-auth) — the universal
// client's identity path, same shared module as the gateway. Shares the
// binding store, bind-code pool and token secret with the mini program; an
// app Bearer token verifies exactly like an MP token. Inert until
// MP_TOKEN_SECRET is set.
ctx.appAuth = createAppAuth({
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
  bindings: ctx.mpBindings,
});
ctx.logtoAuth = await createLogtoAuth(ctx);
ctx.logtoAuth?.register(app);
registerAuth(ctx);

// Route registration. Order is semantic: app /api routes first, then the
// static SPA + deep-link fallback and /external/:appId.
registerDocumentRoutes(ctx);
registerMiscRoutes(ctx);
registerLlmRoutes(ctx);
registerExtensionRoutes(ctx);
registerChatHistoryRoutes(ctx);
registerTraceRoutes(ctx);
registerUserBindingRoutes(ctx);
// Cron REST bridge (loopback MCP child; clients use the WS cron_* messages).
registerCronRoutes(ctx);
// Action gate routes (add-line-boards-and-action-gate): propose/approve/reject/query.
registerActionsRoutes(ctx);
// Action expiry sweeper (24h fail-closed, broadcast action_expired).
startActionExpiryJob(ctx);
// Board routes (add-line-boards-and-action-gate): GET /api/boards/:line.
registerBoardRoutes(ctx);
// Task stats lane (unify-wanxing-management-plane): read-only counts for the
// gateway's fleet relay; standard cell auth, no loopback exemption.
registerTaskRoutes(ctx);
// Desktop fleet console lane (add-desktop-fleet-console): local runner live
// snapshot + public registry catalog, both proxied behind standard cell auth.
registerWanxingFleetRoutes(ctx);
// Delegation REST bridge (loopback delegation MCP child; manual-trigger tasks).
registerDelegationRoutes(ctx);
registerFleetArchitectRoutes(ctx);
// Mini-program identity endpoints (bindcode mint / login / login-bindcode /
// unbind) — mounted with the other /api routes, before the static SPA fallback.
registerMpRoutes(ctx);
// App device-pairing endpoints (pair / challenge / login / devices / revoke).
registerAppRoutes(ctx);
registerRegistryRoutes(ctx);
registerPackUsageRoutes(ctx);
// 萬星 connector PAT (connector-credentials) — same route family as the
// registry credential endpoints.
registerConnectorRoutes(ctx);
// Dynamic cluster management (agent-cluster-platform): REST API for creating,
// managing, and operating dynamic agent clusters assembled from pack agents.
createClusterRoutes(app, ctx);
// Agent fleets (agent-fleet-core): fleet/post CRUD + materialization
// reconcile over the task engine. Same auth semantics as clusters.
createFleetRoutes(app, ctx);
// Cluster monitoring (agent-cluster-platform). The Phase 4/5/8/10 siblings
// this shipped with (model-binding provider routes, the hardcoded template
// "marketplace", the optimization endpoints with fabricated cache metrics)
// were removed 2026-10-21: zero consumers, fabricated data — the cluster
// market is pack cluster metadata (catalog.js), model binding is the deploy
// form's modelOverrides (gateway/packs.js).
createMonitoringRoutes(app);
// Admin dashboard (agent-cluster-platform Phase 8)
createAdminRoutes(app);
// 谦面市场设备凭据 (facet-market-credentials, C1.1-B) — same family again:
// pair-by-bind-code, silent relogin, injection via credentialRef.
registerFacetMarketRoutes(ctx);
// 各线操作 MCP 凭据 (line-credentials): wire-customer / lex (browser silent
// mint ID tokens) + wanxing-caller (pasted sk-) — same family.
registerLineCredentialRoutes(ctx);
// 商家 Chatwoot BYOK 凭据（add-crm-desk-pack-embed）：粘贴 token(+嵌入用登录对)。
registerChatwootCredentialRoutes(ctx);
// CRM 客服台嵌入反代（add-crm-desk-pack-embed 6.x）：go 铸发 + 同源代理。
registerDeskEmbedRoutes(ctx);
// 词元账号 (ciyuan-account-lane): zero-paste bind — server-side 词元 login →
// key mint → stored key; serves the cell model lane + the wanxing-caller ref.
registerCiyuanAccountRoutes(ctx);
// 语音车道 (voice-lane): ASR/TTS forwarded to the 词元 audio lane over the
// fixed OpenAI audio protocol; the key follows the model lane (user's bound
// 词元 key first, deployment key second) and never reaches the browser.
registerVoiceRoutes(ctx);
// 柏讯模拟交易 token (paper-trading-credentials) — fourth in the same family:
// paste an fdt_ token, advisory liveness probe, injection via credentialRef.
registerPaperTradingRoutes(ctx);
// The relay must register BEFORE the bots routes: POST /api/bots/relay/send
// would otherwise match POST /api/bots/:id/send with id = "relay", and the
// admin-gated handler there would answer a machine caller.
registerBotRelayRoutes(ctx);
registerBotRoutes(ctx);
// Preview drawer file serving — mounted with the other /api routes, BEFORE the
// static SPA fallback, so the catch-all cannot shadow /api/files.
registerFileRoutes(ctx);
// Resource library (charts + saved files) — same placement rule as /api/files.
registerResourceRoutes(ctx);
// Pack marketplace cell side (drafts + subscribe/upgrade/uninstall) — a plain
// /api route family, before the static fallback.
registerCellPackRoutes(ctx);
// Focus overlay (add-focus-overlay): the 资源微调 panel's GET/PUT — same
// placement rule as the pack routes.
registerOverlayRoutes(ctx);
// Custom presets (add-custom-presets): the 自建预设 roster CRUD — same
// placement rule; rides the serialized runtime-mutation path like packs.
registerCustomPresetRoutes(ctx);
// Pack marketplace MARKET plane (add-pack-marketplace): browse/publish/
// subscribe records. In the multi-cell gateway topology gateway/index.js
// serves these; a single-process deployment (fd-prod) has no gateway process,
// so the same module mounts here behind the feature flag — the mp-auth reuse
// pattern (gateway module imported verbatim). The auth gate above has already
// resolved req.user or answered 401 by the time these routes run; with auth
// off the requester is the machine owner (same semantics as requireAdmin and
// market visibility).
let packRegistry = null;
if (process.env.PACK_MARKETPLACE === "1") {
  packRegistry = createPackRegistry({ file: path.join(storeDir("data"), "packs.db") });
  registerMarketPackRoutes(app, {
    registry: packRegistry,
    resolveUser: (req) =>
      req.user ??
      (ctx.authEnabled
        ? null
        : // E2E_USER_GROUPS is a test seam (agent-service-config e2e): the
          // auth-off machine owner can carry groups so creator-gated real
          // routes (publish) are reachable. Empty by default — production
          // identity never comes from here.
          { email: ctx.cellUserEmail || "owner@local", groups: String(process.env.E2E_USER_GROUPS || "").split(",").map((s) => s.trim()).filter(Boolean) }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: (process.env.PACK_CREATOR_GROUPS || "creators")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
  // Manifest source for the cell-side install fetch when NO facet is
  // configured (pack-install-server-side-manifest): the market plane is
  // mounted in THIS process, so the install route resolves the version
  // through the registry's own visibility read — the same function the
  // /api/packs/:id/versions/:version route above serves. `admin: false` is
  // deliberate: this mount registers no admin group (the route above has the
  // same posture), so the fetch admits exactly who the listing admits. With
  // FACET_BASE_URL set (gateway topology) the install fetch goes to facet
  // over the shared proxy channel instead, and this injection stays unused.
  ctx.localPackMarket = {
    getVersion: (packId, version, viewer) =>
      packRegistry.getVersionVisible(packId, version, viewer, { admin: false }),
    // Latest-version lookup for server-driven installs (intent-onboarding): the
    // provisioning action names a pack from the recipe, not a version. Composed
    // from the same registry primitives the market detail route uses, so
    // visibility (private ⇒ owner/admin only) answers identically.
    getLatest: (packId, viewer) => {
      const row = packRegistry.packRowPublic?.(packId);
      if (!row) return null;
      const subscriber = Boolean(viewer?.email && packRegistry.subscription?.(viewer.email, packId));
      const visible = packRegistry.visibleTo?.(
        { visibility: row.visibility, author_email: row.author_email },
        viewer,
        { admin: false },
      );
      if (!visible && !subscriber) return null;
      const detail = packRegistry.get?.(packId, { includeUnlisted: subscriber });
      if (!detail?.version || !detail?.manifest) return null;
      return { version: detail.version, manifest: detail.manifest };
    },
    // Name lookup for curated recipe references (intent-onboarding): the
    // recipe names a pack by its authored display name because ids are minted
    // randomly per deployment. Goes through the registry's own listing, so the
    // viewer's visibility rules (private ⇒ owner only) answer exactly as the
    // market surface does.
    findByName: (name, viewer) => {
      const listed = packRegistry.list?.({ search: String(name), pageSize: 50, viewer })?.packs ?? [];
      return listed.filter((p) => p?.name === name).map((p) => ({ id: p.id, name: p.name }));
    },
  };
}
registerStaticAndFallback(ctx);
registerExternalServiceRoutes(ctx);

// dsh → WS event translation (attaches ctx.handleDshEvent + ctx.finishTurn).
attachDshEvents(ctx);
attachRuntimeBindings(ctx);
// Agent-session state machine (model/agent switching, session ops, commands).
attachAgentSession(ctx);
// Web-prompt arbiter (concurrent-chat-sessions): one open turn in the shared
// child at a time, queued otherwise. Must attach before the WS layer, which
// routes every prompt through ctx.dispatchTurn.
attachTurnDispatch(ctx);
// WebSocket upgrade gate + connection handler.
attachWebSocket(ctx);

// Dynamic cluster auto-termination (agent-cluster-platform)
startAutoTerminationJob(ctx);

// Demo sandbox only (openspec: mp-demo-sandbox): periodically wipe the shared
// conversation state so visitors never see each other's sessions. The timer
// never interrupts a streaming turn (wipeSandboxSessions skips while busy).
if (ctx.DEMO_SANDBOX) {
  const { wipeSandboxSessions } = await import("./server/sandbox.js");
  const everyMs = Math.max(60, ctx.DEMO_SANDBOX_WIPE_SECS) * 1000;
  const wipe = () =>
    wipeSandboxSessions({
      isStreaming: () => ctx.isStreaming,
      listSessions: () => chatHistory.listSessions(),
      deleteSession: (id) => chatHistory.deleteSession(id),
      startNewSession: () => ctx.startNewSession(),
      currentSessionId: () => chatHistory.currentSessionId(),
    })
      .then((r) => {
        if (r.wiped) console.log(`[sandbox] wiped ${r.wiped} session(s)${r.failed ? ` (${r.failed} failed)` : ""}`);
      })
      .catch((e) => console.warn(`[sandbox] session wipe failed: ${e.message}`));
  setInterval(wipe, everyMs).unref();
}

// ── Agent session ────────────────────────────────────────────────────────────

// Seed startup MCP configs into the extensions DB so the UI "Installed" tab
// shows them. INSERT OR IGNORE preserves user edits. Origins: mcp.json entries
// stay "user" (operator config); manifest mcpServers entries are pre-installed
// by the package ("bundled"). Manifest entries take
// locked/permissions from the permissions map ("mcp:<name>" → { allow, deny,
// locked }). Seeding lives here (not in bootstrap/first-run.js) because
// better-sqlite3 only loads under the Node that runs server.js — the Electron
// main process has a different ABI.
// ponytail: shared by the dsh bridge + extension REST routes (design D4 —
// host-side config sources unchanged); writeMcpPatch reads the DB but does not
// seed it, so the seeding must happen here before the patch is written.
function seedStartupMcpConfigs(mcpJsonServers) {
  if (!db.isDbReady()) return;
  for (const [name, config] of Object.entries(mcpJsonServers)) {
    extensionStore.seedMcpServer({ name, config, enabled: true });
  }
  for (const [name, entry] of Object.entries(ctx.bundle.mcpServers)) {
    const { enabled = true, ...config } = entry;
    // The bundle owns its rows' config (command/args/envRefs drift across
    // releases); seeding alone is skip-if-exists, so a changed bundle would
    // leave a stale row shadowing it forever. Sync bundled-origin configs on
    // startup while preserving the admin's enable/disable choice.
    const existing = extensionStore.getMcpServer(name);
    if (existing?.origin === "bundled" && JSON.stringify(existing.config) !== JSON.stringify(config)) {
      extensionStore.updateMcpServer(name, { config });
    }
    extensionStore.seedMcpServer({
      name,
      config,
      enabled,
      origin: "bundled",
      ...ctx.splitPolicy(ctx.bundle.permissions[`mcp:${name}`]),
    });
  }
}

// ── dsh runtime path ──────────────────────────────────────────────────────────
// Spawns the dsh subprocess via dsh-bridge.js and presents a minimal session
// shim to the WS handler/cron so the rest of server.js is runtime-agnostic.
// Task 2 fills handleDshEvent with the full dsh→WS event-translation map; for
// now it only emits `done` on turn completion (the 1.5 round-trip placeholder).
async function initDshAgent() {
  const { DshBridge } = await import("./dsh-bridge.js");
  const { writeLlmProfile, writeMcpPatch, writeSkillsPatch, writePresetsPatch, writePermissionsPatch, writeToolSearchPatch, writeChartBindPatch, writeUserQuestionsPatch, writeSaveLibraryPatch, ensureCredentialsStore, ensureDshHome, buildScrubbedEnv, knownPresetIds, DEFAULT_AGENT_PRESET, readPatchAuthorizations, authorizationHeadersChanged } = await import("./dsh-profile.js");

  // Scaffold $DSH_HOME if it is fresh — a hosted cell's per-user home always
  // is, and dsh refuses to boot a profile that was never materialized.
  ensureDshHome();

  // Hosted cells only: the spawner passes the cell's user, whose saved bindings
  // ARE this runtime's configuration. Empty in dev/desktop, where the shared
  // runtime keeps its global default and its overlay-apply path.
  const cellEmail = ctx.CLOUD_MODE ? String(process.env.CELL_USER_EMAIL || "") : "";
  const cellUser = cellEmail && db.isDbReady() ? cellEmail : "";

  // Write the dsh llm-adapter profile BEFORE spawning dsh so the runtime
  // loads the Volces routes at initialize. The generator's declared
  // list IS the dsh model list (no stock listModels RPC); server.js sources
  // the selector from it (Task 3.3). Empty list = dormant (Task 3.6).
  const { models } = await writeLlmProfile();
  ctx.dshModels = models;

  // Seed the dsh-credentials-local store from process.env (design D3) and build
  // a scrubbed child env so the file is the winning key-resolution layer.
  try { await ensureCredentialsStore({ cellOwnerEmail: cellEmail || null }); } catch (e) { console.warn(`[dsh] credentials store init failed: ${e?.message || e}`); }
  const dshChildEnv = buildScrubbedEnv();

  // Seed startup MCP configs into the extensions DB so the UI "Installed" tab
  // shows them (source=startup). writeMcpPatch reads mcp.json directly for the
  // runtime patch but does NOT seed the DB — seeding is UI-only (Task 4.1).
  let dshMcpJson = {};
  try { dshMcpJson = JSON.parse(await readFile(MCP_CONFIG_PATH, "utf8")).mcpServers || {}; } catch {}
  seedStartupMcpConfigs(dshMcpJson);

  // The selected agent mode is a persisted user preference (agent.preset);
  // `standard` until a DB row exists. Validate it BEFORE the child spawns AND
  // before any patch is written: dsh resolves a session's preset at creation
  // (and a vertical-pack agent IS one of these presets), so a stale id — a
  // pack that left the catalog, a preset someone deleted — would fail every
  // new session. The patch writers also derive the resource scope from this
  // preset (add-pack-agent-scoping): a pack persona composes focused with no
  // user action, so a crash-stale full patch cannot survive a restart. A
  // correction is persisted so the picker agrees with the runtime.
  const persistedPreset = ctx.db.getPreference("agent.preset") || DEFAULT_AGENT_PRESET;
  const knownPresets = knownPresetIds();
  ctx.currentPreset = knownPresets.has(persistedPreset)
    ? persistedPreset
    : knownPresets.has(DEFAULT_AGENT_PRESET)
      ? DEFAULT_AGENT_PRESET
      : [...knownPresets][0] || DEFAULT_AGENT_PRESET;
  if (ctx.currentPreset !== persistedPreset) {
    ctx.db.setPreference("agent.preset", ctx.currentPreset);
    console.warn(`[dsh] persisted agent preset '${persistedPreset}' is not available; using '${ctx.currentPreset}'`);
  }
  // A pack agent selection is a preset choice, so the switcher's agent label
  // follows the preset across restarts instead of resetting to `local`.
  ctx.currentAgentId = ctx.catalogAgentForPreset?.(ctx.currentPreset) ?? "local";

  // Write the dsh-mcp-client patch overlay (one loader entry per MCP server
  // from mcp.json + DB). The bridge passes it via --patch;
  // null = no servers configured, flag omitted (Task 4.1/4.2).
  // In a cell the user's saved MCP availability is THE availability (there is
  // no shared runtime for it to be an overlay on), so it is folded into the
  // boot patch rather than left to apply on some later request.
  const cellMcpOverlay = cellUser ? db.getUserMcpBindings(cellUser) : null;
  // Role filtering for the boot patch: the owner's latest observed groups
  // (per-request identity leaves no boot-time state; the snapshot persists
  // it). Missing snapshot (first boot) ⇒ null ⇒ no filtering.
  const cellOwnerGroups = cellUser ? (await import("./server/owner-groups.js")).readOwnerGroups()?.groups ?? null : null;
  // The owner the profile is generated FOR: a cell's single user, or nobody
  // (auth off / shared runtime), where the registry-credential lookup falls
  // back to the machine owner key.
  ctx.runtimeOwnerEmail = cellUser || null;
  ctx.runtimeOwnerGroups = cellOwnerGroups;
  // The effective availability the runtime composes with (truthful for the
  // preset-switch patch rewrite, which reproduces the boot profile).
  ctx.runtimeMcpOverlay = cellMcpOverlay || {};
  const mcpPatchPath = await writeMcpPatch({ mcpOverlay: cellMcpOverlay, userGroups: cellOwnerGroups, ownerEmail: ctx.runtimeOwnerEmail, agentPreset: ctx.currentPreset });

  // Write the skill-filesystem config override (customSkillDirs). The dir
  // list is the resource scope (add-pack-agent-scoping): the writer derives
  // it from the selected preset — focused lists the skills/ baseline plus the
  // pack root; full lists the user root plus every pack root. The
  // materialization dir is rebuilt from the DB first (design D2): DB skills
  // become <name>/SKILL.md files dsh-skill-filesystem Chokidar-watches, so
  // they hot-reload at runtime on CRUD (no restart). Pack rows land in their
  // per-pack root, which also migrates pre-scoping flat installs on this
  // boot (the DB is the durable store — no user action).
  try {
    const { rebuildFromDb, writeSkill } = await import("./skill-materialize.js");
    if (db.isDbReady()) {
      const { failures } = rebuildFromDb(extensionStore.listCustomSkills);
      // Reconciliation pass: retry rows that failed the first write once,
      // then drop still-dirty rows from the materialized set (the DB remains
      // the durable store; the next CRUD or restart re-attempts them).
      if (failures.length) {
        const rows = extensionStore.listCustomSkills().filter((s) => failures.includes(s.name));
        const stillDirty = [];
        for (const s of rows) {
          try { if (!writeSkill(s)) stillDirty.push(s.name); }
          catch (e) { stillDirty.push(s.name); console.warn(`[skills] retry failed for "${s.name}": ${e.message}`); }
        }
        if (stillDirty.length) console.warn(`[skills] materialization still dirty after retry: ${stillDirty.join(", ")}`);
      }
    }
  } catch (e) {
    console.warn(`[skills] materialization dir unavailable: ${e?.message || e}`);
  }
  const skillsPatchPath = await writeSkillsPatch({ agentPreset: ctx.currentPreset });

  // Write the preset-roster patch overlay (agent-presets roster + preset
  // bridge plugin). Null = unresolvable shipped preset root; the bridge then
  // spawns without the overlay and the picker stays empty (graceful degrade).
  const presetsPatchPath = await writePresetsPatch();
  // The permission-mode overlay swaps the bridge row to the subclass that
  // also serves permissions/list + permissions/set (add-permission-mode-
  // selector). Static; always written — an absent permission service inside
  // the child degrades to an empty roster (picker hidden, chat unaffected).
  const permissionsPatchPath = await writePermissionsPatch();
  // The tool-search overlay adds one read-only `tool_search` row
  // (add-tool-discovery-layer). Static; always written — its absence merely
  // removes the search tool, never breaks the runtime.
  const toolSearchPatchPath = writeToolSearchPatch();
  // The chart-bind overlay adds the read-only `chart_bind` row
  // (add-chart-data-binding). Static and always written — its absence merely
  // removes the declared channel, never the runtime.
  const chartBindPatchPath = writeChartBindPatch();
  // The user-questions overlay swaps the server row to the subclass that also
  // registers the ctx.userQuestions provider (add-user-questions, ADR-0012).
  // Static; always written — without it ask_user_question errors NO_PROVIDER.
  const userQuestionsPatchPath = writeUserQuestionsPatch();
  // The save-library overlay adds the `save_to_library` row
  // (add-save-to-library-tool). Static and always written — its absence merely
  // removes the model's explicit save channel, never the runtime.
  const saveLibraryPatchPath = writeSaveLibraryPatch();

  // Default model: in a cell the user's saved binding wins (it IS this
  // runtime's configuration); otherwise the persisted Models-page pointer,
  // else DEFAULT_MODEL env if declared, else the first declared model.
  let provider = "deepseek-official";
  let model = "deepseek-v4-flash";
  if (ctx.dshModels.length) {
    const llmProviders = await import("./llm-providers.js");
    const saved = llmProviders.getDefault();
    const bound = cellUser ? db.getUserModelBinding(cellUser) : null;
    const boundModel = bound && ctx.dshModels.find((m) => m.id === bound.id && m.provider === bound.provider);
    let pick =
      boundModel ||
      (saved.modelId && ctx.dshModels.find((m) => m.id === saved.modelId)) ||
      (ctx.DEFAULT_MODEL && ctx.dshModels.find((m) => m.id === ctx.DEFAULT_MODEL)) ||
      ctx.dshModels[0];
    // Default-lane guard (add-editable-llm-route, design D5): probe the
    // resolved default before the bridge bakes it into initialize — a dark
    // lane here is the 2026-10-01 outage class (every new session fails its
    // first turn after the re-anchor). Cell bindings are personal choices and
    // stay unguarded in v1 (the open question in the design); every other
    // resolution source passes through. Bounded 10s; inconclusive probes keep
    // the configured default.
    if (!boundModel) {
      try {
        const { guardDefaultLane } = await import("./server/llm-guard.js");
        const guardOutcome = await guardDefaultLane(
          {
            dshModels: ctx.dshModels,
            defaultModel: { id: pick.id, provider: pick.provider, name: pick.name },
            broadcast: () => {},
          },
          { reason: "boot" }
        );
        if (guardOutcome.action === "fell_back") {
          pick = ctx.dshModels.find((m) => m.id === guardOutcome.to) || pick;
        }
      } catch (err) {
        console.warn(`[llm-guard] boot probe skipped: ${err.message}`);
      }
    }
    provider = pick.provider;
    model = pick.id;
    if (boundModel) console.log(`[dsh] cell binding: starting on ${provider}/${model}`);
    // Restore the persisted thinking level, but only if this model still
    // declares it (writeLlmProfile already projected it into settings.yaml).
    const savedEffort = ctx.db.getPreference(`llm.effort.${provider}`) || null;
    ctx.currentEffort = savedEffort && (pick.reasoningEfforts || []).includes(savedEffort) ? savedEffort : null;
  } else {
    console.warn("[dsh] no LLM keys configured; chat non-functional (static + REST still served)");
  }

  ctx.dshSessionId = "platform-" + randomUUID();
  // Boot workspace (fix-agent-workspace): AGENT_WORKSPACE pin > persisted
  // current > process.cwd(). fd-prod's /app is root-owned and unwritable —
  // without a pin or a persisted switch every boot lands there and produced
  // files become unservable (/api/files and the resource save both key off
  // the runtime cwd). Rejections log loudly with the fallback actually used.
  const bootWorkspace = await resolveBootWorkspace({
    env: process.env,
    getPreference: db.isDbReady() ? (k) => db.getPreference(k) : null,
  });
  for (const r of bootWorkspace.rejected) console.warn(`[workspace] ${r}; falling back`);
  console.log(`[workspace] boot workspace: ${bootWorkspace.path} (source=${bootWorkspace.source})`);
  ctx.dshBridge = new DshBridge({
    provider,
    model,
    cwd: bootWorkspace.path,
    onEvent: ctx.handleDshEvent,
    mcpPatchPath,
    skillsPatchPath,
    presetsPatchPath,
    permissionsPatchPath,
    toolSearchPatchPath,
    chartBindPatchPath,
    userQuestionsPatchPath,
    saveLibraryPatchPath,
    agentPreset: ctx.currentPreset,
    env: dshChildEnv,
  });
  // Worker-slot spawn inputs (worker-pool): workers are this exact construction
  // with a different agentPreset and a worker-local event pump (design D1).
  ctx.workerSpawnParams = {
    provider,
    model,
    cwd: bootWorkspace.path,
    mcpPatchPath,
    skillsPatchPath,
    presetsPatchPath,
    permissionsPatchPath,
    toolSearchPatchPath,
    chartBindPatchPath,
    userQuestionsPatchPath,
    saveLibraryPatchPath,
    env: dshChildEnv,
  };
  await ctx.dshBridge.start();
  // Warm the preset roster cache so the ready sync can answer list_presets
  // without a second bridge round-trip (best-effort: empty roster on failure).
  await ctx.getAgentPresets();
  // Same for the permission roster — the connect-time current_permission push
  // needs nothing, but the first list_permissions answer is then immediate.
  ctx.getPermissionPresets().catch(() => {});
  // MCP live-reload (design D1): the REST routes mutate the DB then call this to
  // rewrite mcp.patch.yml in place — cordis-plugin-include/hmr watches that file
  // (confirmed by source inspection; see design Open Question 1) and hot-swaps
  // dsh-mcp-client (disconnect/reconnect the affected server, no process restart).
  // Single-flight mutex + debounce serialize overlapping mutations; restart() is
  // the documented fallback (PLATFORM_MCP_HOTSWAP=0, or hot-swap never settles).
  const hotswapEnabled = process.env.PLATFORM_MCP_HOTSWAP !== "0";
  const HOTSWAP_SETTLE_MS = Number(process.env.PLATFORM_MCP_HOTSWAP_SETTLE_MS || 800);
  // Deterministic credential delivery (add-line-credential-renewal D5, hardened
  // after the fleet-cell incident 2026-10-24 13:46): a renewed credential
  // landing mid-turn must not abort the streaming round, and a restart that
  // collides with one already in flight must RETRY — the incident lost the
  // delivery to a swallowed "dsh restart already in progress" and the child
  // served an expired token until the platform restarted. The controller owns
  // the decision (now / defer to the turn boundary / force past a cap) and
  // logs every branch; the drain hook is exposed for turn boundaries.
  const credentialDelivery = createCredentialDelivery({
    isStreaming: () => Boolean(ctx.isStreaming),
    restart: ({ mcpPatchPath }) => ctx.dshBridge.restart({ mcpPatchPath }),
  });
  ctx.drainDeferredCredentialRestart = () => credentialDelivery.drainIfIdle();
  ctx.dshUpdateMcp = (mcpOverlay, userGroups = null, ownerEmail = undefined) => {
    const update = async () => {
      // ownerEmail undefined = "keep whoever the runtime last served" (global
      // routes that do not act for a specific identity); explicit null = the
      // machine owner (auth off).
      if (ownerEmail !== undefined) ctx.runtimeOwnerEmail = ownerEmail;
      // Credential delivery (add-line-credential-renewal D5): snapshot the
      // Authorization headers the running child was spawned against BEFORE the
      // rewrite — the post-write diff separates "credential VALUE changed"
      // (restart: HMR does not deliver header-value changes, production
      // 2026-10-24) from "server SET changed" (HMR keeps working as before).
      const prevPatchPath = ctx.dshBridge?.getMcpPatch?.() ?? null;
      const prevAuth = prevPatchPath ? readPatchAuthorizations(prevPatchPath) : null;
      // The scope filter rides inside the writer keyed off the live preset,
      // so CRUD while focused (add/disable a server, a pack upgrade adding an
      // MCP ref) rewrites the patch focused — the focus survives every
      // mutation without extra bookkeeping (add-pack-agent-scoping D1).
      const patchPath = await writeMcpPatch({ mcpOverlay, userGroups, ownerEmail: ctx.runtimeOwnerEmail, agentPreset: ctx.currentPreset });
      const credentialChanged = Boolean(
        prevAuth && patchPath && authorizationHeadersChanged(prevAuth, readPatchAuthorizations(patchPath)),
      );
      // HMR only reaches the child if it was spawned WITH this --patch (cordis
      // watches the file it loaded). A child booted before the first MCP server
      // existed has no mcp patch on its command line — rewriting the file does
      // nothing it can see, so that case must fall through to the restart path.
      if (hotswapEnabled && patchPath && !credentialChanged && ctx.dshBridge.getMcpPatch() === patchPath) {
        // The patch file was rewritten atomically (temp+rename inside
        // writeMcpPatch); cordis' Chokidar watcher fires refresh() → dsh-mcp-client
        // hot-swaps. No RPC confirms the swap, so settle on a fixed delay — dsh's
        // own debounce is ~100ms; the server-side settle covers reconnect + initial
        // tools/list. ponytail: no confirmation signal exists in the dsh SDK
        // protocol; a settle delay is the simplest bound that lets "applying…" clear.
        await new Promise((r) => setTimeout(r, HOTSWAP_SETTLE_MS));
        return;
      }
      if (patchPath !== undefined) {
        if (credentialChanged) {
          // Credential VALUE changed: the delivery controller decides — restart
          // now when idle, defer to the turn boundary when a round is streaming
          // (with a hard cap so a wedged stream cannot hold the credential
          // hostage). Never a bare fire-and-forget restart.
          await credentialDelivery.onCredentialChange(patchPath);
          return;
        }
        // Snapshot-incomparable fallback (fix-wire-install-gate D2): no
        // previous patch to diff against (first patch on a child booted
        // before any server existed — e.g. the user's FIRST credential row)
        // means the diff could not rule a credential change out. Deliver
        // through the controller like every credential-shaped change: a bare
        // restart here collides with an in-flight restart and the collision
        // is swallowed by reapplyProfile's catch — production 2026-10-24,
        // twice, fixed only by a platform restart.
        if (!prevAuth) {
          await credentialDelivery.onCredentialChange(patchPath);
          return;
        }
        // Fallback: hot-swap disabled or no servers (empty patch). Restart re-spawns
        // the child with the new --patch; dsh persists sessions by id so the
        // conversation resumes from disk. Serialized behind mcpChain, so concurrent
        // mutations can't overlap-corrupt the restart.
        await ctx.dshBridge.restart({ mcpPatchPath: patchPath });
      }
    };
    // Profile application already owns the mutation lock. Running directly here
    // avoids queuing an MCP update behind itself while preserving one chain for
    // ordinary global and personal mutations.
    if (ctx.runtimeApplying?.()) return update();
    const run = ctx.runtimeMutationChain.then(update);
    ctx.runtimeMutationChain = run.then(() => {}, () => {});
    return run;
  };
  // ── Line credential renewal (add-line-credential-renewal D2/D3 wiring) ─────
  // The module owns the refresh grant; this is the only wiring point. Every
  // renewed credential re-applies the effective profile for its owner — the
  // Authorization diff above turns that into a deterministic restart (idle) or
  // a deferred one (mid-turn), so the next round runs on the fresh token with
  // no platform restart and no HMR trust anywhere in the unattended path.
  const reapplyRenewedCredential = (email) =>
    ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, ctx.runtimeOwnerGroups ?? null, email);
  ctx.renewLineCredentialsForTurn = () =>
    lineTokenRenewal.renewDueCredentials({
      email: ctx.cellUserEmail || ctx.runtimeOwnerEmail || null,
      onRenewed: reapplyRenewedCredential,
    });
  lineCredentialsLib.setRefreshAttempt((opts) =>
    lineTokenRenewal.renewLineCredential({ ...opts, onRenewed: reapplyRenewedCredential }).then((r) => r.renewed),
  );
  lineTokenRenewal.startRenewalSweep({ onRenewed: reapplyRenewedCredential });
  // Skills-patch rewrite for pack install/uninstall (add-pack-agent-scoping):
  // a NEW or REMOVED pack root changes the watched-dir set (full mode lists
  // every pack root), and dir-set changes through the skills patch are
  // unverified dsh HMR behavior — so the rewrite rides a restart while the
  // runtime is idle (the same contract syncCatalogAgentPresets applies). A
  // focused runtime re-derives and keeps its own pack's root. Content changes
  // inside an already-listed root (an upgrade) stay on plain Chokidar
  // hot-reload; the idempotent rewrite costs nothing extra.
  ctx.dshUpdateSkills = async () => {
    const run = async () => {
      await writeSkillsPatch({ agentPreset: ctx.currentPreset });
      if (ctx.dshBridge?.isReady?.() && !ctx.isStreaming) {
        await ctx.dshBridge.restart({});
      }
    };
    if (ctx.runtimeApplying?.()) return run();
    if (ctx.runExclusiveRuntimeMutation) return ctx.runExclusiveRuntimeMutation(run);
    return run();
  };
  // Session shim: dsh prompt resolves immediately with the message id; the
  // turn plays out as notifications. isStreaming is set here synchronously
  // (host-side streaming guard) so a concurrent prompt observes it.
  // model.id mirrors the broadcast shape (unprefixed id) so current_model on
  // connect matches what the selector sends (Task 3.4).
  // ponytail: dsh has no SessionManager; expose the minimum shape chat-history
  // needs (getSessionId/currentSessionId + no-op buildSessionContext) so the
  // sidebar reflects the live dsh session as current. recordMessage still
  // mirrors to SQLite; getSessionFile returns null (no JSONL under dsh).
  const dshSm = {
    getSessionId: () => ctx.dshSessionId,
    getSessionFile: () => null,
    buildSessionContext: () => ({ messages: [] }),
    newSession: () => { ctx.dshSessionId = "platform-" + randomUUID(); },
    setSessionId: (id) => { ctx.dshSessionId = id; },
    setSessionFile: () => {},
  };
chatHistory.setSessionManager(dshSm);
chatHistory.setDshBridge(ctx.dshBridge);
// Delete guard extension (concurrent-chat-sessions D7): a session with a turn
// in flight ANYWHERE, or a queued prompt, is undeletable — not just the
// session the global pointer happens to name.
chatHistory.setActivityProbe((id) => ({
  streaming: ctx.isStreamingFor?.(id) === true,
  queued: ctx.isQueuedFor?.(id) === true,
}));
  // Session rows record the preset selected when their first message lands,
  // so a resumed session's header label names the mode it started under.
  chatHistory.setPresetSource(() => ctx.currentPreset);
  // …and the runtime workspace they ran in, so the sidebar groups sessions
  // by workspace. Stamped once per session; later switches never re-group.
  chatHistory.setWorkspaceSource(() => ctx.listWorkspaces?.().current ?? null);
  ctx.session = {
    // `sid` is explicit (concurrent-chat-sessions D6): the dispatcher's run
    // closure resolves the target BEFORE any await, so a session switch while
    // doc refs expand can never re-attribute the turn to another session.
    prompt: async (text, sid = chatHistory.currentSessionId()) => {
      ctx.setStreaming(sid, true);
      const messageId = await ctx.dshBridge.prompt(sid, [{ type: "text", text }]);
      // Trace: the durable message id keys this turn's trace rows.
      ctx.turnStateFor(sid).currentTurnId = messageId;
      trace.bindTurn(messageId);
    },
    model: { id: model, provider },
    sessionManager: dshSm,
  };
  ctx.defaultModel = { id: model, provider, name: model };
  ctx.runtimeModel = { id: model, provider, name: model };
  // The boot-selected default (user binding → Models-page pointer →
  // DEFAULT_MODEL → first declared model, dark-lane guarded) is the stable
  // tail of the fleet post-model resolution chain (add-fleet-post-model).
  // Kept separately because defaultModel/runtimeModel are overwritten by every
  // runtime switch — the chain's "cell default" must not ride that drift.
  ctx.bootModel = { id: model, provider };
  console.log(`[dsh] runtime ready (provider=${provider} model=${model})`);
}



// ── dsh install-matrix boot gate (add-dsh-matrix-lock, ADR-0007) ─────────────
// Runs BEFORE the port binds: a deployment whose installed dsh tree deviates
// from the frozen matrix (dsh-matrix/package-lock.json) fails AT STARTUP with
// a package-level diff, instead of mid-session with ERR_MODULE_NOT_FOUND. No
// install root present (dev machines, e2e scratch homes) skips silently;
// DSH_MATRIX_OVERRIDE=1 boots anyway with the report kept in the log.
{
  const matrixLock = process.env.DSH_MATRIX_LOCK
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "dsh-matrix/package-lock.json");
  const matrixRoot = process.env.DSH_MATRIX_INSTALL_ROOT || "/opt/dsh";
  const gate = matrixGate({ lockPath: matrixLock, installRoot: matrixRoot });
  if (gate.action === "fail") {
    console.error(gate.diff.report);
    console.error(`[dsh-matrix] refusing to start — installed tree deviates from the frozen matrix (DSH_MATRIX_OVERRIDE=1 to force)`);
    process.exit(1);
  } else if (gate.action === "override") {
    console.warn(`[dsh-matrix] DSH_MATRIX_OVERRIDE is set — booting despite deviations:`);
    console.warn(gate.diff.report);
  } else if (gate.action === "skip") {
    console.log(`[dsh-matrix] no install root at ${matrixRoot} — skipping dsh tree verification`);
  } else {
    console.log(`[dsh-matrix] install tree matches frozen matrix (${matrixRoot})`);
  }
}

// ── Start (listen-first) ─────────────────────────────────────────────────────
// The port listens IMMEDIATELY: static assets, /api/ready and non-agent
// endpoints answer while background init proceeds. Agent-dependent features
// (WS chat commands, /api/llm/*) answer an explicit initializing error until
// ctx.ready.dsh flips, then connected clients get the ready sync payload.
//
// BOOT INVARIANTS (deliberate ordering — see optimize-hot-paths design D1):
//   1. initChatHistory resolves the sessions store dir BEFORE initDshAgent
//      (the session shim reads it).
//   2. db.initDb opens BEFORE documents.initStore AND BEFORE
//      runLegacyMigrations.
//   3. documents.initStore and initDshAgent run CONCURRENTLY after (2) —
//      they share no state — but BOTH complete BEFORE migrate.
//   4. documents.initStore's restart reconciliation still runs BEFORE
//      migrate's legacy import (same relative order as the sequential boot).
//   5. migrate, catalog.initCatalog and cron.initCron run concurrently after
//      the dsh agent is ready (none can be prompted before then).
server.listen(PORT, HOST, () => {
  console.log(`Platform listening at http://${HOST}:${PORT} (agent init in background)`);
});

await chatHistory.initChatHistory();
// Open the SQLite project database (chat, documents, index, preferences) before
// feature init. Degrades gracefully: if it cannot open, dbReady stays false and
// the server continues (chat in-memory, documents disabled).
await db.initDb();

// Documents (local-extraction library) and the dsh agent both depend only on
// the db being open — run them concurrently.
const documentsInit = (async () => {
  if (!db.isDbReady()) return;
  await documents.initStore({ broadcast: ctx.broadcast });
})();
// Degrade, don't die: a failed agent init (e.g. the dsh binary missing in a
// packaged install) must not take down the listen-first server — static,
// auth, REST, and documents keep serving, and the status panel shows the
// runtime as not-ready with the init error (win-install-smoke 2026-10-08:
// `await Promise.all` used to crash the whole process on spawn dsh ENOENT).
// dshReadyOk gates the readiness flip below: the catch swallows the error so
// boot continues, but /api/ready must stay 503 for a degraded agent — an
// unconditional flip reported a dead runtime as ready (the deploy probes and
// win-install-smoke Phase B both key off that 200).
let dshReadyOk = false;
const dshInit = initDshAgent()
  .then(() => { dshReadyOk = true; })
  .catch((err) => {
    ctx.dshInitError = err?.message || String(err);
    console.error(`[dsh] agent init failed — server continues without the agent runtime: ${ctx.dshInitError}`);
  });
await Promise.all([documentsInit, dshInit]);
await trace.initTrace();
startUsagePruneTimer();

// Agent is live: flip readiness and sync any client that connected mid-boot.
// Only flipped when initDshAgent resolved — a degraded agent stays 503 and
// the chat surfaces report the runtime as unavailable.
if (dshReadyOk) {
  ctx.ready.dsh = true;
  ctx.onDshReady?.();
}

// Chat-platform bots. Starts after the bridge so a polled message never
// arrives before there is an agent to answer it; inert with no bots configured.
bots.initBots(ctx);

// Cron turn executor: mounted before cron.initCron loads jobs, so a restored
// job that comes due immediately finds its runner attached.
attachCronRunner(ctx);

// Fleet post identity (enable-wire-content-fleet D2): the runner asks which
// post a persona is on duty for and prefixes its turn with the one-line
// identity. Same attribution the report lane uses; a persona holding no post,
// or several (ambiguous), yields null so the turn runs unchanged. Cluster
// posts are out of scope — the fan-out picks the member after this seam runs.
ctx.resolveFleetIdentity = (presetId) => fleetIdentityFor(getFleetDatabase(), presetId, { rosterPresetId });

// Fleet post model (add-fleet-post-model D3): the persona turn path asks for
// this post's resolution plan (chain candidates + notices) right before the
// model normalization switch. Same attribution seam as the identity above;
// roster comes from the live model list, the chain tail from the boot default.
ctx.resolveFleetModel = async (presetId) => {
  try {
    let roster = null;
    if (typeof ctx.getAvailableModels === "function") {
      const models = await ctx.getAvailableModels();
      roster = Array.isArray(models) ? models.map((m) => m.id) : null;
    }
    return fleetModelFor(getFleetDatabase(), presetId, {
      rosterPresetId,
      roster,
      cellDefault: ctx.bootModel?.id ?? null,
    });
  } catch (e) {
    console.warn(`[fleets] post model resolution failed: ${e?.message || e}`);
    return null;
  }
};

// Fallback notices bridge (add-fleet-post-model D7): a persona turn records
// its selection-time fallback facts under the memberId; a report filed during
// that same turn picks them up as blockers (one-shot). Turns serialize on the
// shared runtime, so one entry per member is turn-accurate; a member that
// never reports leaves its notices in the log only — by design.
const fleetModelNotices = new Map();
ctx.recordFleetModelNotices = (memberId, notices) => {
  if (!memberId) return;
  if (Array.isArray(notices) && notices.length) fleetModelNotices.set(memberId, notices);
  else fleetModelNotices.delete(memberId);
};
ctx.takeFleetModelNotices = (memberId) => {
  const notices = fleetModelNotices.get(memberId) ?? [];
  fleetModelNotices.delete(memberId);
  return notices;
};

// Turn result events (add-fleet-turn-events D1/D2): the cron-runner seam calls
// this after every member turn; recordTurnEvent resolves attribution
// (sourceTag → origin.fleet → persona scan) and appends the event, returning
// null for non-fleet turns. Degrade open here too — the warn is the whole
// blast radius.
ctx.recordFleetTurnEvent = (job, outcome, meta) => {
  try {
    return recordTurnEvent(getFleetDatabase(), job, outcome, { ...meta, rosterPresetId });
  } catch (e) {
    console.warn(`[fleets] turn event record failed: ${e?.message || e}`);
    return null;
  }
};

// Event wake (add-fleet-event-wake): bots.js calls this after its inbound
// guards; optional-chained there, so its absence degrades to nothing.
ctx.triggerFleetEventWake = (botId, meta) => {
  try {
    return triggerFleetEventWake({ db: getFleetDatabase(), engine, roster: rosterPresetId }, botId, meta);
  } catch (e) {
    console.warn(`[fleets] event wake failed for bot ${botId}: ${e?.message || e}`);
    return [];
  }
};

// Handoff edges (agent-fleet-orchestration D4): the turn seam calls this
// after the outcome event. Upstream completion — ok or failed, both honestly
// relayed — creates one manual turn per declared outgoing edge, depth read
// from the chain position in origin.fleet. Over-bound hops create nothing
// but leave an honest event row. Cluster posts have no manual lane: skipped,
// their next cadence/delegation turn carries the work.
ctx.triggerFleetHandoffs = async (job, out) => {
  try {
    const db = getFleetDatabase();
    let fleetId = null;
    let memberId = null;
    let chainDepth = 0;
    if (job?.origin?.fleet?.fleetId) {
      fleetId = job.origin.fleet.fleetId;
      memberId = job.origin.fleet.memberId ?? null;
      chainDepth = Number.isFinite(job.origin.fleet.depth) ? job.origin.fleet.depth : 0;
    } else if (job?.sourceTag?.fleetId) {
      fleetId = job.sourceTag.fleetId;
      memberId = job.sourceTag.memberId ?? null;
    }
    if (!fleetId || !memberId) return null;
    const fleet = db.getFleet(fleetId);
    if (!fleet?.orchestration) return null;
    const edges = outgoingHandoffs(fleet.orchestration, memberId);
    if (!edges.length) return null;
    const constraints = constraintsOf(fleet.orchestration);
    const nextDepth = chainDepth + 1;
    const now = Date.now();
    const dispatched = [];
    for (const e of edges) {
      const target = db.getMember(e.to);
      if (!target || target.fleetId !== fleetId) continue;
      if (target.targetKind === "cluster") continue;
      if (nextDepth > constraints.maxChainDepth) {
        db.appendTurnEvent({
          fleetId,
          memberId: target.id,
          source: "manual",
          status: "failed",
          errorKind: "other",
          error: `handoff depth bound reached (${nextDepth} > ${constraints.maxChainDepth}) — chain stopped before this hop`,
          startedAt: now,
          endedAt: now,
          sessionId: null,
        });
        continue;
      }
      // Tool hops are deterministic: the edge carries their JSON args (edge.
      // args); prose summaries are not executable arguments and fail honestly.
      if (target.targetKind === "tool") {
        const argsOk = e.args != null && typeof e.args === "object" && !Array.isArray(e.args);
        if (!argsOk) {
          db.appendTurnEvent({
            fleetId,
            memberId: target.id,
            source: "manual",
            status: "failed",
            errorKind: "runtime_not_ready",
            error: "handoff to a tool post needs the edge's `args` (JSON object) — upstream prose is not executable",
            startedAt: now,
            endedAt: now,
            sessionId: null,
          });
          continue;
        }
        const task = engine.createManualTask({
          prompt: JSON.stringify(e.args),
          tool: target.targetId,
          sessionTitle: `接棒 · ${target.title}`,
          origin: { fleet: { fleetId, memberId: target.id, depth: nextDepth } },
          executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
        });
        dispatched.push({ to: target.id, taskId: task.id });
        continue;
      }
      const summary = out?.ok === true
        ? String(out.text ?? "").slice(0, 2000) || "(upstream produced no text)"
        : `上游回合失败:${String(out?.error ?? "unknown").slice(0, 500)}——如实转述,不自动重试`;
      const task = engine.createManualTask({
        prompt:
          `【舰队接棒】上游岗位回合结束,依声明边接棒(链位 ${nextDepth}/${constraints.maxChainDepth})。\n` +
          `上游结果:\n${summary}`,
        ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: rosterPresetId(target.targetId) }),
        sessionTitle: `接棒 · ${target.title}`,
        origin: { fleet: { fleetId, memberId: target.id, depth: nextDepth } },
        executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
      });
      dispatched.push({ to: target.id, taskId: task.id });
    }

    // Fanout edges (add-fleet-fanout D2): one parallel wave per edge — a
    // manual turn per target, same honest relay as handoff, depth rides the
    // chain. Aggregation rides the delegation aggregator VERBATIM: no-judge
    // waves carry the upstream session as initiator (the group's outcomes
    // inject into the upstream post's next turn); judge waves carry the
    // synthetic fleet-scoped initiator + the judge's roster preset, so the
    // aggregator switches to the judge persona and runs the ruling turn on
    // group completion. Wave counter is provenance only (single wave per
    // upstream turn; further debate rounds are the judge's own dispatch_post
    // calls, depth is the hard bound).
    const fanouts = outgoingFanouts(fleet.orchestration, memberId);
    for (const e of fanouts) {
      const agg = e.aggregate ?? { kind: "all" };
      const judge = agg.kind === "judge" ? db.getMember(agg.judge) : null;
      if (agg.kind === "judge" && (!judge || judge.fleetId !== fleetId || judge.targetKind !== "persona")) continue;
      const summary = out?.ok === true
        ? String(out.text ?? "").slice(0, 2000) || "(upstream produced no text)"
        : `上游回合失败:${String(out?.error ?? "unknown").slice(0, 500)}——如实转述,不自动重试`;
      const rounds = Number.isInteger(e.rounds) ? e.rounds : 1;
      for (const t of e.targets ?? []) {
        const target = db.getMember(t);
        if (!target || target.fleetId !== fleetId) continue;
        if (target.targetKind === "cluster" || target.targetKind === "tool") continue;
        if (nextDepth > constraints.maxChainDepth) {
          db.appendTurnEvent({
            fleetId,
            memberId: target.id,
            source: "manual",
            status: "failed",
            errorKind: "other",
            error: `fanout depth bound reached (${nextDepth} > ${constraints.maxChainDepth}) — wave stopped before this hop`,
            startedAt: now,
            endedAt: now,
            sessionId: null,
          });
          continue;
        }
        const task = engine.createManualTask({
          prompt:
            `【舰队并行扇出】上游岗位「${db.getMember(memberId)?.title ?? memberId}」回合结束,你与同波同伴并行接令(轮次 1/${rounds})。\n` +
            `上游结果:\n${summary}`,
          ...(target.targetKind === "a2a" ? { agent: target.targetId } : { persona: rosterPresetId(target.targetId) }),
          sessionTitle: `扇出 · ${target.title}`,
          origin: { fleet: { fleetId, memberId: target.id, depth: nextDepth, wave: 1 } },
          ...(judge
            ? { initiator: `fleet:${fleetId}:${judge.id}`, initiatorPreset: rosterPresetId(judge.targetId) }
            : { initiator: job.sessionId ?? null }),
          executionPolicy: { timeoutMinutes: constraints.budgetPerEdgeMin },
        });
        dispatched.push({ to: target.id, taskId: task.id, wave: true, judge: judge?.id ?? null });
      }
    }
    return dispatched.length ? dispatched : null;
  } catch (e) {
    console.warn(`[fleets] handoff trigger failed: ${e?.message || e}`);
    return null;
  }
};

// One-time import of legacy file stores (documents-store/, sessions-store/,
// chat-history-store/) into the SQLite database. Runs only on a fresh database;
// idempotent; never deletes the legacy stores. migrate.js reads both legacy
// chat formats directly with stdlib fs (no SDK dependency).
// catalog.initCatalog resolves on the LOCAL catalog (cloud + registry merge
// async); cron reads its jobs file and starts timers. The registry bridge
// resolves immediately (its first fetch runs in the background, TTL keeps the
// snapshot warm); disabled entirely without MARKET_REGISTRY_URL/REGISTRY_URL.
// Fleet patrol-context inputs (agent-fleet-report-lane): the renderer needs
// the fleet's on-duty overview; statuses are derived read-time, same as the
// routes' read face.
const fleetDb = getFleetDatabase();
function deriveFleetStatuses(fleetId) {
  const fleet = fleetDb.getFleet(fleetId);
  if (!fleet) return new Map();
  const tasks = new Map(
    cron.listJobs().filter((j) => j?.sourceTag?.fleetId === fleetId).map((j) => [j.sourceTag.memberId, j]),
  );
  const out = new Map();
  for (const m of fleetDb.listMembers(fleetId)) {
    out.set(
      m.id,
      deriveMemberStatus({
        member: m,
        fleet,
        task: tasks.get(m.id) ?? null,
        targetAlive: resolveFleetTarget(m).alive,
        latestReport: fleetDb.latestReportFor(m.id),
      }).status,
    );
  }
  return out;
}

initRegistryBridge({ broadcast: ctx.broadcast });
await Promise.all([
  migrate.runLegacyMigrations(),
  catalog.initCatalog({
    broadcast: ctx.broadcast,
    // The catalog's chat agents are served locally through generated persona
    // presets; a changed catalog regenerates them and restarts the idle child so
    // its roster lists the packs that arrived (or dropped) with it.
    onChange: () => {
      void ctx.syncCatalogAgentPresets?.();
      // A catalog change can kill a fleet post's incumbent (persona gone) or
      // revive one — converge every fleet's materialized tasks so a vacant
      // post stops firing. Gated on engine readiness: this hook can fire
      // during boot while initCron (same Promise.all) is still loading.
      if (cron.isEngineInitialized()) {
        void reconcileAllFleets({
          db: getFleetDatabase(),
          cronApi: cron,
          resolveTarget: resolveFleetTarget,
          rosterPresetId,
        }).catch((e) => console.warn(`[fleets] catalog-change reconcile failed: ${e.message}`));
      }
    },
  }),
  cron.initCron({
    broadcast: ctx.broadcast,
    // The runner (server/cron-runner.js) executes one bound-session turn:
    // wait-for-idle, preset switch, collector-prompted exchange, persistence.
    runJobTurn: (job, opts) => ctx.runCronJobTurn(job, opts),
    isBusy: () => ctx.isStreaming,
    // Worker-pool occupancy for the fleet stats snapshot; a closure because the
    // pool attaches after this init (unify-wanxing-management-plane).
    workerStats: () => ctx.workerPool?.poolStats(),
    // Fleet patrol context (agent-fleet-report-lane D6): render the
    // {{fleetContext}} segment at fire time for fleet-tagged tasks; cron.js
    // substitutes it into that fire's prompt. Throws or empty segments fail
    // the fire explicitly — never a silent empty-context patrol. The decision
    // digest (agent-fleet-decision-lane) rides the same segment slot: this
    // post's undelivered resolutions, their own block, absent when empty.
    renderFleetContext: (sourceTag, task) =>
      buildFleetContext(sourceTag, task, {
        db: getFleetDatabase(),
        deriveStatuses: deriveFleetStatuses,
        decisionDigest: (fleetId, memberId) => {
          const items = getFleetDatabase().listDecisions({ fleetId, pendingDeliveryFor: memberId });
          return renderDecisionSegment(items);
        },
      }),
  }),
]);
// Delegation aggregator: hooks the engine AFTER initCron (init clears hook
// subscribers) — finished manual fan-outs inject the summary turn back into
// the initiating session; rearm covers groups a restart left pending.
attachDelegationAggregator(ctx).rearm();
// Fleet report + decision lanes (agent-fleet-report-lane D4,
// agent-fleet-decision-lane 2.2): a finished a2a fleet fire cannot self-report
// (the remote agent cannot call this cell's tools) — its outcome becomes a
// derived, honestly-badged execution-summary report row. And a DONE fleet turn
// (cadence fire or execute-now manual task) delivers this post's resolved
// decisions — idempotent, capped per turn, oldest resolution first. Failed
// turns deliver nothing (the context never reached the model). Registered
// after initCron for the same reason as the aggregator; the engine is imported
// dynamically here because server.js otherwise stays runtime-agnostic behind
// cron.js.
{
  const engine = await import("./task-engine.js");
  const fleetLanesDb = getFleetDatabase();
  engine.addOnFinished((task) => {
    try {
      const derived = derivedReportFromTask(task);
      if (derived) fleetLanesDb.appendReport(derived);
    } catch (e) {
      console.warn(`[fleets] derived report failed for ${task?.id}: ${e.message}`);
    }
    try {
      if (task?.state === "done") {
        const memberId = task.sourceTag?.memberId ?? task.origin?.fleet?.memberId ?? null;
        if (memberId) {
          fleetLanesDb.markDelivered(memberId, { sessionId: task.sessionId ?? null });
        }
      }
    } catch (e) {
      console.warn(`[fleets] decision delivery marking failed for ${task?.id}: ${e.message}`);
    }
  });
  // Fleet-policy expiry backstop (lazy sweeps run on every queue read; this
  // hourly pass covers fleets nobody is reading).
  setInterval(() => {
    try {
      for (const fleet of fleetLanesDb.listFleets()) {
        fleetLanesDb.expireOpenDecisions(fleet.id);
      }
    } catch (e) {
      console.warn(`[fleets] expiry sweep failed: ${e.message}`);
    }
  }, 60 * 60 * 1000).unref();
}
// Worker pool (TASK_WORKER_MAX; 0 = inert, exactly today's serial semantics).
// Attached after the engine so the slot dispatcher registers against the
// initialized engine; ctx.workerPool feeds the aggregator's drain gate.
ctx.workerPool = attachWorkerPool(ctx);
// MC console bridge (mission-control-bridge): opt-in via env, outbound-only,
// never boot-blocking. Inert without MC_BRIDGE=1 + MC_URL + MC_API_KEY.
ctx.mcBridge = attachMcBridge(ctx);

// Resource library: inject the WS broadcast and run the one-time chart seeding
// pass. Deliberately AFTER runLegacyMigrations — on a fresh database the legacy
// import lands messages that must be seeded too, and the seeding marker is
// one-shot, so seeding before the import would skip them forever.
await resources.initStore({ broadcast: ctx.broadcast });
// Chart data bindings (add-chart-data-binding): the per-binding refresh timers,
// the freshness gate, the failure backoff and the retention sweeper. Started
// after the library because it schedules only bindings that resource references
// exist for, and after the dsh bridge because a refresh uses the same
// per-user credential the runtime's MCP entries carry.
const chartRefresh = await import("./chart-refresh.js");
await chartRefresh.initChartRefresh({
  broadcast: ctx.broadcast,
  ownerEmail: () => ctx.runtimeOwnerEmail ?? null,
});
console.log("Platform fully initialized");

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  cron.shutdown();
  ctx.workerPool?.shutdown();
  bots.stopAll();
  catalog.stopCatalog();
  stopRegistryBridge();
  packRegistry?.close();
  await trace.shutdownTrace();
  try {
    await ctx.dshBridge?.shutdown();
  } catch (err) {
    console.error("[shutdown] dsh bridge failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
