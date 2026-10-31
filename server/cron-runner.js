// Cron turn executor: the host half of the cron engine (cron.js owns timers,
// persistence and history; this module owns what "run the job" means on a
// live cell). One invocation = one agent turn in the job's bound session:
//
//   wait for idle → switch the runtime to the job's preset → create/record
//   the bound session → prompt it under a session collector → persist the
//   exchange → refresh the sessions broadcast.
//
// The collector pattern is the bot-relay one (server/bots.js collectTurn):
// notifications for a session other than the live one are routed to its
// registered collector and never hit the web broadcast path — that is what
// keeps a scheduled turn out of the user's open transcript while still
// recording it under the job's session for later reading.

import * as chatHistory from "../chat-history.js";
import * as catalog from "../catalog.js";
import * as dshProfile from "../dsh-profile.js";
import { parseToolResult } from "./dsh-events.js";
import { getClusterDatabase } from "./routes/clusters-db.js";
import { runA2aTurn, resolveGatewayCredential } from "./a2a-client.js";
import { clusterMemoryFor, memoryInjectionFor } from "./cluster-memory.js";
import { runToolTurn as runToolTurnDefault } from "./tool-turn.js";
import { classifyErrorKind } from "./fleet-events.js";
import { breakerState, recordUpstreamFailure, recordUpstreamSuccess } from "./llm-lane.js";
import { classifyPresetSetError } from "../dsh-bridge.js";
import { getFleetDatabase } from "./routes/fleets-db.js";

// ── Turn carrier (add-fleet-carrier) ─────────────────────────────────────────
//
// The placement dimension, resolved per turn: member.carrier → fleet
// constraints.carrier → CELL_CARRIER_DEFAULT → "auto". Two small sqlite reads
// (local db, µs) — no cache to drift. Exported for tests (the db is injectable).
export function resolveTaskCarrier(job, { db = null } = {}) {
  const wanted = String(job?.carrier ?? "").trim();
  if (wanted === "cell" || wanted === "worker" || wanted === "runner") return wanted;
  const fleetId = job?.sourceTag?.fleetId ?? null;
  if (fleetId) {
    try {
      const fdb = db ?? getFleetDatabase();
      // member layer (the live row — covers the reconcile drift window where
      // the task still carries the old materialized value)
      const member = fdb?.getMember?.(job?.sourceTag?.memberId);
      if (["cell", "worker", "runner"].includes(member?.carrier)) return member.carrier;
      const fleet = fdb?.getFleet?.(fleetId);
      const fc = fleet?.orchestration?.constraints?.carrier;
      if (fc === "cell" || fc === "worker" || fc === "runner") return fc;
    } catch { /* degrade to auto */ }
  }
  const envDefault = String(process.env.CELL_CARRIER_DEFAULT ?? "").trim();
  if (envDefault === "cell" || envDefault === "worker" || envDefault === "runner") return envDefault;
  return "auto";
}

// The runner route (add-fleet-carrier D2): a runner-deployed persona appears
// in the catalog as an a2a entry whose roster preset matches the task's. Found
// → the remote executor with the entry's agent id; not found → null (the
// caller fails open to the primary chain with a recorded reason).
export function runnerEntryFor(job, { listAgents = null, rosterPresetId = null } = {}) {
  if (!job?.preset) return null;
  const agents = (listAgents ?? catalog.listAgents)();
  const roster = rosterPresetId ?? dshProfile.rosterPresetId;
  return agents.find((a) => a?.mode === "a2a" && roster(a.id) === job.preset) ?? null;
}

const IDLE_POLL_MS = 250;
// Monotonic round sequence (unique rotated child ids even within one ms).
let roundSeqCounter = 0;
const PRESET_SWITCH_ATTEMPTS = 3;
// Fleet rounds wait this long for a cold cell's dsh child to finish booting
// (2026-10-25 live: a daily patrol fired 17s after platform start and failed
// `runtime_not_ready`; nothing retried, so that day's patrol was simply lost).
const RUNTIME_READY_WAIT_MS = 120_000;
// Deployment override (fix-fleet-turn-veracity design: grey-rollback valve).
// `FLEET_TURN_READY_WAIT_MS=0` restores the pre-e3396 immediate refusal.
function readyWaitMs() {
  const n = Number(process.env.FLEET_TURN_READY_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : RUNTIME_READY_WAIT_MS;
}
const RUNTIME_READY_POLL_MS = 1_000;

// Resolve when the live web turn finishes (ctx.isStreaming drops). The engine
// queued this job; "skip because busy" is not an option, so busy means wait.
// Exported for the delegation aggregator — the same never-overlap-a-live-turn
// contract governs the summary injection.
export function waitForIdle(ctx, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (!ctx.isStreaming) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for the live turn to finish"));
      setTimeout(tick, IDLE_POLL_MS);
    };
    tick();
  });
}

// Collect one turn's outcome for a non-live session, persisting it under that
// session as it streams. Registered BEFORE prompt() so no early event is
// missed; always unregistered. `activeTurns` is the abort registry; the
// optional `collectors` map defaults to the cell's shared registry — the
// worker pool passes a worker-local map so worker events never reach the web
// broadcast path. `mirrorSessionId` decouples the collector key from the
// mirror row id (fix-fleet-round-discipline D4): the collector key MUST equal
// the session id the child was prompted with (notifications route by it),
// while the mirror rows land under the stable host session — the fleet round
// rotation prompts the child under a per-round id and mirrors into `cron-<id>`.
// Exported for the delegation aggregator and the worker pool.
export function collectTurn(ctx, sessionId, timeoutMs, activeTurns, collectors = ctx.sessionCollectors, mirrorSessionId = sessionId) {
  const collected = new Promise((resolve, reject) => {
    let text = "";
    let error = null;
    let usage = null;
    const toolBlocks = [];
    const settle = (fn, arg) => {
      clearTimeout(timer);
      collectors.delete(sessionId);
      activeTurns.delete(sessionId);
      // This lane's turn just closed — the shared child may be free now
      // (concurrent-chat-sessions D2). A collector is the ONLY trace a non-web
      // turn leaves, so this is the signal a queued web prompt drains on.
      ctx.onRuntimeIdle?.();
      fn(arg);
    };
    const startedAtMs = Date.now();
    // Turn metering (add-turn-metering): the first assistant event's absolute
    // timestamp — ttft_ms derives from it at the executor. Absent on a
    // zero-output turn (honest NULL, never a 0).
    let firstAssistantAt = null;
    const timer = setTimeout(
      () => settle(reject, timeoutError(toolBlocks, startedAtMs)),
      timeoutMs,
    );
    activeTurns.set(sessionId, (reason) => {
      // A bridge abort (runtime restart mid-turn) is an interruption, not a
      // failure: the engine marks the execution `interrupted` instead of
      // `failed` so the UI offers re-run, not an error report.
      const err = new Error(reason);
      err.interrupted = true;
      settle(reject, err);
    });

    collectors.set(sessionId, (notif) => {
      // Run ledger trace tap (agent-fleet-runs D4): a fleet turn never crosses
      // handleDshEvent — this collector is its only observer — so the trace
      // store is fed from here, keyed by the ledger's turn id. No-op for
      // non-fleet turns and when the tap is off.
      ctx.fleetTurnLedger?.tap?.(notif, sessionId, mirrorSessionId);
      const { method, params } = notif;
      if (method === "session.status" && params.status === "idle") {
        return settle(resolve, { text, error, usage, firstAssistantAt });
      }
      // A user-questions ask in an unattended session (scheduled task or
      // worker slot — both use this collector) has no human to answer it:
      // cancel immediately so the model continues with a cancelled result
      // instead of parking on the child's fallback window. The serialized
      // task queue must not wait 15 minutes for a timeout nobody will answer.
      if (method === "userQuestion/ask" && params?.askId) {
        ctx.dshBridge?.answerUserQuestion
          ?.({ sessionId: params.sessionId, askId: params.askId, cancelled: true })
          ?.catch(() => {});
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
      if (!ev) return;
      if (ev.type === "assistant/message") {
        // Turn metering: the FIRST assistant event is the time-to-first-token
        // anchor (subsequent steps update usage, not the anchor).
        firstAssistantAt ??= Date.now();
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
        // Token spend when the runtime reports usage (absent on some
        // providers). dsh attaches TokenUsage to assistant/message, one per
        // step — keep the last (the honest live context size). The whole
        // TokenUsage rides: the metering columns read cacheReadTokens /
        // cacheWriteTokens / reasoningTokens off it (add-turn-metering D4).
        if (ev.data?.usage) usage = ev.data.usage;
        // Mirror the final message into SQLite WITH the tool-call blocks, the
        // same structure the web path persists — a reloaded job session
        // rebuilds the same evidence trail as a live one. Rows land under the
        // stable mirror session even when the collector key is a rotated
        // per-round child id (fix-fleet-round-discipline D4).
        const persistBlocks = [...toolBlocks, ...(text ? [{ kind: "text", text }] : [])];
        if (text || toolBlocks.length) {
          chatHistory.recordMessage(mirrorSessionId, "assistant", text, persistBlocks);
        }
      } else if (ev.type === "tool/call") {
        toolBlocks.push({
          kind: "tool",
          id: ev.data.callId,
          name: ev.data.name,
          args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
          // fix-fleet-turn-attribution D1: the timeout summary needs WHEN a
          // call started and whether it ever returned — two fields now, so a
          // stalled call is distinguishable from a budget that simply ran out.
          at: Date.now(),
        });
      } else if (ev.type === "tool/result") {
        const { callId, resultText } = parseToolResult(ev);
        const acc = toolBlocks.find((b) => b.id === callId);
        if (acc) {
          acc.result = resultText;
          acc.resultAt = Date.now();
        }
      }
    });
  });
  // The abort path (a bridge restart mid-turn) rejects this promise for EVERY
  // registered collector, and a caller whose `await prompt()` threw into its
  // own catch never reaches `await collected` — under node ≥15 an unhandled
  // rejection kills the host process, so a single preset switch could take the
  // whole cell down (observed: the e2e server died mid-suite exactly this
  // way). A second no-op consumer marks the rejection handled without
  // disturbing the real one: consumers still await `collected` and read the
  // interruption there.
  collected.catch(() => {});
  return collected;
}

// Timeout attribution (fix-fleet-turn-attribution D1): the collector's
// closure knows what the turn was doing when the budget ran out — the reject
// just never said so. A call still awaiting its result reads `stalled` (fix
// the tool); all calls returned and the steps simply ran out reads
// `turn_budget_exceeded` (raise the budget or shorten the work). A turn with
// no tool history at all summarizes honestly empty — the model may have been
// thinking, and an invented tool name would misdirect triage.
export function timeoutError(toolBlocks, startedAtMs, now = Date.now()) {
  const err = new Error("turn timed out");
  const pending = [...toolBlocks].reverse().find((b) => b.result === undefined);
  err.detail = pending
    ? {
        kind: "stalled",
        steps: toolBlocks.length,
        lastTool: pending.name ?? null,
        lastToolWaitedMs: Math.max(0, now - (pending.at ?? startedAtMs)),
      }
    : {
        kind: "turn_budget_exceeded",
        steps: toolBlocks.length,
        lastTool: toolBlocks.length ? toolBlocks[toolBlocks.length - 1].name ?? null : null,
      };
  return err;
}

async function switchPresetForJob(ctx, preset, timeoutMs) {
  // spinMs (add-turn-metering D2): the persona-acquisition cost — the measured
  // wall time of the switch itself, EXCLUDING the idle wait (queue discipline
  // is not restart tax; counting both would double-bill the wait). Last
  // attempt wins; the equality short-circuit reports 0 (nothing to acquire).
  let spinMs = 0;
  for (let attempt = 0; attempt < PRESET_SWITCH_ATTEMPTS; attempt++) {
    await waitForIdle(ctx, timeoutMs);
    if (preset === ctx.currentPreset) return { ok: true, spinMs };
    // switchPresetTo already serializes through runExclusiveRuntimeMutation
    // (server/agent-session.js) — wrapping it again would nest the chain and
    // deadlock. It restarts the bridge, persists the preference and
    // broadcasts current_preset + agent_changed — clients learn the runtime
    // now runs the job's agent.
    const switchT0 = Date.now();
    const r = await ctx.switchPresetTo(preset);
    spinMs = Date.now() - switchT0;
    if (r?.ok) return { ...r, spinMs };
    // A streaming user turn started between the idle wait and the switch —
    // loop and wait again rather than failing the run.
    if (!ctx.isStreaming) return { ...(r ?? {}), spinMs };
  }
  return { ok: false, error: "could not switch the agent for the scheduled task (runtime stayed busy)", spinMs };
}

// ── Per-session persona parking (add-cell-session-persona) ──────────────────
//
// The scheduled lane's persona turns park the turn's preset onto THIS turn's
// child conversation id before its first prompt — the session composes it at
// lazy creation/resume (platform-preset-bridge parked semantics) and the
// runtime's deployment default is never touched. The restart ladder
// (switchPresetForJob above) remains as the EXPLICIT fallback for: an older
// child without preset/set, a live session whose composition mismatches (park
// refused by contract), or a park hard-error. Fallbacks are recorded, never
// silent (spec: cron-module「定时回合的 persona 组合按会话驻留」）.
//
// Returns { legacy: null } when parked (or already parked with the same
// preset this generation), { legacy: reason } when the caller must take the
// byte-parity restart path.
async function parkPersonaForTurn(ctx, preset, childSessionId) {
  const bridge = ctx.dshBridge;
  if (!bridge || typeof bridge.hasLiveMethod !== "function" || !bridge.hasLiveMethod("preset/set")) {
    return { legacy: "preset/set unsupported by this child" };
  }
  if (typeof bridge.setPreset !== "function") {
    return { legacy: "bridge predates preset/set parking" };
  }
  if (typeof bridge.preparedPreset === "function" && bridge.preparedPreset(childSessionId) === preset) {
    // Already parked with the same preset on THIS child generation — the
    // composition is settled; prompting resumes it as-is.
    return { legacy: null, already: true };
  }
  try {
    await bridge.setPreset({ sessionId: childSessionId, presetId: preset });
    return { legacy: null };
  } catch (err) {
    const cls = classifyPresetSetError(err);
    if (cls.refused) return { legacy: "live session composition mismatch (park refused)" };
    return { legacy: `park failed: ${cls.error.message}` };
  }
}

// Stamp the turn's preset path onto an outcome's detail — the observability
// face of the fallback contract (detail.presetPath: "parked" |
// "legacy:<reason>").
function withPresetPath(result, presetPath) {
  if (!presetPath) return result;
  return { ...result, detail: { ...(result.detail ?? {}), presetPath } };
}

// Post-model normalization (add-fleet-post-model D1/D2/D5): the exact mirror
// of the preset normalization above — every persona turn LANDS the runtime on
// the resolution chain's first roster hit instead of riding whatever the
// previous turn (fleet or the user's chat) left behind. Fallback happens at
// selection time only: resolution already roster-filtered the candidates, the
// loop walks past a hop only if the roster drifted between the read and the
// switch. No candidates at all → honest failure, no invented model.
async function normalizeModelForJob(ctx, preset) {
  const plan = (await ctx.resolveFleetModel?.(preset)) ?? null;
  // Not a fleet post (plain cron task or a persona holding no post): the turn
  // runs on the current model, byte-for-byte the pre-change behavior.
  if (!plan) return { ok: true };
  const notices = [...plan.notices];
  let landed = null;
  // fix-fleet-model-drift: a post with an explicit chain cannot trust the
  // session ledger's early return — the child can be holding a model some
  // other lane wrote. Force the assertion every round; chain-less posts keep
  // the cheap path unchanged.
  const assertSoft = process.env.FLEET_MODEL_ASSERT_SOFT === "1";
  const force = plan.explicitChain === true && !assertSoft;
  for (const hop of plan.candidates) {
    const r = await ctx.switchModelTo(hop.model, force ? { force: true } : undefined);
    if (r?.ok) {
      landed = hop.model;
      break;
    }
    notices.push(`model switch to '${hop.model}' failed: ${r?.error || "unknown error"}`);
  }
  if (!landed) {
    return {
      ok: false,
      error: `no runnable model for this post (${notices.length ? notices.join("; ") : "no model declared and no default available"})`,
    };
  }
  // fix-fleet-turn-attribution D5: the retry loop walks the SAME candidates
  // from where selection landed — the chain's order IS the degrade order.
  const landedIndex = plan.candidates.findIndex((hop) => hop.model === landed);
  if (notices.length) {
    console.warn(`[fleets] post model fallback for ${plan.memberId}: ${notices.join("; ")}`);
    ctx.recordFleetModelNotices?.(plan.memberId, notices);
  } else {
    ctx.recordFleetModelNotices?.(plan.memberId, []);
  }
  // Thinking depth (add-agent-config-dims D1): applied per turn through the
  // LIVE model/set path — no child restart. Same-value switches are skipped
  // (the runtime is already there). A failed effort switch degrades open: the
  // turn runs on whatever level is live rather than failing over a knob.
  const effortNotices = [...(plan.effortNotices ?? [])];
  if (plan.effort && plan.effort !== (ctx.currentEffort ?? null)) {
    try {
      const r = await ctx.switchEffortTo?.(plan.effort);
      if (r && r.ok === false) effortNotices.push(`thinking level switch to '${plan.effort}' failed: ${r.error ?? "unknown error"}`);
    } catch (e) {
      effortNotices.push(`thinking level switch to '${plan.effort}' failed: ${e?.message || e}`);
    }
  }
  if (effortNotices.length) console.warn(`[fleets] post config for ${plan.memberId}: ${effortNotices.join("; ")}`);
  return {
    ok: true,
    effort: plan.effort ?? null,
    effortNotices,
    contextBudget: plan.contextBudget ?? null,
    candidates: plan.candidates.map((hop) => hop.model),
    landedIndex,
    landed,
  };
}

// ── Member executors ─────────────────────────────────────────────────────────
//
// The two turn shapes a scheduled task (or a cluster fan-out member) can run.
// Both record their exchange in the job's session and return
// { ok, error?, interrupted?, usage?, text? } — `text` is the collected
// assistant reply, consumed only by the cluster aggregation.

// a2a targets (add-agent-delegation-a2a D2): a REMOTE turn — no runtime
// readiness, no preset switch, no dsh prompt. The streamed reply lands in the
// task's dedicated session exactly like a persona execution's output;
// outbound depth is 1 (human-originated delegation baseline — chains get
// +1 only when in-cell turns are themselves delegated, a future state).
async function runA2aRemoteTurn(ctx, job, timeoutMs) {
  const entry = catalog.getAgentEntry(job.preset);
  if (!entry || entry.mode !== "a2a") {
    return { ok: false, error: `market agent '${job.preset}' is not in the catalog (or not a2a)` };
  }
  const sessionId = job.sessionId || `task-${job.id}`;
  chatHistory.recordMessage(sessionId, "user", job.prompt);
  if (job.sessionTitle) {
    try { chatHistory.setTitle(sessionId, job.sessionTitle); } catch { /* prompt-derived title stays */ }
  }
  try {
    const { gatewayToken } = resolveGatewayCredential({
      ownerEmail: ctx.cellUserEmail || null,
      cloudMode: !!ctx.CLOUD_MODE,
    });
    const agentToken = process.env.AGENT_SERVING_BACKEND_TOKEN || "";
    const out = await runA2aTurn(entry.url, job.prompt, {
      contextId: sessionId,
      depth: 1,
      gatewayToken,
      agentToken,
      timeoutMs,
    });
    if (out.text) chatHistory.recordMessage(sessionId, "assistant", out.text);
    ctx.sessionCollectors.delete(sessionId);
    const version = ctx.sessionVersion;
    chatHistory
      .listSessions()
      .then((sessions) => {
        if (version === ctx.sessionVersion) {
          ctx.broadcast({ type: "sessions", sessions: ctx.withTurnStatus?.(sessions) ?? sessions, current: chatHistory.currentSessionId() });
        }
      })
      .catch(() => {});
    // Turn metering (add-turn-metering D3): a2a runs on the REMOTE executor —
    // the enqueue default already says remote for a2a targets, but the executor
    // states it anyway (the claimant/executor rule), and a2a has no persona
    // acquisition (no spin) and no collected stream (no ttft).
    return {
      ok: true, usage: null, text: out.text ?? null,
      metering: {
        carrier: "remote", carrierInstance: null,
        queueWaitMs: job.queuedAt != null ? Math.max(0, Date.now() - job.queuedAt) : null,
      },
    };
  } catch (e) {
    ctx.sessionCollectors.delete(sessionId);
    return {
      ok: false, error: e.message,
      metering: {
        carrier: "remote", carrierInstance: null,
        queueWaitMs: job.queuedAt != null ? Math.max(0, Date.now() - job.queuedAt) : null,
      },
    };
  }
}

// Round-scoped child conversation disposal (fix-fleet-round-discipline D5):
// best-effort — dsh-bridge.deleteSession already swallows its own failures
// (old runtimes have no session/delete RPC); this never throws and never
// affects the next round, which runs on a fresh rotated id regardless.
async function disposeRoundChild(ctx, childSessionId, mirrorSessionId) {
  if (childSessionId === mirrorSessionId) return;
  try {
    await ctx.dshBridge?.deleteSession?.(childSessionId);
  } catch { /* best-effort: the id is never resumed either way */ }
}

// Fleet round statelessness (fix-fleet-round-discipline D4/D7): the design
// re-renders {{fleetContext}} every round — history contributes nothing —
// yet the dsh child resumes its persisted conversation by session id, so a
// stable id accumulated every round's history (2.3MB in 5 rounds; the
// compaction ate the 600s budget before any work started). The child
// conversation id therefore ROTATES per round; the mirror keeps the stable
// id (collectTurn's mirrorSessionId) so the sidebar stays one readable
// session and the evidence trail keeps accumulating. Non-fleet jobs keep
// the byte-for-byte pre-change shape: the child id IS the mirror id.
// One formula, two readers: runPersonaTurn prompts under it, the run ledger
// registers it (so the collector tap can find the turn by that key).
//
// `seq` breaks the same-millisecond tie. Timestamps alone collide whenever two
// rounds of one post start inside the same ms (retry storms, catch-up racing a
// scheduled fire) — and a colliding id would silently resume the very history
// the rotation exists to drop. The engine's own execution counter rides in, so
// the id is unique per execution without any extra bookkeeping.
export function roundChildSessionId(job, startedAt, seq = 0) {
  const sessionId = job.sessionId || `cron-${job.id}`;
  if (!job.sourceTag?.fleetId) return sessionId;
  return `${sessionId}#r${startedAt}${seq ? `-${seq}` : ""}`;
}


// fix-fleet-model-drift: model-not-available upstream rejection — the child's
// persisted session can carry a model no lane wrote recently (out-of-band
// compaction/agent-team). When that signature shows up the fleet post SHOULD
// re-assert its declared model with force, not walk the degrade chain.
export function isModelUnavailableError(text) {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  return /model_not_available|INVALID_MODEL|cannot find model|no available model|model unavailable/i.test(s);
}

// Fleet rounds land on cold cells: the platform boots its dsh child in the
// background, so a 09:00 cron can fire before the runtime is ready. Waiting
// is bounded and fleet-only — ordinary cron keeps the immediate refusal.
// Exported so the gate itself is testable without a live dsh bridge.
export async function awaitRuntimeReadyForJob(ctx, job, {
  waitMs = readyWaitMs(),
  pollMs = RUNTIME_READY_POLL_MS,
  now = () => Date.now(),
} = {}) {
  if (ctx.dshBridge?.isReady()) return { ok: true };
  if (!job.sourceTag?.fleetId) {
    return { ok: false, error: "the agent runtime is not ready" };
  }
  const deadline = now() + waitMs;
  while (!ctx.dshBridge?.isReady() && now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!ctx.dshBridge?.isReady()) {
    return { ok: false, error: "the agent runtime is not ready (waited for fleet round)" };
  }
  return { ok: true };
}

async function runPersonaTurn(ctx, job, timeoutMs, activeTurns, { startedAt = Date.now() } = {}) {
  let contextBudget = null;
  // Unattended fleet rounds land on cold cells: the platform boots its dsh
  // child in the background, so a 09:00 cron can fire before the runtime is
  // ready and the whole patrol is lost (2026-10-25 live: one daily patrol
  // failed `runtime_not_ready` and nothing retried).
  const ready = await awaitRuntimeReadyForJob(ctx, job);
  if (!ready.ok) return ready;


  const sessionId = job.sessionId || `cron-${job.id}`;
  // The park target must exist BEFORE the preset decision (add-cell-session-
  // persona): the persona is parked onto THIS turn's child conversation id —
  // fleet rounds rotate it per round, plain bound-session tasks reuse the
  // mirror id. Pure function; hoisting it is observationally identical.
  const childSessionId = roundChildSessionId(job, startedAt, job.roundSeq ?? 0);

  // preset binding: a job without one (legacy record) runs under whatever
  // preset is live, matching its pre-change behavior.
  //
  // Park path (default when the child declares preset/set): park the turn's
  // preset onto the child conversation id — no restart, and the runtime's
  // deployment default is never moved. Legacy path (explicit fallback):
  // byte-for-byte the pre-change behavior. `releaseReservation` is taken
  // BEFORE the legacy switch only: it restarts the child, and bridge.ready
  // drains the web queue (concurrent-chat-sessions D2) — without the
  // reservation a queued web prompt would be dispatched into that restart.
  // The idle wait is shared discipline on BOTH paths (a scheduled turn never
  // interleaves a streaming user turn — turn close is process-serialized, so
  // starting a fleet round mid-chat would starve the user's close); the
  // legacy path's wait lives inside switchPresetForJob.
  let releaseReservation = null;
  // Hoisted for the lane pre-check and the retry walk below: a legacy job
  // without a preset never normalizes, and its turn runs on whatever is live.
  let modeled = null;
  // The preset path this turn took — "parked" | "legacy:<reason>" | null
  // (no-preset legacy record). Rides the outcome detail.
  let presetPath = null;
  // Turn metering (add-turn-metering): the persona-acquisition cost. Park
  // path = 0 (no restart — the slice-① win, measured); legacy = the measured
  // switch; a no-preset job never acquires a persona (honest absence).
  let spinUpMs = null;
  if (job.preset) {
    const park = await parkPersonaForTurn(ctx, job.preset, childSessionId);
    if (park.legacy) {
      presetPath = `legacy:${park.legacy}`;
      console.warn(`[cron-runner] preset park fell back to restart for ${job.id}: ${park.legacy}`);
      releaseReservation = ctx.reserveRuntime?.("cron-preset-switch") ?? null;
      const switched = await switchPresetForJob(ctx, job.preset, timeoutMs);
      spinUpMs = switched.spinMs ?? null;
      if (!switched.ok) {
        releaseReservation?.();
        return withPresetPath(switched, presetPath);
      }
    } else {
      presetPath = "parked";
      spinUpMs = 0;
      try {
        await waitForIdle(ctx, timeoutMs);
      } catch (err) {
        return withPresetPath({ ok: false, error: err.message }, presetPath);
      }
    }
    // Post model (add-fleet-post-model F2): normalize AFTER the preset lands —
    // the two switches short-circuit independently, so a same-persona model
    // change is never swallowed, and switchModelTo's live path flips the model
    // without a second restart when the bridge declares model/set.
    modeled = await normalizeModelForJob(ctx, job.preset);
    if (!modeled.ok) {
      releaseReservation?.();
      return withPresetPath(modeled, presetPath);
    }
    // Carry the post's context budget to the settlement seam (add-agent-config-dims):
    // the budget is a property of THIS turn's post, so it rides the turn result.
    if (Number.isFinite(modeled.contextBudget)) contextBudget = modeled.contextBudget;
  }

  // Turn metering (add-turn-metering D3): assembled once, attached to every
  // outcome this turn produces. carrier/carrierInstance come from the
  // execution-carrier mark (enqueue default or worker claim) — the executor
  // never invents them; queue_wait measures the enqueue→dequeue window;
  // provider resolves the LANDED model against the live roster (NULL when
  // unknown — never a guess). ttft rides per-attempt (only a real attempt
  // has one).
  const metering = {
    carrier: job.executionCarrier?.carrier ?? "cell",
    carrierInstance: job.executionCarrier?.instance ?? null,
    queueWaitMs: job.queuedAt != null ? Math.max(0, startedAt - job.queuedAt) : null,
    ...(job.preset ? { spinUpMs } : {}),
    ...(modeled?.landed ? { provider: (ctx.dshModels ?? []).find((m) => m.id === modeled.landed)?.provider ?? null } : {}),
    ...(modeled?.effort ? { effort: modeled.effort } : {}),
  };

  // Fleet post identity (enable-wire-content-fleet D1): a member turn tells the
  // agent which post it executes, so it can name its own production source
  // rather than invent one. This seam serves BOTH wake paths — cron cadence
  // fires and delegation wakes both land here — which is why identity rides the
  // prompt instead of a {{...}} template placeholder (passive posts carry no
  // placeholder at all). Null for non-member turns: prompt stays byte-for-byte.
  // The turn segment (add-fleet-identity-turn) completes the deploy/post/round
  // triple with THIS round's landed child id — cadence rounds rotate it,
  // manual dispatches carry their session id; it is the same value the prompt
  // is dispatched under, so the ledger and the recited source_ref agree.
  const identity = ctx.resolveFleetIdentity?.(job.preset, { turn: childSessionId }) ?? null;
  const prompt = identity ? `${identity}\n\n${job.prompt}` : job.prompt;

  // The bound session is a normal session: the user can open it, and rows
  // stamped here pick up the (just-switched) preset as their creation fact.
  chatHistory.recordMessage(sessionId, "user", prompt);
  if (job.sessionTitle) {
    try {
      chatHistory.setTitle(sessionId, job.sessionTitle);
    } catch { /* sanitize failure leaves the prompt-derived title */ }
  }

  // Lane breaker pre-check (fix-fleet-turn-attribution D3/D6): judged AFTER
  // model normalization — that is the first point where the lane this turn
  // would use is known. An open lane skips the round rather than feeding it
  // to a wall (the wall counts failures; the skip does not).
  const laneId = typeof ctx.llmLaneForModel === "function" ? ctx.llmLaneForModel(modeled?.landed ?? ctx.session?.model?.id ?? null) : null;
  if (laneId) {
    const br = breakerState(laneId);
    if (br.open) {
      releaseReservation?.();
      return withPresetPath({
        ok: false,
        skipped: true,
        error: `llm lane ${laneId} open until ${new Date(br.openUntil).toISOString()} — round skipped (${br.failures}/${br.threshold} upstream failures in window)`,
        metering,
      }, presetPath);
    }
  }

  // fix-fleet-turn-attribution D5: prompt+collect extracted so the candidate
  // walk can retry ONCE on a fast upstream failure. Everything per-attempt is
  // inside; the breaker/ledger/handoffs stay at the seam, once per turn. The
  // model value is pre-positioned into the runtime before each attempt — the
  // param rides for call-site documentation only.
  const attempt = async (_attemptModel) => {
    const collected = collectTurn(ctx, childSessionId, timeoutMs, activeTurns, ctx.sessionCollectors, sessionId);
    // The collector is now the visible trace of this turn — hand the runtime
    // over to it and drop the preset-switch reservation.
    releaseReservation?.();
    try {
      await ctx.dshBridge.prompt(childSessionId, [{ type: "text", text: prompt }]);
      const out = await collected;
      // ttft (add-turn-metering): first assistant event − attempt start. The
      // attempt START is the prompt call's wall clock, not the seam's
      // startedAt (model-normalize time is not latency to first token).
      const ttftMs = out?.firstAssistantAt != null ? Math.max(0, out.firstAssistantAt - promptT0) : null;
      return { ok: true, ...out, metering: { ...metering, ...(ttftMs != null ? { ttftMs } : {}) } };
    } catch (e) {
      ctx.sessionCollectors.delete(childSessionId);
      activeTurns.delete(childSessionId);
      ctx.onRuntimeIdle?.();
      return { ok: false, error: e.message, interrupted: e.interrupted === true, detail: e.detail ?? null, metering };
    }
  };

  const candidates = modeled?.candidates ?? null;
  const landedIndex = Number.isInteger(modeled?.landedIndex) ? modeled.landedIndex : 0;
  const promptT0 = Date.now();
  const startedWall = Date.now();
  let result = await attempt(modeled?.landed ?? null);
  let degradedTo = null;

  // fix-fleet-model-drift: when a fleet post carries an explicit chain and the
  // turn dies with an upstream model_not_available (or INVALID_MODEL), the
  // child's saved selection drifted away from what our ledger says — do NOT
  // walk the degrade chain yet. Force re-assert the declared hop (fresh
  // initialize), re-run ONCE, and only fall through to the degrade lane below
  // if that didn't recover.
  if (
    result.ok === false &&
    !result.interrupted &&
    isModelUnavailableError(result.error) &&
    modeled?.explicitChain === true &&
    modeled?.landed
  ) {
    try {
      const rectifiedSwitch = await ctx.switchModelTo?.(modeled.landed, { force: true });
      if (rectifiedSwitch?.ok !== false) {
        const retry = await attempt(modeled.landed);
        if (retry.ok) {
          result = { ...retry, detail: { ...(retry.detail ?? {}), modelRectified: modeled.landed } };
        }
      }
    } catch { /* the original failure stands; degrade lane below runs */ }
  }
  // One retry, only for a FAST upstream-class failure while the chain still
  // has an untried hop. Timeouts and tool failures are the work's own shape —
  // another model would hit them too. The fast-failure window bounds the
  // double-budget risk (upstream 5xx answers in seconds; a real turn doesn't).
  const retryFastMs = Number(process.env.PLATFORM_LLM_RETRY_FAST_MS) > 0 ? Number(process.env.PLATFORM_LLM_RETRY_FAST_MS) : 60_000;
  if (
    result.ok === false &&
    !result.interrupted &&
    classifyErrorKind(result.error) === "model_upstream" &&
    Date.now() - startedWall < retryFastMs &&
    Array.isArray(candidates) &&
    landedIndex + 1 < candidates.length
  ) {
    const nextModel = candidates[landedIndex + 1];
    try {
      const switched = await ctx.switchModelTo?.(nextModel);
      if (switched?.ok !== false) {
        console.warn(`[fleets] post model degraded for ${job.id}: ${modeled?.landed ?? "?"} → ${nextModel} (upstream failure)`);
        degradedTo = nextModel;
        result = await attempt(nextModel);
        if (result.ok && !result.detail) result.detail = { degradedTo: nextModel };
        else if (result.detail) result.detail = { ...result.detail, degradedTo: nextModel };
      }
    } catch { /* switch failure: the original result stands */ }
  }

  // Round-scoped child disposal (fix-fleet-round-discipline D5): the rotated
  // conversation is dead the moment the round settles — a best-effort delete
  // keeps the child's session store bounded. Failure is harmless by contract:
  // the rotation already guarantees this id is never resumed, so a failed
  // delete only leaves a bounded orphan file behind.
  await disposeRoundChild(ctx, childSessionId, sessionId);

  // Refresh the sidebar/list so a returning client sees the job session's
  // new output (this is the sessions broadcast finishTurn makes on the web
  // path; the cron path never sends `done`, which belongs to live turns).
  const version = ctx.sessionVersion;
  chatHistory
    .listSessions()
    .then((sessions) => {
      if (version === ctx.sessionVersion) {
        ctx.broadcast({ type: "sessions", sessions: ctx.withTurnStatus?.(sessions) ?? sessions, current: chatHistory.currentSessionId() });
      }
    })
    .catch((e) => console.error("[cron] sessions refresh failed:", e.message));

  // metering rides the seam return (add-turn-metering): attempt() stamps it
  // per attempt; a no-attempt ending (shouldn't reach here) falls back to the
  // turn-level assembly.
  if (result.error) return withPresetPath({ ok: false, error: result.error, detail: result.detail ?? null, metering: result.metering ?? metering }, presetPath);
  return withPresetPath({ ok: true, usage: result.usage ?? null, text: result.text ?? null, contextBudget, detail: result.detail ?? null, degradedTo, metering: result.metering ?? metering }, presetPath);
}

// ── Cluster task orchestration (agent-cluster-platform) ─────────────────────
//
// A cluster task fans its prompt out to the cluster's member agents and
// aggregates their outputs into the task's bound session. Members map to the
// two existing executor shapes: local personas (preset switch + one turn per
// member, own sub-session) and a2a market agents (remote turns). Persona
// members always run sequentially — the primary runtime is ONE shared child
// and a preset switch restarts it, so true parallelism is only possible for
// remote members; with allowParallel the a2a members overlap the persona
// loop, and persona members keep their serial order (an honest degradation,
// never a fanned-out lie).

function memberSessionId(job, agentId) {
  const key = String(agentId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 64);
  return `${job.sessionId || `cron-${job.id}`}--${key}`;
}

// Resolve the cluster's member agents against the live catalog. Pure —
// exported for tests. Returns one resolution per requested member, in
// cluster order (targetAgents filters, never reorders):
//   { member, entry }     → runnable (entry.kind picks the executor)
//   { member, skip, reason } → not runnable now (pack gone, agent uninstalled,
//                              entry not chat/a2a, persona preset not ready)
export function resolveClusterMembers(cluster, targetAgents, catalogAgents) {
  const wanted = Array.isArray(targetAgents) && targetAgents.length ? new Set(targetAgents) : null;
  const out = [];
  for (const member of cluster.agents ?? []) {
    if (wanted && !wanted.has(member.agentId)) continue;
    const entry =
      catalogAgents.find((a) => a.packId === member.packId && a.id === member.agentId) || null;
    if (!entry) {
      out.push({ member, skip: `pack '${member.packId}' 的 agent '${member.agentId}' 不在当前 catalog（未安装或已卸载）` });
      continue;
    }
    if (entry.mode === "a2a") {
      out.push({ member, entry });
      continue;
    }
    if (entry.mode !== "chat") {
      out.push({ member, skip: `agent '${member.agentId}' 的模式（${entry.mode}）不可执行` });
      continue;
    }
    if (!dshProfile.hasCatalogAgentPreset(entry.id)) {
      out.push({ member, skip: `agent '${member.agentId}' 的本地 persona 预设未就绪` });
      continue;
    }
    out.push({ member, entry });
  }
  return out;
}

// Render the per-member outcome block for the bound session. Pure — exported
// for tests.
export function buildClusterDigest({ clusterName, results, policy }) {
  const lines = [`集群「${clusterName}」任务完成。`];
  const okResults = results.filter((r) => r.status === "ok");
  const badResults = results.filter((r) => r.status !== "ok");

  const aggregation = policy?.resultAggregation ?? "all";
  if (aggregation === "first" && okResults.length > 0) {
    lines.push("", `## ${okResults[0].name} 的输出（first 策略）`, "", okResults[0].text || "(空回复)");
  } else {
    for (const r of okResults) {
      lines.push("", `## ${r.name}${r.model ? `（模型 ${r.model}）` : ""}`, "", r.text || "(空回复)");
    }
  }
  if (badResults.length) {
    lines.push("", "## 未产出成员");
    for (const r of badResults) {
      lines.push(`- ${r.name}：${r.status === "skipped" ? `跳过——${r.reason}` : `失败——${r.error || "未知错误"}`}`);
    }
  }
  if (policy?.allowParallel && results.some((r) => r.kind === "persona" && r.status === "ok")) {
    lines.push("", "（并行策略下本地 persona 成员仍按序执行——共享运行时一次只能承载一个 persona；仅远端 a2a 成员真正并行。）");
  }
  return lines.join("\n");
}

async function runClusterTurn(ctx, job, { turnTimeoutMs, activeTurns, startedAt = Date.now(), runPersona, runA2a, listAgents }) {
  const clusterDb = getClusterDatabase();
  const cluster = clusterDb.get(job.preset);
  if (!cluster) {
    return { ok: false, error: `cluster '${job.preset}' no longer exists` };
  }

  const policy = job.executionPolicy ?? {};
  const memberTimeoutMs =
    Number.isFinite(policy.timeoutMinutes) && policy.timeoutMinutes > 0
      ? policy.timeoutMinutes * 60_000
      : turnTimeoutMs;
  const resolutions = resolveClusterMembers(cluster, job.targetAgents, listAgents());
  if (resolutions.length === 0) {
    return { ok: false, error: "cluster has no runnable member agents (empty or all filtered out)" };
  }

  const boundSessionId = job.sessionId || `cron-${job.id}`;
  // Captured BEFORE any member runs — the persona loop switches the shared
  // runtime once per member; this is what it goes back to at the end. The
  // model rides the same rule (add-fleet-post-model D6): single-member turns
  // leave the runtime where they landed it, a fan-out puts it back.
  const originalPreset = ctx.currentPreset || null;
  const originalModel = ctx.session?.model?.id ?? null;

  // ── memory hook ① (add-memory-scopes-and-cluster-sharing; digest upgrade
  // add-cluster-digest-injection) ────────────────────────────────────────────
  // After member resolution, inject the cluster's shared memory into every
  // member's task prompt through the three-rung ladder in cluster-memory.js:
  // digest face (server-rendered, continuation-eval proven) → title list →
  // nothing. Degrade open at every rung: memory never fails a task.
  let taskPrompt = job.prompt;
  const clusterMemory = await clusterMemoryFor(process.env, ctx.runtimeOwnerEmail ?? null);
  if (clusterMemory) {
    taskPrompt = (await memoryInjectionFor(clusterMemory, cluster.id, job.prompt)).prompt;
  }
  chatHistory.recordMessage(boundSessionId, "user", taskPrompt);
  if (job.sessionTitle) {
    try { chatHistory.setTitle(boundSessionId, job.sessionTitle); } catch { /* prompt-derived title stays */ }
  }

  const results = [];
  const personaQueue = [];
  for (const r of resolutions) {
    if (r.skip) {
      results.push({ agentId: r.member.agentId, name: r.member.agentId, kind: "skip", status: "skipped", reason: r.skip });
    } else if (r.entry.mode === "a2a") {
      results.push({
        agentId: r.member.agentId,
        name: r.entry.name || r.member.agentId,
        kind: "a2a",
        status: "pending",
        entry: r.entry,
      });
    } else {
      personaQueue.push(r);
    }
  }

  const runA2aMember = async (slot) => {
    const out = await runA2a(ctx, {
      id: job.id,
      prompt: taskPrompt,
      targetType: "a2a",
      preset: slot.entry.id,
      sessionId: memberSessionId(job, slot.agentId),
      sessionTitle: `${cluster.name} · ${slot.entry.name || slot.agentId}`,
    }, memberTimeoutMs);
    slot.status = out.ok ? "ok" : "failed";
    slot.text = out.text ?? null;
    slot.error = out.error ?? null;
    delete slot.entry;
  };
  const runPersonaMember = async (r) => {
    const preset = dshProfile.rosterPresetId(r.entry.id);
    const out = await runPersona(ctx, {
      id: job.id,
      prompt: taskPrompt,
      targetType: "persona",
      preset,
      sessionId: memberSessionId(job, r.member.agentId),
      sessionTitle: `${cluster.name} · ${r.entry.name || r.member.agentId}`,
      // sourceTag rides down (fix-fleet-round-discipline D7): a fleet-owned
      // cluster's persona members rotate their child conversation id inside
      // runPersonaTurn exactly like a single-post round does.
      sourceTag: job.sourceTag,
    }, memberTimeoutMs, activeTurns, { startedAt });
    results.push({
      agentId: r.member.agentId,
      name: r.entry.name || r.member.agentId,
      kind: "persona",
      status: out.ok ? "ok" : "failed",
      text: out.text ?? null,
      error: out.error ?? null,
      usage: out.usage ?? null,
      // Model attribution (3.15): the runtime's active model id at this
      // member's turn — the lane is the single provider, this names the model.
      model: ctx.runtimeModel?.id ?? null,
    });
    return out;
  };

  // allowParallel overlaps the remote turns with the persona loop; sequential
  // runs everything in member order. The persona loop itself is serial either
  // way (one shared runtime).
  const a2aSlots = results.filter((r) => r.kind === "a2a");
  let remote = null;
  if (a2aSlots.length && policy.allowParallel) {
    remote = Promise.allSettled(a2aSlots.map((s) => runA2aMember(s)));
  }
  let lastPersonaOut = null;
  let firstOkPreset = null;
  for (const r of personaQueue) {
    lastPersonaOut = await runPersonaMember(r);
    if (lastPersonaOut.ok && !firstOkPreset) {
      firstOkPreset = dshProfile.rosterPresetId(r.entry.id);
    }
  }
  if (!remote && a2aSlots.length) {
    for (const s of a2aSlots) await runA2aMember(s);
  } else if (remote) {
    const settled = await remote;
    for (const [i, s] of settled.entries()) {
      if (s.status === "rejected") {
        a2aSlots[i].status = "failed";
        a2aSlots[i].error = s.reason?.message || String(s.reason);
      }
    }
  }

  // Bookkeeping: usage totals ride the cluster row; the fan-out leaves the
  // runtime on the LAST member's persona — put it back where the user had it.
  const totalUsage = results.reduce((acc, r) => {
    const u = r.usage;
    if (!u) return acc;
    return {
      input: (acc?.input ?? 0) + (u.input ?? u.promptTokens ?? 0),
      output: (acc?.output ?? 0) + (u.output ?? u.completionTokens ?? 0),
    };
  }, null);
  try {
    clusterDb.update(cluster.id, {
      lastUsedAt: Date.now(),
      totalExecutions: (cluster.totalExecutions || 0) + 1,
      ...(totalUsage ? { totalTokensUsed: (cluster.totalTokensUsed || 0) + (totalUsage.input || 0) + (totalUsage.output || 0) } : {}),
    });
  } catch (e) {
    console.warn(`[cluster] stats update failed for ${cluster.id}: ${e.message}`);
  }

  const aggregation = policy.resultAggregation ?? "all";
  let digestText = buildClusterDigest({ clusterName: cluster.name, results, policy });
  let summaryRan = false;
  let summarySucceeded = false;

  // summary: one synthesis turn under the first successful persona member,
  // in the BOUND session, fed with every member's output. Falls back to the
  // plain digest when no local member produced output (nothing to lead with).
  if (aggregation === "summary" && firstOkPreset) {
    const outputs = results
      .filter((r) => r.status === "ok" && r.text)
      .map((r) => `【${r.name}】\n${r.text}`)
      .join("\n\n");
    const synthPrompt =
      `以下是集群「${cluster.name}」各成员对同一任务的输出。\n\n原始任务：${job.prompt}\n\n${outputs}\n\n` +
      `请综合以上成员输出，给出一份统一的最终答复：先给结论，再列各成员的关键贡献，最后指出成员间的分歧或缺口（如有）。`;
    const synth = await runPersona(ctx, {
      id: job.id,
      prompt: synthPrompt,
      targetType: "persona",
      preset: firstOkPreset,
      sessionId: boundSessionId,
      sessionTitle: job.sessionTitle || null,
      sourceTag: job.sourceTag, // rotation rides the same D7 rule as members
    }, memberTimeoutMs, activeTurns, { startedAt });
    summaryRan = true;
    if (synth.ok && synth.text) {
      digestText = synth.text;
      summarySucceeded = true;
    } else {
      digestText += `\n\n（汇总回合失败，以上为成员原始输出。失败原因：${synth.error || "未知"}）`;
    }
  }

  // Put the shared runtime back where the user had it. A persona member that
  // failed mid-switch may still have moved it, so the restore keys off "any
  // persona-shaped work happened", not off success.
  if ((personaQueue.length > 0 || summaryRan) && originalPreset && ctx.currentPreset !== originalPreset) {
    try { await switchPresetForJob(ctx, originalPreset, memberTimeoutMs); } catch { /* best-effort */ }
  }
  if ((personaQueue.length > 0 || summaryRan) && originalModel && ctx.session?.model?.id !== originalModel) {
    try { await ctx.switchModelTo(originalModel); } catch { /* best-effort */ }
  }

  // A successful synthesis turn already persisted itself into the bound
  // session (runPersona records its exchange) — recording digestText again
  // would duplicate the reply. Only the self-built digest (all/first, or a
  // failed summary) needs a manual row.
  if (!summarySucceeded) {
    chatHistory.recordMessage(boundSessionId, "assistant", digestText);
  }
  // ── memory hook ② (add-memory-scopes-and-cluster-sharing) ────────────────
  // Write the finalized digest back as a page of the same cluster project —
  // the next cluster turn's hook ① feeds on it. Failure is recorded, never
  // task-failing.
  if (clusterMemory) {
    try {
      await clusterMemory.writeDigest(
        cluster.id,
        `集群回合 ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        digestText,
      );
    } catch (e) {
      console.warn(`[cluster] digest write-back failed for ${cluster.id} (degrade open): ${e?.message || e}`);
    }
  }
  const version = ctx.sessionVersion;
  chatHistory
    .listSessions()
    .then((sessions) => {
      if (version === ctx.sessionVersion) {
        ctx.broadcast({ type: "sessions", sessions: ctx.withTurnStatus?.(sessions) ?? sessions, current: chatHistory.currentSessionId() });
      }
    })
    .catch((e) => console.error("[cluster] sessions refresh failed:", e.message));

  const okCount = results.filter((r) => r.status === "ok").length;
  const memberModels = Object.fromEntries(results.filter((r) => r.model).map((r) => [r.name, r.model]));
  if (okCount === 0) {
    const errs = results.map((r) => `${r.name}: ${r.status === "skipped" ? r.reason : r.error || "unknown"}`).join("; ");
    return { ok: false, error: `all cluster members failed or were skipped — ${errs}`, models: memberModels };
  }
  return { ok: true, usage: totalUsage, models: memberModels };
}

export function attachCronRunner(ctx, { runPersona = null, runA2a = null, runTool = null, listAgents = null } = {}) {
  // A bridge restart (preset switch, catalog sync, crash respawn) kills any
  // in-flight turn in a job session — the collector would otherwise sit out
  // the full turn timeout and wedge the engine's serialized queue behind a
  // turn that can never finish. dsh-events' bridge.exit branch calls this
  // registry (the bridge captures the event handler by reference at
  // construction, so wrapping ctx.handleDshEvent here would never fire).
  const activeTurns = new Map(); // sessionId -> (reason) => void
  // Exposed so the delegation aggregator's collector registers on the SAME
  // abort registry — a bridge restart aborts every collected turn, not just
  // scheduled ones.
  ctx.taskTurnRegistry = activeTurns;
  ctx.abortCronTurns = (reason) => {
    for (const abort of activeTurns.values()) {
      try {
        abort(reason);
      } catch { /* best-effort abort */ }
    }
    activeTurns.clear();
  };

  // The member executors (cluster fan-out composes these). Injectable so
  // tests drive the orchestration without a live runtime. runTool is the T1
  // tool-post executor (add-tool-posts): one deterministic MCP call.
  const personaExecutor = runPersona || runPersonaTurn;
  const a2aExecutor = runA2a || runA2aRemoteTurn;
  const toolExecutor = runTool || runToolTurnDefault;
  const listAgentsFn = listAgents || catalog.listAgents;

  // `job` is the live engine record (cron.js). Returns { ok, error? }.
  // Turn-event seam (add-fleet-turn-events D1): every turn path converges
  // here, so the outcome event is recorded at this one wrapper — never inside
  // the three executors. Degrade open: a recording failure must never fail
  // the turn it observed.
  ctx.runCronJobTurn = async (job, { turnTimeoutMs } = {}) => {
    const timeoutMs = turnTimeoutMs || 10 * 60 * 1000;
    // Monotonic per-cell sequence alongside the wall clock (retry storms and
    // catch-up runs can start two executions inside one millisecond — the
    // rotated child id must stay unique or the round resumes stale history).
    const startedAt = Date.now();
    const roundSeq = ++roundSeqCounter;
    job = { ...job, roundSeq };

    // Not-executed short-circuit (fix-fleet-turn-veracity D1): a fleet persona
    // round whose runtime never becomes ready inside the bounded wait is
    // skipped, not failed — and the skip lands BEFORE the ledger opens, so the
    // round leaves no run instance, no handoffs, no settle behind it. The
    // inner gate in runPersonaTurn stays as the race fallback (bridge flapping
    // between this pre-gate and the turn itself records failed, honestly).
    if (job.targetType === "persona" && job.sourceTag?.fleetId) {
      let ready;
      try {
        ready = await awaitRuntimeReadyForJob(ctx, job);
      } catch (e) {
        ready = { ok: false, error: `readiness pre-gate failed: ${e?.message || e}` };
      }
      if (!ready.ok) {
        const skippedOut = { ok: false, skipped: true, error: ready.error };
        try {
          ctx.recordFleetTurnEvent?.(job, skippedOut, { startedAt, endedAt: Date.now(), model: null, ledgerTurn: null });
        } catch (e) {
          console.warn(`[fleets] skipped turn record failed for ${job.id}: ${e?.message || e}`);
        }
        return skippedOut;
      }
    }

    // Run ledger (agent-fleet-runs D2): the turn's id — and for a root turn
    // its run id — exist from the START, because a mid-turn dispatch_post must
    // stamp the upstream turn id on the task it creates. Registered under the
    // mirror session and the rotated child id so the collector tap can find
    // it. Degrade open: a ledger failure never touches the turn.
    let ledgerTurn = null;
    try {
      ledgerTurn = ctx.fleetTurnLedger?.begin(job, { startedAt, sessionIds: [roundChildSessionId(job, startedAt, roundSeq)] }) ?? null;
    } catch (e) {
      console.warn(`[fleet-runs] ledger begin failed for ${job.id}: ${e?.message || e}`);
    }

    // Pre-round credential renewal (add-line-credential-renewal D3 trigger ①):
    // an unattended fleet post must never run on an expired line token. Degrade
    // open — a renewal failure never fails the turn (the round then reports the
    // honest unconnected state instead); a2a/tool shapes are covered too (tool
    // posts read the credential live from the DB, remote turns are unaffected).
    // The drain first delivers any credential restart deferred from the
    // previous turn's streaming window, so this round starts on a child whose
    // patch is current (nothing here can stall the turn — both degrade open).
    try {
      await ctx.drainDeferredCredentialRestart?.();
    } catch (e) {
      console.warn(`[cron] deferred credential restart drain failed: ${e?.message || e}`);
    }
    try {
      await ctx.renewLineCredentialsForTurn?.();
    } catch (e) {
      console.warn(`[cron] pre-round credential renewal failed: ${e?.message || e}`);
    }

    let out;
    if (job.targetType === "cluster") {
      out = await runClusterTurn(ctx, job, {
        turnTimeoutMs: timeoutMs,
        activeTurns,
        startedAt,
        runPersona: personaExecutor,
        runA2a: a2aExecutor,
        listAgents: listAgentsFn,
      });
    } else if (job.targetType === "a2a") {
      // a2a targets (add-agent-delegation-a2a D2): a REMOTE turn — no runtime
      // readiness, no preset switch, no dsh prompt. The streamed reply lands
      // in the task's dedicated session exactly like a persona execution's
      // output; outbound depth is 1 (human-originated delegation baseline —
      // chains get +1 only when in-cell turns are themselves delegated, a
      // future state).
      out = await a2aExecutor(ctx, job, timeoutMs);
    } else if (job.targetType === "tool") {
      // Tool posts (add-tool-posts): one deterministic MCP call — no dsh
      // runtime, no preset switch, no LLM. Model metadata is meaningless
      // here; the event seam records it null.
      out = await toolExecutor(ctx, job, timeoutMs);
    } else {
      // Turn carrier routing (add-fleet-carrier): runner → the remote executor
      // via the catalog's a2a entry; anything else stays on the primary chain.
      // Fail-open by contract — a runner declaration without a deployment (or
      // an unreachable entry) runs the turn on the primary chain with a
      // recorded carrierFallback, never a refused round.
      let personaJob = job;
      let personaExecutorUsed = personaExecutor;
      const carrier = resolveTaskCarrier(job);
      if (carrier === "runner") {
        const entry = runnerEntryFor(job, { listAgents: listAgentsFn });
        if (entry) {
          personaJob = { ...job, preset: entry.id, targetType: "a2a" };
          personaExecutorUsed = a2aExecutor;
        } else {
          console.warn(`[fleets] carrier runner for ${job.id}: no a2a entry for '${job.preset}' — failing open to the primary chain`);
          job.carrierFallback = "runner-no-entry";
        }
      } else if (carrier === "worker" && (!ctx.workerPool || !ctx.workerPool.cap)) {
        console.warn(`[fleets] carrier worker for ${job.id}: worker pool inactive — failing open to the primary chain`);
        job.carrierFallback = "worker-pool-inactive";
      }
      out = await personaExecutorUsed(ctx, personaJob, timeoutMs, activeTurns, { startedAt });
      if (job.carrierFallback) {
        out = { ...out, detail: { ...(out?.detail ?? {}), carrierFallback: job.carrierFallback } };
      }
    }

    try {
      ctx.recordFleetTurnEvent?.(job, out, {
        startedAt,
        endedAt: Date.now(),
        // The post's context budget (add-agent-config-dims): judged at
        // settlement from the usage the runtime actually reported.
        contextBudget: Number.isFinite(out?.contextBudget) ? out.contextBudget : null,
        // Best-effort model metadata: providers that stamp usage win, else
        // the runtime's landed model (persona turns leave it where they
        // landed — add-fleet-post-model D6), else the cluster's first member.
        // Tool turns carry none — there is no LLM.
        model:
          job.targetType === "tool"
            ? null
            : out?.usage?.model ??
              ctx.session?.model?.id ??
              (out?.models ? Object.values(out.models)[0] ?? null : null),
        // The ledger handle opened above (null for non-fleet turns or when the
        // ledger is absent): the recorder then writes turnId/runId/chain/
        // trace key on the row and broadcasts fleet_turn_ended.
        ledgerTurn,
      });
    } catch (e) {
      console.warn(`[fleets] turn event record failed for ${job.id}: ${e?.message || e}`);
    }
    // Lane breaker accounting (fix-fleet-turn-attribution D3): the seam knows
    // the model the turn ACTUALLY ran on — a degraded retry already moved the
    // runtime, so ctx.session reflects the last hop. A skipped turn records
    // nothing (the wall was never hit this round). Any successful turn closes
    // the breaker — the half-open probe IS this success.
    try {
      const laneModel = job.targetType === "tool" ? null : (out?.usage?.model ?? ctx.session?.model?.id ?? null);
      const laneId = typeof ctx.llmLaneForModel === "function" ? ctx.llmLaneForModel(laneModel) : null;
      if (laneId && !out?.skipped) {
        if (out?.ok === true) recordUpstreamSuccess(laneId);
        else if (classifyErrorKind(out?.error) === "model_upstream") recordUpstreamFailure(laneId);
      }
    } catch { /* breaker accounting must never fail the turn it observed */ }
    // Handoff edges (agent-fleet-orchestration): the same seam, AFTER the
    // outcome event — upstream completion (ok or failed, both honestly)
    // triggers each declared downstream turn. Degrade open likewise. The
    // ledger handle rides along so every ignited task inherits this run.
    // A SKIPPED round produced no upstream work — igniting downstream turns
    // on it would cascade emptiness down the chain.
    if (!out?.skipped) {
      try {
        await ctx.triggerFleetHandoffs?.(job, out, ledgerTurn);
      } catch (e) {
        console.warn(`[fleets] handoff trigger failed for ${job.id}: ${e?.message || e}`);
      }
    }
    // Settle the run AFTER the handoffs are queued: the header closes only
    // when nothing of this run is in flight or waiting (agent-fleet-runs).
    // This job is excluded — the engine marks it done after we return.
    try {
      ctx.fleetTurnLedger?.settle(ledgerTurn?.runId ?? null, { excludeTaskId: job.id });
    } catch (e) {
      console.warn(`[fleet-runs] settle failed for ${job.id}: ${e?.message || e}`);
    }
    return out;
  };
}
