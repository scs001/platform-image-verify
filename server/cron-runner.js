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
import { clusterMemoryFor } from "./cluster-memory.js";

const IDLE_POLL_MS = 250;
const PRESET_SWITCH_ATTEMPTS = 3;

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
// broadcast path. Exported for the delegation aggregator and the worker pool.
export function collectTurn(ctx, sessionId, timeoutMs, activeTurns, collectors = ctx.sessionCollectors) {
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
    const timer = setTimeout(
      () => settle(reject, new Error("turn timed out")),
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
      const { method, params } = notif;
      if (method === "session.status" && params.status === "idle") {
        return settle(resolve, { text, error, usage });
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
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
        // Token spend when the runtime reports usage (absent on some
        // providers). dsh attaches TokenUsage to assistant/message, one per
        // step — keep the last (the honest live context size).
        if (ev.data?.usage) usage = ev.data.usage;
        // Mirror the final message into SQLite WITH the tool-call blocks, the
        // same structure the web path persists — a reloaded job session
        // rebuilds the same evidence trail as a live one.
        const persistBlocks = [...toolBlocks, ...(text ? [{ kind: "text", text }] : [])];
        if (text || toolBlocks.length) {
          chatHistory.recordMessage(sessionId, "assistant", text, persistBlocks);
        }
      } else if (ev.type === "tool/call") {
        toolBlocks.push({
          kind: "tool",
          id: ev.data.callId,
          name: ev.data.name,
          args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
        });
      } else if (ev.type === "tool/result") {
        const { callId, resultText } = parseToolResult(ev);
        const acc = toolBlocks.find((b) => b.id === callId);
        if (acc) acc.result = resultText;
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

async function switchPresetForJob(ctx, preset, timeoutMs) {
  for (let attempt = 0; attempt < PRESET_SWITCH_ATTEMPTS; attempt++) {
    await waitForIdle(ctx, timeoutMs);
    if (preset === ctx.currentPreset) return { ok: true };
    // switchPresetTo already serializes through runExclusiveRuntimeMutation
    // (server/agent-session.js) — wrapping it again would nest the chain and
    // deadlock. It restarts the bridge, persists the preference and
    // broadcasts current_preset + agent_changed — clients learn the runtime
    // now runs the job's agent.
    const r = await ctx.switchPresetTo(preset);
    if (r?.ok) return r;
    // A streaming user turn started between the idle wait and the switch —
    // loop and wait again rather than failing the run.
    if (!ctx.isStreaming) return r;
  }
  return { ok: false, error: "could not switch the agent for the scheduled task (runtime stayed busy)" };
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
    return { ok: true, usage: null, text: out.text ?? null };
  } catch (e) {
    ctx.sessionCollectors.delete(sessionId);
    return { ok: false, error: e.message };
  }
}

async function runPersonaTurn(ctx, job, timeoutMs, activeTurns) {
  if (!ctx.dshBridge?.isReady()) {
    return { ok: false, error: "the agent runtime is not ready" };
  }

  // preset binding: a job without one (legacy record) runs under whatever
  // preset is live, matching its pre-change behavior.
  // `releaseReservation` is taken BEFORE the switch: it restarts the child,
  // and bridge.ready drains the web queue (concurrent-chat-sessions D2).
  // Without the reservation a queued web prompt would be dispatched into the
  // restart this job is about to use.
  let releaseReservation = null;
  if (job.preset) {
    releaseReservation = ctx.reserveRuntime?.("cron-preset-switch") ?? null;
    const switched = await switchPresetForJob(ctx, job.preset, timeoutMs);
    if (!switched.ok) {
      releaseReservation?.();
      return switched;
    }
  }

  const sessionId = job.sessionId || `cron-${job.id}`;

  // The bound session is a normal session: the user can open it, and rows
  // stamped here pick up the (just-switched) preset as their creation fact.
  chatHistory.recordMessage(sessionId, "user", job.prompt);
  if (job.sessionTitle) {
    try {
      chatHistory.setTitle(sessionId, job.sessionTitle);
    } catch { /* sanitize failure leaves the prompt-derived title */ }
  }

  const collected = collectTurn(ctx, sessionId, timeoutMs, activeTurns);
  // The collector is now the visible trace of this turn — hand the runtime
  // over to it and drop the preset-switch reservation.
  releaseReservation?.();
  let result;
  try {
    await ctx.dshBridge.prompt(sessionId, [{ type: "text", text: job.prompt }]);
    result = await collected;
  } catch (e) {
    ctx.sessionCollectors.delete(sessionId);
    activeTurns.delete(sessionId);
    ctx.onRuntimeIdle?.();
    return { ok: false, error: e.message, interrupted: e.interrupted === true };
  }

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

  if (result.error) return { ok: false, error: result.error };
  return { ok: true, usage: result.usage ?? null, text: result.text ?? null };
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

async function runClusterTurn(ctx, job, { turnTimeoutMs, activeTurns, runPersona, runA2a, listAgents }) {
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
  // runtime once per member; this is what it goes back to at the end.
  const originalPreset = ctx.currentPreset || null;

  // ── memory hook ① (add-memory-scopes-and-cluster-sharing) ────────────────
  // After member resolution, read the cluster's shared pages (the cluster-id
  // project under the OWNER's memory root) and inject them into every
  // member's task prompt. Degrade open: empty project or unreachable memory
  // means no block and the task proceeds unchanged.
  let taskPrompt = job.prompt;
  const clusterMemory = await clusterMemoryFor(process.env, ctx.runtimeOwnerEmail ?? null);
  if (clusterMemory) {
    try {
      const sharedPages = await clusterMemory.readShared(cluster.id, 5);
      if (sharedPages.length) {
        const block = sharedPages.map((p) => `- ${p.title}（${String(p.updated_at ?? "").slice(0, 10)}）`).join("\n");
        taskPrompt = `${job.prompt}\n\n【集群共享记忆】本集群此前回合的沉淀，供参考：\n${block}`;
      }
    } catch (e) {
      console.warn(`[cluster] shared-memory read failed for ${cluster.id} (degrade open): ${e?.message || e}`);
    }
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
    }, memberTimeoutMs, activeTurns);
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
    }, memberTimeoutMs, activeTurns);
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

export function attachCronRunner(ctx, { runPersona = null, runA2a = null, listAgents = null } = {}) {
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

  // The two member executors (cluster fan-out composes these). Injectable so
  // tests drive the orchestration without a live runtime.
  const personaExecutor = runPersona || runPersonaTurn;
  const a2aExecutor = runA2a || runA2aRemoteTurn;
  const listAgentsFn = listAgents || catalog.listAgents;

  // `job` is the live engine record (cron.js). Returns { ok, error? }.
  ctx.runCronJobTurn = async (job, { turnTimeoutMs } = {}) => {
    const timeoutMs = turnTimeoutMs || 10 * 60 * 1000;

    if (job.targetType === "cluster") {
      return runClusterTurn(ctx, job, {
        turnTimeoutMs: timeoutMs,
        activeTurns,
        runPersona: personaExecutor,
        runA2a: a2aExecutor,
        listAgents: listAgentsFn,
      });
    }

    // a2a targets (add-agent-delegation-a2a D2): a REMOTE turn — no runtime
    // readiness, no preset switch, no dsh prompt. The streamed reply lands in
    // the task's dedicated session exactly like a persona execution's output;
    // outbound depth is 1 (human-originated delegation baseline — chains get
    // +1 only when in-cell turns are themselves delegated, a future state).
    if (job.targetType === "a2a") {
      return a2aExecutor(ctx, job, timeoutMs);
    }

    return personaExecutor(ctx, job, timeoutMs, activeTurns);
  };
}
