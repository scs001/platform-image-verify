// Bot management + inbound webhook routes.
//
// TRUST BOUNDARY (design D3, spec "Webhook authentication under forward auth"):
// `/api/bots/webhook/*` is the ONLY route in this file exempt from the
// forward-auth identity header — external chat platforms cannot send
// X-Forwarded-Email. It authenticates on the per-bot path secret plus the
// platform's own signature/decryption instead, both of which run before any
// payload content is parsed or logged. The exemption is applied by an explicit
// path check in server/auth.js, not a blanket public flag. Every other route
// here stays behind the proxy and is admin-gated.

import express from "express";
import crypto from "node:crypto";
import * as bots from "../bots.js";
import { BOT_TYPES, credentialFieldsFor, qrCapabilityFor, adapterForBot } from "../bots/adapter.js";
import { qrSvg } from "../bots/qr.js";
import { GENERIC_BOT_TYPES } from "../../lib/generic-bot-types.js";
import { validateConfigDims, effortUnionFrom } from "../fleet-model.js";

// The webhook path prefix, shared with the forward-auth exemption in auth.js.
export const WEBHOOK_PREFIX = "/api/bots/webhook/";

// Boot window handling. Measured 2026-10-29 in fd-prod: the cell calls
// server.listen 8.2s BEFORE bots.initBots finishes (db open + dsh handshake),
// while WeCom/WeChat drop a callback at roughly 5s. Waiting therefore loses
// either way — so during boot the webhook is ACKED at once and buffered, and
// the buffered request is replayed through the FULL pipeline (signature check
// included) once the registry is up. A forged request earns a bare 200 and no
// processing; nothing is dispatched before verification still.
const BOOT_REPLAY_WAIT_MS = Number(process.env.BOTS_WEBHOOK_BOOT_WAIT_MS) || 30_000;
// Bounded: a boot lasting longer than this is broken, and an unbounded buffer
// is a memory sink under a webhook flood.
const BOOT_BUFFER_MAX = Number(process.env.BOTS_WEBHOOK_BOOT_BUFFER_MAX) || 20;

export function registerBotRoutes(ctx) {
  const { app, db } = ctx;

  const requireDb = (res) => {
    if (db.isDbReady()) return true;
    res.status(503).json({ error: "Bot management is disabled (database unavailable)" });
    return false;
  };

  // Buffered boot-window webhooks, drained once bots.initBots settles.
  const bootBuffer = [];
  let bootDrainArmed = false;

  // ── Inbound webhook ────────────────────────────────────────────────────────
  // Raw body: WeCom/WeChat send XML and every platform signs the bytes as sent,
  // so the payload must not be re-serialized by express.json() before checking.
  app.all(
    `${WEBHOOK_PREFIX}:botId/:secret`,
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      let json;
      try { json = JSON.parse(raw); } catch { /* XML platforms: adapters read .raw */ }
      const adapterReq = { method: req.method, query: req.query, headers: req.headers, raw, json };
      const botId = req.params.botId;
      const given = req.params.secret;

      // Boot window: registry not loaded yet and the bot is not in it. Ack and
      // buffer — see the BOOT_* block above for the measured numbers.
      if (bots.bootPending() && !bots.getEntry(botId)) {
        if (bootBuffer.length >= BOOT_BUFFER_MAX) {
          console.warn(`[bots] boot buffer full (${BOOT_BUFFER_MAX}); dropping a webhook for ${botId}`);
          return res.sendStatus(503);
        }
        bootBuffer.push({ botId, given, adapterReq });
        console.log(`[bots] webhook for ${botId} buffered until the registry loads (${bootBuffer.length} queued)`);
        res.type("text/plain").send("success");
        armBootDrain();
        return;
      }

      await handleVerifiedWebhook(botId, given, adapterReq, res);
    },
  );

  function armBootDrain() {
    if (bootDrainArmed) return;
    bootDrainArmed = true;
    void bots.whenBooted(BOOT_REPLAY_WAIT_MS).then(async (ready) => {
      bootDrainArmed = false;
      const queued = bootBuffer.splice(0, bootBuffer.length);
      if (!queued.length) return;
      if (!ready) {
        console.warn(`[bots] registry still not loaded after ${BOOT_REPLAY_WAIT_MS}ms; dropping ${queued.length} buffered webhook(s)`);
        return;
      }
      for (const item of queued) {
        try {
          await handleVerifiedWebhook(item.botId, item.given, item.adapterReq, null);
        } catch (e) {
          console.warn(`[bots] buffered webhook replay failed for ${item.botId}: ${e.message}`);
        }
      }
    });
  }

  // The verification + dispatch pipeline. `res` null = replay (no HTTP reply).
  async function handleVerifiedWebhook(botId, given, adapterReq, res) {
    const done = (code, body, type = "text/plain") => {
      if (!res) {
        if (code >= 400) console.warn(`[bots] buffered webhook for ${botId} refused (${code})`);
        return;
      }
      if (type === "json") return res.status(code).json(body);
      res.status(code).type(type).send(body);
    };

    const entry = bots.getEntry(botId);
    // Same 403 for unknown bot, disabled bot, and bad secret: an attacker
    // learns nothing about which bot ids exist. timingSafeEqual guards the
    // secret compare; unequal lengths are a mismatch by definition.
    const secret = entry ? Buffer.from(entry.bot.secret) : null;
    const submitted = Buffer.from(String(given));
    const ok =
      entry?.bot.enabled &&
      secret.length === submitted.length &&
      crypto.timingSafeEqual(secret, submitted);
    // The reply stays identical for unknown/disabled/bad-secret (attackers
    // learn nothing), but a mismatch is LOGGED: "arrived and was refused"
    // and "never arrived" must be distinguishable when debugging a
    // platform whose console shows the config as saved (fd-prod lesson,
    // add-user-questions).
    if (!ok) {
      console.warn(
        `[bots] webhook refused: botId=${botId}${entry ? ` (${entry.bot.name}, enabled=${entry.bot.enabled})` : " unknown"}`,
      );
      return done(403, "Forbidden");
    }

    // Platform verification. A throw here means the request is forged or
    // undecryptable — 403, and the content is never logged (design D3.1).
    let challenge;
    try {
      challenge = await entry.adapter.verifyWebhook(adapterReq, entry.bot.credentials);
    } catch (err) {
      console.warn(`[bots] "${entry.bot.name}" rejected an unverified webhook request: ${err.message}`);
      return done(403, "Forbidden");
    }
    // The platform's URL-verification handshake wants its literal echo.
    // Logged: a SILENT success is indistinguishable from "the platform
    // never called" when debugging why a saved console config delivers
    // nothing (fd-prod lesson, add-user-questions).
    if (challenge !== null) {
      console.log(`[bots] "${entry.bot.name}" handshake verified and echoed`);
      return done(200, challenge);
    }

    let message;
    try {
      message = await entry.adapter.parseMessage(adapterReq, entry.bot.credentials);
    } catch (err) {
      console.warn(`[bots] "${entry.bot.name}" could not parse a verified payload: ${err.message}`);
      return done(400, "Bad Request");
    }

    // Ack immediately: every one of these platforms retries on a slow reply,
    // and an agent turn takes far longer than their timeout.
    done(200, "success");
    if (message) {
      console.log(`[bots] "${entry.bot.name}" inbound from ${message.chatKey}: "${String(message.text).slice(0, 60)}"`);
      bots.handleMessage(entry.bot.id, message).catch((e) =>
        console.warn(`[bots] "${entry.bot.name}" turn failed: ${e.message}`),
      );
    } else {
      // Forensics (fd-prod lesson): the canonical text XML parsed locally but
      // not in prod — the length, content-type and first bytes name the
      // culprit (empty body vs gzip magic vs unexpected shape).
      console.log(
        `[bots] "${entry.bot.name}" non-text payload ignored (len=${adapterReq.raw.length} ct=${adapterReq.headers["content-type"] ?? "?"} head=${JSON.stringify(adapterReq.raw.slice(0, 40))})`,
      );
    }
  }

  // ── Generic bot types (read-only registry face) ────────────────────────────
  // The platform-hosted generic bot type set (pack-bot-units): the same
  // objects the manifest validator checks references against and the pack
  // install face lists. Read-only — types are defined by the platform, never
  // configured here. No db gate: a static registry answers even before the
  // database is ready (the publish prevalidation face has no cell state).

  app.get("/api/bots/generic-types", (_req, res) => {
    res.json({ genericTypes: GENERIC_BOT_TYPES });
  });

  // ── Config CRUD (admin-gated; credentials masked in every response) ────────

  app.get("/api/bots", (_req, res) => {
    if (!requireDb(res)) return;
    res.json({
      bots: db.listBots().map(bots.maskBot),
      types: BOT_TYPES.map((type) => ({
        type,
        credentialFields: credentialFieldsFor(type),
        qr: qrCapabilityFor(type),
      })),
      genericTypes: GENERIC_BOT_TYPES,
    });
  });

  app.post("/api/bots", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const { type, name, credentials, enabled = true, persona, allowTools } = req.body || {};
    if (!type || !name) return res.status(400).json({ error: "Missing type or name" });
    const invalid = bots.validateCredentials(type, credentials);
    if (invalid) return res.status(400).json({ error: invalid });
    const bot = db.addBot({
      id: crypto.randomUUID(),
      type,
      name,
      credentials,
      // The webhook path secret; random per bot, never rotated in place (delete
      // and recreate to rotate — the platform's callback URL must change too).
      secret: crypto.randomBytes(24).toString("base64url"),
      enabled,
      // Identity + tool posture (harden-bot-reply-lane): both are plain row
      // fields, so they can be set at creation and edited later without a
      // restart (reload() below picks them up).
      persona,
      allowTools,
      // Creator identity (fix-gateway-bot-owner): the gateway's webhook router
      // prefers this over session-ownership inference, which is arbitrary on
      // cells with mixed sign-in history.
      ownerEmail: req.user?.email ?? null,
    });
    bots.reload(bot);
    res.json(bots.maskBot(bot));
  });

  app.patch("/api/bots/:id", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const existing = db.getBot(req.params.id);
    if (!existing) return res.status(404).json({ error: "Bot not found" });
    const { name, credentials, enabled, effort, contextBudget, persona, allowTools } = req.body || {};
    // Config dimensions (add-agent-config-dims D5): the same shape gate the
    // fleet PATCH uses — a bot inherits the same effort/budget semantics.
    const dims = validateConfigDims({ effort, contextBudget }, effortUnionFrom(ctx?.dshModels));
    if (dims.error) return res.status(400).json({ error: dims.error });
    if (credentials !== undefined) {
      // Merge over the stored values so the UI can save a form whose secret
      // fields were left blank without wiping the credentials behind them.
      const merged = { ...existing.credentials };
      for (const [k, v] of Object.entries(credentials)) if (String(v ?? "").trim()) merged[k] = v;
      const invalid = bots.validateCredentials(existing.type, merged);
      if (invalid) return res.status(400).json({ error: invalid });
      req.body.credentials = merged;
    } else if (enabled === true) {
      // Enabling is an operator's explicit action — a generic channel bot
      // (pack-born) must have its platform binding and credentials in place
      // before it can go live. Plain bots were credential-validated at
      // creation, so this re-check is a no-op for them.
      const invalid = bots.validateCredentials(existing.type, existing.credentials);
      if (invalid) return res.status(400).json({ error: invalid });
    }
    const bot = db.updateBot(req.params.id, {
      name,
      credentials: req.body.credentials,
      enabled,
      ...(effort !== undefined ? { effort: dims.effort } : {}),
      ...(contextBudget !== undefined ? { contextBudget: dims.contextBudget } : {}),
      ...(persona !== undefined ? { persona } : {}),
      ...(allowTools !== undefined ? { allowTools } : {}),
    });
    bots.reload(bot);
    res.json(bots.maskBot(bot));
  });

  app.delete("/api/bots/:id", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    if (!db.getBot(req.params.id)) return res.status(404).json({ error: "Bot not found" });
    bots.stop(req.params.id);
    db.deleteBot(req.params.id);
    res.json({ ok: true });
  });

  // ── Seen chats + relay channels (admin-gated) ──────────────────────────────
  //
  // The destination list a relay caller can address (add-bot-relay-endpoint).
  // A binding is creatable only from a chat the inbound pipeline recorded, so
  // the relay token can never be pointed at a chat this deployment has not
  // seen. These rows carry identity and timing only — no message text, and no
  // bot credentials.

  const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

  app.get("/api/bots/chats", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const names = new Map(db.listBots().map((b) => [b.id, b.name]));
    res.json({
      chats: db.listBotChats().map((c) => ({ ...c, botName: names.get(c.botId) ?? null })),
    });
  });

  app.get("/api/bots/channels", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    res.json({ channels: db.listChannels() });
  });

  app.post("/api/bots/channels", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const { name, botId, chatKey } = req.body || {};
    if (!CHANNEL_NAME_RE.test(String(name ?? ""))) {
      return res.status(400).json({ error: "Channel name must match [a-z0-9][a-z0-9._-]{0,63}" });
    }
    if (!botId || !chatKey) return res.status(400).json({ error: "Missing botId or chatKey" });
    if (!db.getBot(botId)) return res.status(404).json({ error: "Bot not found" });
    if (!db.getBotChat(botId, chatKey)) {
      return res.status(400).json({ error: "That chat has never messaged this bot" });
    }
    try {
      db.createChannel({ name, botId, chatKey });
    } catch {
      // The primary key is the authority; a check-then-insert would race it.
      return res.status(409).json({ error: "Channel name already exists" });
    }
    res.json({ channel: db.getChannel(name) });
  });

  app.delete("/api/bots/channels/:name", (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    if (!db.deleteChannel(req.params.name)) {
      return res.status(404).json({ error: "Channel not found" });
    }
    res.json({ ok: true });
  });

  // ── Onboarding QR (user entry) ─────────────────────────────────────────────
  // Same posture as the read side of config management: behind the proxy /
  // forward-auth gate like every non-webhook route here, credentials stay
  // server-side, nothing about the request is logged. A disabled bot still
  // resolves — the QR advertises an entry the operator may be preparing.
  //
  // Failure isolation: every failure path answers 200 with
  // `{ strategy: "manual", url: null, qr: null, error? }` so the panel shows
  // the reason plus the manual-link fallback — a bad token, an unsupported
  // account type, or an upstream outage never 500s bot management.
  app.get("/api/bots/:id/qr", async (req, res) => {
    if (!requireDb(res)) return;
    const bot = db.getBot(req.params.id);
    // adapterForBot resolves a generic channel row's platform binding; an
    // unbound pack bot has no adapter yet and answers 404 like an unknown bot.
    const adapter = bot ? adapterForBot(bot) : null;
    if (!bot || !adapter?.qr) return res.status(404).json({ error: "Bot not found" });

    const { strategy, hintKey } = adapter.qr;
    const hint = hintKey ?? "botsPage.qr.hint.manual";
    const manual = (error) => res.json({ strategy: "manual", url: null, qr: null, hint, ...(error && { error }) });

    // A stored entry link wins on every platform: it is the manual fallback's
    // save target, so an override must survive later panel opens.
    const manualUrl = String(bot.credentials?.qrUrl ?? "").trim();
    if (manualUrl) {
      try {
        return res.json({ strategy: "manual", url: manualUrl, qr: await qrSvg(manualUrl), hint });
      } catch (err) {
        return manual(err.message);
      }
    }

    if (strategy === "manual") {
      // No link yet: the panel prompts for it instead of failing.
      return manual();
    }

    try {
      const { url } = await adapter.qr.resolve(bot.credentials);
      res.json({ strategy, url, qr: await qrSvg(url), hint });
    } catch (err) {
      manual(err.message);
    }
  });

  // ── Proactive outbound send ────────────────────────────────────────────────

  app.post("/api/bots/:id/send", async (req, res) => {
    if (!ctx.requireAdmin(req, res) || !requireDb(res)) return;
    const { chatKey, text } = req.body || {};
    if (!chatKey || !text) return res.status(400).json({ error: "Missing chatKey or text" });
    try {
      await bots.sendTo(req.params.id, chatKey, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
