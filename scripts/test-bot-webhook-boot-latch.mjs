// Regression for the fd-prod 2026-10-29 message loss: the cell calls
// server.listen BEFORE bots.initBots (db open + dsh handshake sit between), and
// the gateway proxies a bot webhook as soon as the port answers. A message
// landing in that window found an EMPTY registry and got a definite 403
// "unknown bot" — which the chat platform treats as final, so the message was
// dropped (observed twice right after a roll).
//
// The webhook route must WAIT for the boot latch instead of refusing: a bot
// that loads a moment later is served normally; a genuinely unknown bot still
// gets the identical 403 once boot settles (same attack surface, no oracle).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bots-latch-test-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { registry: telegramRegistry } = await import("../server/bots/telegram.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

const sent = [];
let server;
let base;
let ctx;
let botRow;

before(async () => {
  await db.initDb();

  const app = express();
  const jsonBodyParser = express.json();
  app.use((req, res, next) =>
    req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next),
  );
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);

  ctx.dshBridge = { isReady: () => true, prompt: async () => { throw new Error("unused"); } };

  // The bot ROW exists in the database, but initBots has NOT run yet — this is
  // exactly the boot window: the cell is listening, the registry is empty.
  botRow = db.addBot({
    id: "latch-bot-1",
    type: "telegram",
    name: "latch",
    credentials: { token: "SECRET" },
    secret: "latch-secret",
  });
  telegramRegistry.sendText = async (_cred, chatKey, text) => { sent.push({ chatKey, text }); };
  telegramRegistry.start = undefined;

  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("a webhook arriving before the registry loads waits for it instead of 403", async () => {
  assert.equal(bots.bootPending(), true, "the fixture must be inside the boot window");
  assert.equal(bots.getEntry(botRow.id), null, "registry is still empty at this point");

  const update = {
    update_id: 1,
    message: { message_id: 1, chat: { id: 777 }, from: { username: "u" }, date: 0, text: "boot race" },
  };

  // Fire the webhook while the registry is empty, then load the registry a
  // moment later — the same order the real cell produces.
  const pending = fetch(`${base}${WEBHOOK_PREFIX}${botRow.id}/${botRow.secret}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });

  await new Promise((r) => setTimeout(r, 250));
  bots.initBots(ctx); // the boot completing

  const res = await pending;
  assert.equal(res.status, 200, "the waiting webhook must be served, not refused");
  assert.equal(await res.text(), "success");
});

test("a genuinely unknown bot still gets the same 403 once boot settles", async () => {
  assert.equal(bots.bootPending(), false, "boot is settled by now");
  const res = await fetch(`${base}${WEBHOOK_PREFIX}no-such-bot/whatever`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});
