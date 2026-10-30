// Social chat-platform bots: registry, inbound pipeline, and reply delivery.
//
// One dsh runtime serves the web chat and every bot chat. A bot chat is bound
// to its own dsh session (`bot-<botId>-<sha1(chatKey)16>`), which dsh persists
// and resumes from disk — so a conversation survives a runtime restart and a
// model switch. Notifications for those sessions are routed to a per-turn
// collector by the session-aware pump (server/dsh-events.js), never to the WS
// broadcast path.
//
// Graceful degradation, per the project convention: the module is inert with
// no bots configured, every adapter call is failure-isolated, and a broken bot
// is logged and skipped rather than crashing the server or stalling the others.

import { stripReasoningLeak } from "./reasoning-leak.js";
import crypto from "node:crypto";
import { adapterForBot, validateCredentials } from "./bots/adapter.js";
import { isGenericBotType, packBotMeta, PACK_BOT_CREDENTIAL_KEY } from "../lib/generic-bot-types.js";

// Trust-boundary guards (design D3). These bound an untrusted external caller's
// reach into an agent, so they live here — before prompt() — not in the adapters.
const MAX_MESSAGE_CHARS = 4000;
const RATE_LIMIT_PER_MIN = 10;
const TURN_TIMEOUT_MS = Number(process.env.BOTS_TURN_TIMEOUT_MS) || 180_000;

// Relay guards (add-bot-relay-endpoint, design D6). The same bounds as the
// inbound pipeline's, named separately so either path can move without the
// other. The timeout bounds the response a machine caller waits for; the
// adapters' send fetch takes no AbortSignal, so a hung platform call can
// outlive the reply (recorded as a risk in the change's design).
// MAX_RELAY_CHARS is exported for the route's error message — the cap itself is
// enforced here, at the send.
export const MAX_RELAY_CHARS = 4000;
const RELAY_RATE_PER_MIN = 10;
const RELAY_SEND_TIMEOUT_MS = 15_000;

// v1 posture: bot turns are answer-only. dsh exposes no per-session tool
// control (tools are auto-allowed by the profile's plugins), so this is
// enforced in two places that ARE available: an explicit instruction on the
// prompt, and a reply-side check that refuses to forward an answer derived
// from tool calls. `BOTS_ALLOW_TOOLS=1` lifts both.
// ponytail: prompt-level posture is the ceiling until dsh grows a per-prompt
// tool allowlist; the reply-side check is what makes it observable.
const NO_TOOLS_PREFIX =
  "You are answering a message from an external chat platform. Answer directly from " +
  "your own knowledge. Do not call any tools — the ONE exception is ask_user_question: " +
  "when you need the user's confirmation, a choice, or missing information before you " +
  "can answer, call it (it pauses until the user replies in chat).\n\n";

// ── User questions (add-user-questions, ADR-0012) ───────────────────────────
// A bot turn that calls ask_user_question parks on the platform's provider
// bridge: the ask arrives as a `userQuestion/ask` notification on the turn's
// collector, is rendered as numbered-option text into the chat, and the chat's
// NEXT inbound message is intercepted as the answer attempt — never a new
// turn. The wait window (BOTS_ASK_WAIT_MS, default 10 min) bounds the pause;
// while an ask is pending the turn hard timeout is PAUSED, and on expiry the
// ask is cancelled automatically with the turn continuing to its normal
// conclusion. Matching failures re-prompt the options; after ASK_MAX_ATTEMPTS
// unrecognized replies the ask is cancelled. The no-tools posture exempts the
// ask tool itself: the answer is the user's own words, not tool output.
const ASK_WAIT_MS = Number(process.env.BOTS_ASK_WAIT_MS) || 600_000;
const ASK_MAX_ATTEMPTS = 3;
const ASK_CANCEL_WORDS = new Set(["取消", "cancel"]);

const state = {
  ctx: null,
  bots: new Map(), // id → { bot, adapter, stopPoll }
  queues: new Map(), // sessionId → tail promise (serializes turns within a chat)
  buckets: new Map(), // `${botId}:${chatKey}` → { tokens, refilledAt }
  relayBuckets: new Map(), // channel name → { tokens, refilledAt }
  // sessionId → the chat's pending ask: {bot, adapter, chatKey, askId,
  // questions, attempts, timer, resolve}. `resolve(cancelled, answers)` is the
  // collectTurn closure that submits to the runtime and resumes the paused
  // turn timeout. Present only while a question waits in that chat.
  pendingAsks: new Map(),
};

const allowTools = () => process.env.BOTS_ALLOW_TOOLS === "1";

export function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || null;
}

// Stable per-(bot, external chat) dsh session id (design D2). Derived, not
// stored: the conversation itself lives in dsh's session store.
export function sessionIdFor(botId, chatKey) {
  const hash = crypto.createHash("sha1").update(String(chatKey)).digest("hex").slice(0, 16);
  return `bot-${botId}-${hash}`;
}

export function webhookUrlFor(bot) {
  const base = publicBaseUrl() ?? "";
  return `${base}/api/bots/webhook/${bot.id}/${bot.secret}`;
}

// Browser-facing shape. Credential VALUES never leave the server — only the
// set of keys that are configured, so the UI can show "configured" hints.
// A pack-materialized bot additionally exposes its provenance (owning pack,
// mounted skill) and an awaitingConnection flag: pack bots are born disabled
// with no channel credentials — enabling and credentialing are the
// operator's explicit actions, never side effects of installing a pack.
export function maskBot(bot) {
  const meta = packBotMeta(bot.credentials);
  const configured = Object.entries(bot.credentials ?? {})
    .filter(([k, v]) => k !== PACK_BOT_CREDENTIAL_KEY && String(v ?? "").trim())
    .map(([k]) => k);
  const mask = {
    id: bot.id,
    type: bot.type,
    name: bot.name,
    enabled: bot.enabled,
    createdAt: bot.createdAt,
    configuredCredentials: configured,
    webhookUrl: webhookUrlFor(bot),
    // Config dimensions (add-agent-config-dims): declared effort/budget ride
    // the masked row so the edit form can prefill; null = not declared.
    effort: bot.effort ?? null,
    contextBudget: bot.context_budget ?? null,
  };
  if (meta) {
    mask.pack = { packId: meta.packId, skill: meta.skill ?? null, generic: meta.generic ?? bot.type };
    mask.awaitingConnection = validateCredentials(bot.type, bot.credentials) !== null;
  }
  return mask;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Boot latch (2026-10-29 fd-prod): `server.listen` runs BEFORE `bots.initBots`
// — db open and the dsh handshake sit between them. The gateway proxies a bot
// webhook as soon as the cell's port answers, so a message landing in that
// window found an EMPTY registry and got a fast 403 "unknown"; the chat
// platform treats a definite refusal as final and the message is LOST (two
// observed drops). The webhook route therefore waits on this latch instead of
// answering prematurely: a genuinely unknown bot still gets the identical 403
// once boot completes, so the attack surface is unchanged.
let bootSettled = false;
let bootResolve;
const bootPromise = new Promise((resolve) => { bootResolve = resolve; });

export function bootPending() {
  return !bootSettled;
}

// Resolves true when the registry is loaded, false when the budget ran out.
// The timer is deliberately NOT unref'd: this wait is bounded by the live
// webhook request that called it, and a ref'd timer keeps the answer honest
// even when nothing else is scheduled.
export function whenBooted(timeoutMs) {
  if (bootSettled) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    bootPromise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function settleBoot() {
  if (bootSettled) return;
  bootSettled = true;
  bootResolve?.();
}

export function initBots(ctx) {
  state.ctx = ctx;
  try {
    if (!ctx.db.isDbReady()) {
      console.warn("[bots] disabled: database unavailable");
      return;
    }
    for (const bot of ctx.db.listBots()) reload(bot);
    const live = [...state.bots.values()].filter((e) => e.bot.enabled).length;
    if (live) console.log(`[bots] ${live} bot(s) active`);
  } finally {
    // Always release waiting webhooks: a half-loaded or broken registry must
    // cost one 403, never a 4s stall on every message for the process lifetime.
    settleBoot();
  }
}

// (Re)build one bot's runtime entry from its row: stop whatever was running,
// then start the new config. Called on every config mutation, so changes take
// effect without a server restart.
export function reload(bot) {
  stop(bot.id);
  const adapter = adapterForBot(bot);
  if (!adapter) {
    // A generic-type row (pack bot) without a platform binding is not an
    // error state — it is the born awaiting-connection posture. Log it
    // quietly; no runtime entry exists, so nothing is reachable.
    if (isGenericBotType(bot.type)) {
      console.log(`[bots] "${bot.name}" (${bot.type}) awaiting a platform binding; not registered`);
    } else {
      console.warn(`[bots] "${bot.name}" has unknown type "${bot.type}"; skipped`);
    }
    return;
  }
  const entry = { bot, adapter, stopPoll: null };
  state.bots.set(bot.id, entry);
  if (!bot.enabled) return;
  // Polling fallback: adapters that support it (telegram) run a long-poll loop
  // when the server has no public URL for the platform to call back to.
  if (adapter.start && !publicBaseUrl()) {
    try {
      entry.stopPoll = adapter.start(bot, (msg) => {
        void handleMessage(bot.id, msg).catch((e) =>
          console.warn(`[bots] "${bot.name}" polled turn failed: ${e.message}`),
        );
      });
      console.log(`[bots] "${bot.name}" polling (no PUBLIC_BASE_URL)`);
    } catch (e) {
      console.warn(`[bots] "${bot.name}" poll start failed: ${e.message}`);
    }
  }
}

export function stop(botId) {
  const entry = state.bots.get(botId);
  if (!entry) return;
  try { entry.stopPoll?.(); } catch (e) { console.warn(`[bots] stop failed: ${e.message}`); }
  state.bots.delete(botId);
}

export function stopAll() {
  for (const id of [...state.bots.keys()]) stop(id);
}

export function getEntry(botId) {
  return state.bots.get(botId) ?? null;
}

export { validateCredentials };

// ── Guards ───────────────────────────────────────────────────────────────────

// Token bucket, refilled continuously. Returns false when `key` has exhausted
// its allowance for the current window. Shared by the inbound limiter (keyed by
// bot + chat) and the relay limiter (keyed by channel).
function takeBucket(store, key, perMin) {
  const now = Date.now();
  const b = store.get(key) ?? { tokens: perMin, refilledAt: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.refilledAt) / 60_000) * perMin);
  b.refilledAt = now;
  store.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function takeToken(botId, chatKey) {
  return takeBucket(state.buckets, `${botId}:${chatKey}`, RATE_LIMIT_PER_MIN);
}

function takeRelayToken(channel, botId, chatKey) {
  return takeBucket(state.relayBuckets, `${channel}:${botId}:${chatKey}`, RELAY_RATE_PER_MIN);
}

// ── Turn runner ──────────────────────────────────────────────────────────────

// Render one ask's questions as chat text: numbered options with descriptions,
// multi-select guidance, and the reply contract. Presentation intents
// (plan-review) render as the generic list — the answer encoding is identical.
export function renderQuestionText(questions) {
  const lines = [];
  questions.forEach((q, i) => {
    if (questions.length > 1) lines.push(i === 0 ? "" : "", `问题 ${i + 1}：`);
    if (q.header) lines.push(`【${q.header}】`);
    if (q.detail) lines.push(String(q.detail));
    lines.push(String(q.question ?? ""));
    const options = Array.isArray(q.options) ? q.options : [];
    options.forEach((o, j) => {
      lines.push(`${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
    });
  });
  const first = questions[0] ?? {};
  const hasOptions = (Array.isArray(first.options) ? first.options.length : 0) > 0;
  lines.push(
    hasOptions
      ? `回复数字${first.multiSelect ? "（多选用逗号分隔）" : ""}或选项原文；回复“取消”结束问询`
      : "直接回复文字作答；回复“取消”结束问询",
  );
  return lines.filter((l) => l !== "").join("\n");
}

// Map one inbound reply onto the pending ask. Outcomes:
//   {kind:"cancel"}            — the user said the cancel word
//   {kind:"answers", answers}  — numbers/labels matched, or the text is the
//                                custom answer of free-text questions
//   {kind:"reprompt"}          — matched nothing answerable; re-prompt
// A pure-number list maps onto options (multi-number only on multiSelect);
// a leading "1. "/"1、" strip lets a copied render line match its label.
export function parseAnswer(text, questions) {
  const trimmed = String(text ?? "").trim();
  if (ASK_CANCEL_WORDS.has(trimmed.toLowerCase())) return { kind: "cancel" };
  const stripped = trimmed.replace(/^\d+\s*[.、)．]\s*/, "");
  const answers = [];
  for (const q of Array.isArray(questions) ? questions : []) {
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length === 0) continue;
    const nums = trimmed.split(/[\s,，、]+/).filter(Boolean);
    if (nums.length > 0 && nums.every((n) => /^\d+$/.test(n))) {
      const indexes = nums.map((n) => Number(n) - 1);
      if (indexes.every((i) => i >= 0 && i < options.length)) {
        const selected = indexes.map((i) => options[i].label);
        if (q.multiSelect === true || selected.length === 1) {
          answers.push({ id: q.id, selected });
          continue;
        }
      }
    }
    const byLabel = options.find((o) => o.label === stripped);
    if (byLabel) answers.push({ id: q.id, selected: [byLabel.label] });
  }
  if (answers.length > 0) return { kind: "answers", answers };
  // No option matched: free-text questions take the reply as the custom
  // answer (ALL of them — one reply answers one ask, not one question each).
  const freeText = (Array.isArray(questions) ? questions : []).filter(
    (q) => !Array.isArray(q.options) || q.options.length === 0,
  );
  if (freeText.length > 0 && trimmed) {
    return { kind: "answers", answers: freeText.map((q) => ({ id: q.id, selected: [], custom: trimmed })) };
  }
  return { kind: "reprompt" };
}

// Submit one intercepted reply against the chat's pending ask: resolve,
// re-prompt (bounded), or cancel. Failure-isolated sends, same as turn replies.
async function deliverAskAttempt(entry, text) {
  const { bot, adapter, chatKey } = entry;
  const reply = (body) =>
    adapter.sendText(bot.credentials, chatKey, body).catch((e) => {
      console.warn(`[bots] "${bot.name}" send failed: ${e.message}`);
    });
  const outcome = parseAnswer(text, entry.questions);
  if (outcome.kind === "cancel") {
    entry.resolve(true);
    await reply("已取消本次问询。");
    return;
  }
  if (outcome.kind === "answers") {
    entry.resolve(false, outcome.answers);
    return;
  }
  entry.attempts += 1;
  if (entry.attempts >= ASK_MAX_ATTEMPTS) {
    entry.resolve(true);
    await reply(`未能识别回答（${ASK_MAX_ATTEMPTS} 次尝试），已取消本次问询。`);
    return;
  }
  await reply(
    `未识别的回答，请回复数字或选项原文（还可尝试 ${ASK_MAX_ATTEMPTS - entry.attempts} 次）。\n${renderQuestionText(entry.questions)}`,
  );
}

// Strip reasoning markup that a model sometimes emits INSIDE a plain text block
// (prod 2026-10-29: a WeCom reply began literally with "<thinking>The user is
// asking me to…"). The clean path puts reasoning in its own `reasoning` block
// and the collector already drops those; this is the defensive net for models
// that fold the trace into text. Chat platforms have no collapsible UI, so any
// surviving trace is user-visible noise.



// Collect one turn's outcome off the session's notification stream. Registered
// BEFORE prompt() so no early event is missed; always unregistered. With
// {bot, adapter, chatKey} the collector also serves as this turn's ask
// surface (add-user-questions): a `userQuestion/ask` notification renders the
// question into the chat and registers the interception entry; the turn's
// hard timeout PAUSES while the human holds the floor and resumes with its
// remaining budget when the ask resolves.
function collectTurn(ctx, sessionId, { bot = null, adapter = null, chatKey = null } = {}) {
  let abortFn = null;
  const promise = new Promise((resolve, reject) => {
    let text = "";
    let error = null;
    let usedTools = false;
    let askEntry = null; // live while a question waits in this chat
    let deadlineAt = 0; // turn-timeout bookkeeping across ask pauses
    let timer = null;
    const settle = (fn, arg) => {
      clearTimeout(timer);
      // A turn ending with a question still waiting cannot happen in-child
      // (the ask parks the tool call), but a crashed child or a lost collector
      // can produce it — never leave an interception entry behind a dead turn.
      if (askEntry) {
        clearTimeout(askEntry.timer);
        state.pendingAsks.delete(sessionId);
        askEntry = null;
      }
      ctx.sessionCollectors.delete(sessionId);
      fn(arg);
    };
    const armTimeout = (ms) => {
      clearTimeout(timer);
      if (ms <= 0) return;
      deadlineAt = Date.now() + ms;
      timer = setTimeout(() => settle(reject, new Error("turn timed out")), ms);
    };
    armTimeout(TURN_TIMEOUT_MS);
    // Abandon path: if the caller bails (prompt() throws before the collector
    // is ever reached), settle now — otherwise the armed hard timeout fires
    // TURN_TIMEOUT_MS later into an unhandled rejection and the process hangs
    // the full window (boot-latch test, 2026-10-30: "turn timed out" at 180s).
    abortFn = () => settle(reject, new Error("turn aborted"));

    // Resolve the live ask (answer or cancel): unregister the interception
    // entry, resume the paused turn timeout with its remaining budget, and
    // submit to the runtime — the turn then continues to its own idle.
    const resolveAsk = (cancelled, answers = []) => {
      if (!askEntry) return;
      const entry = askEntry;
      askEntry = null;
      state.pendingAsks.delete(sessionId);
      clearTimeout(entry.timer);
      armTimeout(Math.max(0, deadlineAt - Date.now()));
      ctx.dshBridge?.answerUserQuestion
        ?.({ sessionId, askId: entry.askId, ...(cancelled ? { cancelled: true } : { answers }) })
        ?.catch((e) => console.warn(`[bots] "${bot?.name}" ask submit failed: ${e.message}`));
    };

    ctx.sessionCollectors.set(sessionId, (notif) => {
      const { method, params } = notif;
      if (method === "session.status" && params.status === "idle") {
        return settle(resolve, { text, error, usedTools });
      }
      if (method === "userQuestion/ask") {
        const askId = typeof params?.askId === "string" ? params.askId : null;
        const questions = Array.isArray(params?.questions) ? params.questions : [];
        if (!askId || !adapter || questions.length === 0) return;
        // Pause the hard timeout while the human holds the floor.
        clearTimeout(timer);
        askEntry = {
          bot,
          adapter,
          chatKey,
          askId,
          questions,
          attempts: 0,
          timer: null,
          resolve: resolveAsk,
        };
        state.pendingAsks.set(sessionId, askEntry);
        askEntry.timer = setTimeout(() => {
          // Wait window expired: cancel the ask; the turn continues normally.
          if (askEntry) {
            const notice = "等待超时，已取消本次问询。";
            resolveAsk(true);
            adapter
              .sendText(bot.credentials, chatKey, notice)
              .catch((e) => console.warn(`[bots] "${bot.name}" send failed: ${e.message}`));
          }
        }, ASK_WAIT_MS);
        adapter
          .sendText(bot.credentials, chatKey, renderQuestionText(questions))
          .then(() => console.log(`[bots] "${bot.name}" asked ${chatKey} a question (${questions.length} q)`))
          .catch((e) => console.warn(`[bots] "${bot.name}" send failed: ${e.message}`));
        return;
      }
      // LLM failure capture rides the bridge-forwarded stream lane's finish
      // frames (restore-assistant-stream-020 — the 0.2.0 session format
      // removed the assistant/chunk event this used to read).
      if (method === "platform/stream") {
        const chunk = params?.frame?.chunk;
        if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
          error = chunk.reason.failure?.message || "LLM request failed";
        }
        return;
      }
      if (method !== "session.event") return;
      const ev = params.event;
      if (ev?.type === "assistant/message") {
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
      } else if (ev?.type === "tool/call") {
        // The ask tool is the whitelisted exception (add-user-questions): a
        // turn that only asked must not count as tool-derived — its reply is
        // the user's own answer carried back.
        if (ev.data?.name !== "ask_user_question") usedTools = true;
      }
    });
  });
  // Exposed for the caller's bail path (prompt threw): settles the collector
  // so the hard timeout is disarmed and never surfaces as an unhandled reject.
  promise.abort = () => abortFn?.();
  return promise;
}

// ── Seen chats (relay destinations) ─────────────────────────────────────────
//
// The chat key only ever arrives with a message, and the dsh session id is a
// one-way hash of it — so without this record there is no way to enumerate (or
// bind) a destination. Recorded only after the platform's own verification and
// the size check, so unverified content still never reaches storage, and
// failure-isolated: a broken store must not cost the user their answer.
function recordChat(bot, botId, chatKey, senderName) {
  try {
    state.ctx?.db?.upsertBotChat(botId, chatKey, senderName);
  } catch (e) {
    console.warn(`[bots] "${bot.name}" could not record the chat: ${e.message}`);
  }
}

// Run one agent turn for an inbound message and deliver the reply. Turns within
// a chat are serialized (queued on the session id); different chats run in
// parallel. Every failure path still tries to tell the user something.
export async function handleMessage(botId, { chatKey, senderName, text }) {
  const entry = state.bots.get(botId);
  if (!entry || !entry.bot.enabled) return;
  const { bot } = entry;

  if (!text || text.length > MAX_MESSAGE_CHARS) {
    console.warn(`[bots] "${bot.name}" dropped an oversized/empty message from a chat`);
    return;
  }
  recordChat(bot, botId, chatKey, senderName);
  if (!takeToken(botId, chatKey)) {
    console.warn(`[bots] "${bot.name}" rate limit hit for a chat; message dropped`);
    return;
  }

  // Fleet event wake (add-fleet-event-wake): a declared event edge turns this
  // inbound message into a post's manual turn. Optional-chained — no fleet
  // face (or old deployment) means zero disturbance. The bot's own turn below
  // is untouched: the dual-turn is the edge owner's declared choice.
  try {
    const woken = state.ctx?.triggerFleetEventWake?.(botId, { chatKey, senderName, text });
    if (Array.isArray(woken) && woken.length) {
      console.log(`[bots] "${bot.name}" message woke ${woken.length} fleet post(s): ${woken.map((w) => w.memberId).join(",")}`);
    }
  } catch { /* the wake's own guard already logged; the chat turn proceeds */ }

  // Zhiyu IM bridge (add-zhiyu-im-bridge): a bound bot routes to the room
  // instead of founding a bot session. When the bridge declines (gate off,
  // outbound fetch failure), the legacy session path continues — the message
  // degrades honestly instead of vanishing.
  if (bot.zhiRoomId) {
    let bridged = false;
    try {
      state.ctx?.zhiyuImBridge?.noteInboundChat(bot.id, chatKey);
      bridged = Boolean(await state.ctx?.zhiyuImBridge?.handleInbound({ bot, chatKey, senderName, text }));
    } catch (err) {
      console.warn(`[bots] zhiyu-im-bridge erred for "${bot.name}": ${err.message}; legacy path continues`);
      bridged = false;
    }
    if (bridged) return;
  }

  const sessionId = sessionIdFor(botId, chatKey);
  // A question waiting in this chat? The message is its answer attempt, not a
  // new turn (add-user-questions). The guards above still applied — answering
  // an ask enjoys no size/rate exemption.
  const pendingAsk = state.pendingAsks.get(sessionId);
  if (pendingAsk) {
    void deliverAskAttempt(pendingAsk, text);
    return;
  }
  const tail = state.queues.get(sessionId) ?? Promise.resolve();
  const run = tail.then(() => runTurn(entry, sessionId, chatKey, text));
  // Keep the chain alive past a failed turn, and drop the entry once idle so
  // the map does not grow without bound across many chats.
  state.queues.set(
    sessionId,
    run.then(
      () => { if (state.queues.get(sessionId) === run) state.queues.delete(sessionId); },
      () => { if (state.queues.get(sessionId) === run) state.queues.delete(sessionId); },
    ),
  );
  return run;
}

// Mounted pack skill (pack-bot-units, spec pack-bot-units): a channel bot
// born from a pack may mount exactly one of the pack's own skills; the
// inbound turn is then answered through THAT skill's session — the skill's
// process and honesty constraints govern the answer, with no fleet involved.
// The skill body is read from the cell's skill store at turn time (fresh
// after pack upgrades) and injected as the session's opening context block;
// a missing/uninstalled skill degrades to the plain turn (logged).
function mountedSkillPreamble(bot) {
  const meta = packBotMeta(bot.credentials);
  const skillName = meta?.skill;
  if (!skillName) return null;
  let row = null;
  try {
    row = state.ctx?.db?.getCustomSkill?.(skillName) ?? null;
  } catch { /* a broken store must not cost the user their answer */ }
  if (!row?.content?.trim()) {
    console.warn(`[bots] "${bot.name}" mounted skill '${skillName}' is not available; answering without it`);
    return null;
  }
  return (
    `You are the bot "${bot.name}". The skill below governs this conversation: follow its process, ` +
    `workflow and honesty constraints when answering the user's messages.\n\n` +
    `# Mounted skill: ${row.name}\n\n${row.content.trim()}`
  );
}

async function runTurn({ bot, adapter }, sessionId, chatKey, text) {
  const ctx = state.ctx;
  const reply = async (body) => {
    const clean = stripReasoningLeak(body);
    if (!clean) {
      // Nothing but reasoning came back: answer honestly instead of sending a
      // bare "<thinking>…" wall to the chat platform.
      console.warn(`[bots] "${bot.name}" dropped a reasoning-only reply to ${chatKey}`);
      return replyRaw("Sorry — I could not put that answer into words. Please ask again.");
    }
    return replyRaw(clean);
  };
  const replyRaw = async (body) => {
    try { await adapter.sendText(bot.credentials, chatKey, body); }
    catch (e) { console.warn(`[bots] "${bot.name}" send failed: ${e.message}`); return; }
    // A SUCCESSFUL send is otherwise silent — "did the reply land" was
    // indistinguishable from "the turn never ran" (fd-prod 2026-10-29: the
    // WeCom loop looked dead for an hour while it was answering fine). Mirror
    // the inbound line's shape; same 60-char trim, same content policy.
    console.log(`[bots] "${bot.name}" replied to ${chatKey}: "${String(body).slice(0, 60)}"`);
  };
  if (!ctx?.dshBridge?.isReady()) return reply("The assistant is starting up. Please try again shortly.");

  const collected = collectTurn(ctx, sessionId, { bot, adapter, chatKey });
  const prompt = allowTools() ? text : NO_TOOLS_PREFIX + text;
  // A mounted pack skill rides as the session's opening context block; with
  // no mount the blocks are byte-identical to the pre-pack-bot form.
  const blocks = [];
  const skillPreamble = mountedSkillPreamble(bot);
  if (skillPreamble) blocks.push({ type: "text", text: skillPreamble });
  blocks.push({ type: "text", text: prompt });
  let result;
  // The streaming flag is what dsh-mcp-delivery's isStreaming() reads and what
  // bridge.exit's fan-out enumerates: the bot lane bypasses ctx.session.prompt
  // (which is what sets this flag for web turns), so without it a credential-
  // change restart sees "idle" and kills the runtime MID-TURN — the collector
  // then waits for a session.status idle that never comes and dies on the
  // 180s timeout (prod: every bot turn died this way).
  ctx.setStreaming?.(sessionId, true);
  try {
    await ctx.dshBridge.prompt(sessionId, blocks);
    result = await collected;
  } catch (e) {
    // Abandon the collector: a throw here (or a later unawaited timeout) must
    // not linger; abort disarms the hard timeout so it cannot fire into an
    // unhandled rejection after this function has already returned.
    if (typeof collected?.abort === "function") collected.abort();
    else ctx.sessionCollectors.delete(sessionId);
    collected?.catch?.(() => {});
    console.warn(`[bots] "${bot.name}" turn failed: ${e.message}`);
    return reply("Sorry — I could not complete that request.");
  } finally {
    ctx.setStreaming?.(sessionId, false);
  }

  if (result.error) return reply(`Sorry — ${result.error}`);
  if (result.usedTools && !allowTools()) {
    console.warn(`[bots] "${bot.name}" turn used tools under the no-tools posture; reply withheld`);
    return reply("Sorry — I cannot answer that from this channel.");
  }
  // Assistant final text only — never tool output or raw events (design D3.4).
  if (result.text) await reply(result.text);
}

// Proactive outbound send (admin-gated at the route).
export async function sendTo(botId, chatKey, text) {
  const entry = state.bots.get(botId);
  if (!entry) throw new Error("Bot not found or not running");
  await entry.adapter.sendText(entry.bot.credentials, chatKey, text);
}

// ── Relay: machine callers on a trusted network ──────────────────────────────
//
// Authentication lives in the route (server/routes/bot-relay.js); everything
// past it is destination resolution, guards, delivery, and audit. Delivery goes
// through the runtime entry's adapter — the same object the reply path uses —
// so platform token caches and any polling loop keep exactly one owner in this
// process (design D1). The caller names a channel; the destination is the
// admin's binding, so a leaked token can only reach approved chats.

// A bounded response for a machine caller. The adapter's fetch keeps running
// without an AbortSignal, so this bounds the wait, not the socket.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`send timed out after ${ms}ms`)), ms);
    }),
  ]);
}

// Platform errors quote the request URL, and for Telegram that URL *is* the
// credential (`/bot<token>/sendMessage`); WeCom/WeChat put an access token in a
// query string. Both the HTTP answer and the audit row go through this, so a
// failed send never republishes the bot's credentials.
function redactCredentials(message, credentials) {
  let out = String(message ?? "");
  for (const value of Object.values(credentials ?? {})) {
    const secret = String(value ?? "");
    if (secret.length >= 6) out = out.split(secret).join("***");
  }
  return out;
}

// Returns { ok: true } or { ok: false, reason, error }, with `reason` a stable
// token the route maps to an HTTP status. Every attempt past authentication
// writes exactly one audit row — length, never text.
export async function relaySend(channel, rawText) {
  const db = state.ctx?.db;
  const text = String(rawText ?? "");
  const chars = text.length;
  const audit = (outcome, botId, error) => {
    try {
      db?.insertRelayLog({ channel, botId, textChars: chars, outcome, error });
    } catch (e) {
      console.warn(`[bots] relay audit write failed: ${e.message}`);
    }
  };

  if (!db?.isDbReady()) {
    console.warn("[bots] relay send refused: database unavailable");
    return { ok: false, reason: "unavailable" };
  }

  const binding = db.getChannel(channel);
  if (!binding) {
    audit("rejected", null, "unknown channel");
    return { ok: false, reason: "unknown-channel" };
  }

  // Deliberately stricter than the admin endpoint (design D7): the relay is
  // network-reachable, so a disabled bot means the channel is out of service.
  const bot = db.getBot(binding.botId);
  if (!bot || !bot.enabled) {
    audit("rejected", binding.botId, "bot missing or disabled");
    return { ok: false, reason: "bot-unavailable" };
  }

  if (!text || chars > MAX_RELAY_CHARS) {
    audit("rejected", bot.id, text ? "text over the relay cap" : "empty text");
    return { ok: false, reason: "too-long" };
  }

  if (!takeRelayToken(binding.name, bot.id, binding.chatKey)) {
    audit("rejected", bot.id, "channel rate limit");
    return { ok: false, reason: "rate-limited" };
  }

  const entry = state.bots.get(bot.id);
  if (!entry) {
    audit("rejected", bot.id, "no runtime entry for the bot");
    return { ok: false, reason: "bot-unavailable" };
  }

  try {
    await withTimeout(
      entry.adapter.sendText(bot.credentials, binding.chatKey, text),
      RELAY_SEND_TIMEOUT_MS,
    );
  } catch (err) {
    const error = redactCredentials(err.message, bot.credentials);
    audit("failed", bot.id, error);
    return { ok: false, reason: "send-failed", error };
  }
  audit("sent", bot.id, null);
  return { ok: true };
}
