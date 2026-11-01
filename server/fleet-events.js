// Turn result events (agent-fleet-core, add-fleet-turn-events).
//
// Two exports do the work behind the spec's "每次成员回合产出回合结果事件":
//   • classifyErrorKind — a pure ordered-pattern classifier (D4). Table-driven,
//     no IO, first match wins, `other` is the floor — an unrecognized error is
//     still classified, never dropped.
//   • recordTurnEvent — the single attribution + write entry called from the
//     runCronJobTurn seam (D1/D2). Attribution order: the task's sourceTag
//     (cron-materialized) → origin.fleet (decision execute-now manual tasks)
//     → resolveAttribution over the live persona scan (delegation wake / plain
//     manual turns). No attribution → not a fleet turn → silent null, zero
//     disturbance to non-fleet tasks.

import { resolveAttribution } from "./fleet-reports.js";
import { buildTurnRequest } from "./turn-request.js";
import { resolvePersona } from "../dsh-profile.js";
import { pricingFor, estimateTurnCost } from "./turn-pricing.js";

// Ordered: the FIRST matching row wins, so runtime-readiness outranks the
// timeout it probably caused and tool/permission outranks a provider echo of
// the denial. Calibration is open — patterns track real error corpora, the
// table is the single tuning point.
export const ERROR_KINDS = [
  "runtime_not_ready",
  "timeout",
  "tool_permission",
  "model_upstream",
  "business_refused",
  // A turn that ran fine but exceeded its post's declared context budget
  // (add-agent-config-dims): its own kind, because the remedy is "raise the
  // budget or shorten the work", not "fix a provider or a permission".
  "context_budget",
  "other",
];

const ERROR_KIND_PATTERNS = [
  ["runtime_not_ready", /not ready|still starting|stayed busy|could not switch the agent|runtime.*(busy|idle)|未就绪/i],
  ["timeout", /timeout|timed? ?out|超时/i],
  // Bare `403` was dropped here (production 2026-10-25: the lane's
  // "403 status code (no body)" — a sub2api HTTP echo, no permission word in
  // sight — classified as a tool problem and sent triage down the wrong
  // lane). A transport-level "NNN status code" echo now reads as the model
  // lane; a genuine tool refusal carries permission words with or without
  // the status digit.
  ["tool_permission", /permission|denied|forbidden|not authorized|unauthorized|工具|权限/i],
  ["model_upstream", /no runnable model|model switch|invalid model|\b\d{3}\s*status code|429|quota|rate.?limit|provider|upstream|api.?key|api_error|service temporarily unavailable|5\d{2}\s*:|上游|模型/i],
  ["business_refused", /refused|rejected by policy|业务拒绝|拒绝执行/i],
];

export function classifyErrorKind(text) {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  for (const [kind, re] of ERROR_KIND_PATTERNS) {
    if (re.test(s)) return kind;
  }
  return "other";
}

// Source derivation lives in ONE place now (agent-turn-contract): the thin
// alias below keeps existing imports stable while recordTurnEvent reads the
// same derivation via buildTurnRequest — one rule, two doors.
export function turnSourceFor(job) {
  return buildTurnRequest(job).source;
}

// The persona → post attribution for manual/delegation turns. Same scan and
// ghost-post guard as fleetIdentityFor (archived fleets release their posts)
// — this returns the ids, not the rendered identity line.
function attributedPostFor(db, presetId, rosterPresetId) {
  if (!presetId) return null;
  const personaMembers = [];
  for (const f of db.listFleets()) {
    if (f.state === "archived") continue;
    for (const m of db.listMembers(f.id)) {
      if (m.targetKind === "persona") personaMembers.push(m);
    }
  }
  const attribution = resolveAttribution({ currentPreset: presetId, personaMembers, rosterPresetId });
  if (attribution.kind !== "preset") return null;
  return { fleetId: attribution.fleetId, memberId: attribution.memberId };
}

// Which post does this turnRequest execute? sourceTag (cron-materialized) →
// origin.fleet (execute-now / dispatch / handoff / event wake) → persona scan
// (plain delegation wake). Null = not a fleet turn. Shared by the outcome
// recorder below and the run ledger's begin() (agent-fleet-runs), so the two
// doors read ONE attribution rule.
export function resolveTurnPost(db, request, rosterPresetId = (id) => id) {
  if (request?.evidence?.sourceTag?.fleetId) {
    return { fleetId: request.evidence.sourceTag.fleetId, memberId: request.evidence.sourceTag.memberId ?? null };
  }
  if (request?.evidence?.origin?.fleet?.fleetId) {
    return { fleetId: request.evidence.origin.fleet.fleetId, memberId: request.evidence.origin.fleet.memberId ?? null };
  }
  const post = attributedPostFor(db, request?.targetRef?.id, rosterPresetId);
  if (!post?.fleetId || !post?.memberId) return null;
  return post;
}

// Token usage as the runtime reports it, in the shapes seen across providers
// (dsh TokenUsage input/output, OpenAI prompt/completion, snake_case). Null
// when nothing was reported — never a guessed zero (spec: 用量缺失不虚构).
export function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const input = u.input ?? u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? u.prompt_tokens ?? null;
  const output = u.output ?? u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? u.completion_tokens ?? null;
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    input: Number.isFinite(input) ? input : null,
    output: Number.isFinite(output) ? output : null,
    // Turn metering (add-turn-metering D4): the TokenUsage细分 rides verbatim —
    // absent fields stay undefined → the columns read NULL (honest absence).
    // usage.input keeps the upstream semantic (UNCACHED input); billed input =
    // input + cacheRead + cacheWrite summed at query time.
    cacheReadTokens: Number.isFinite(u.cacheReadTokens) ? u.cacheReadTokens : null,
    cacheWriteTokens: Number.isFinite(u.cacheWriteTokens) ? u.cacheWriteTokens : null,
    reasoningTokens: Number.isFinite(u.reasoningTokens) ? u.reasoningTokens : null,
  };
}

// The outcome → event-field shaping (status/errorKind/error/model/usage),
// pure, shared with the ledger.
export function shapeTurnOutcome(outcome, { model = null, contextBudget = null } = {}) {
  const ok = outcome?.ok === true;
  const interrupted = outcome?.interrupted === true;
  // fix-fleet-turn-attribution D4: a platform-skipped round (lane breaker
  // open) is its own ending — neither a failure nor a success. The streak
  // never counts it, presence advances, and the UI can tell it apart.
  const skipped = outcome?.skipped === true;
  const usage = normalizeUsage(outcome?.usage);
  // Context budget (add-agent-config-dims D3): judged at settlement, from the
  // usage the runtime actually reported. No usage → no basis → never judged
  // (an invented zero would fail turns nobody measured).
  const spent = usage && (usage.input != null || usage.output != null) ? (usage.input ?? 0) + (usage.output ?? 0) : null;
  const overBudget = ok && Number.isFinite(contextBudget) && spent != null && spent > contextBudget;
  // Detail (fix-fleet-turn-attribution D1): the executor's own attribution
  // (timeout shape, degradedTo) rides the row verbatim — the recorder adds
  // nothing it did not observe.
  const detail = outcome?.detail && typeof outcome.detail === "object" ? outcome.detail : null;
  return {
    status: skipped ? "skipped" : overBudget ? "failed" : ok ? "ok" : interrupted ? "interrupted" : "failed",
    errorKind: skipped ? null : overBudget ? "context_budget" : ok ? null : classifyErrorKind(outcome?.error),
    error: overBudget
      ? `context budget exceeded: spent ${spent} tokens, budget ${contextBudget}`
      : ok
        ? null
        : String(outcome?.error ?? "execution failed").slice(0, 500),
    model: model ?? outcome?.usage?.model ?? null,
    usage,
    detail,
  };
}

// `outcome` is the executor's return: { ok, error?, interrupted?, usage? }.
// `meta` carries { startedAt, endedAt, model } from the seam (the wrapper
// knows when the turn began and what the runtime landed on) and, when the run
// ledger opened this turn, `ledgerTurn` — the handle whose turnId/runId/chain
// position/trace key land on the row. Returns the stored event, or null when
// the turn carries no fleet attribution.
export function recordTurnEvent(db, job, outcome, { startedAt, endedAt, model = null, rosterPresetId = (id) => id, ledgerTurn = null, contextBudget = null } = {}) {
  // Single derivation source (agent-turn-contract): attribution and source
  // both read off the same turnRequest — one rule for both doors.
  const request = buildTurnRequest(job);
  const post = ledgerTurn
    ? { fleetId: ledgerTurn.fleetId, memberId: ledgerTurn.memberId }
    : resolveTurnPost(db, request, rosterPresetId);
  if (!post?.fleetId || !post?.memberId) return null;

  const shaped = shapeTurnOutcome(outcome, { model, contextBudget });
  return db.appendTurnEvent({
    fleetId: post.fleetId,
    memberId: post.memberId,
    source: request.source,
    ...shaped,
    startedAt,
    endedAt,
    sessionId: job?.sessionId ?? null,
    turnId: ledgerTurn?.turnId ?? null,
    runId: ledgerTurn?.runId ?? request.chain?.runId ?? null,
    parentTurnId: ledgerTurn?.parentTurnId ?? request.chain?.parentTurnId ?? null,
    edgeKind: ledgerTurn?.edgeKind ?? request.chain?.edgeKind ?? null,
    traceTurnId: ledgerTurn?.traceTurnId ?? null,
    metering: meteringOf(request, job, outcome),
    pricing: pricingOf(shaped),
  });
}

// ── Turn pricing (add-turn-pricing) ──────────────────────────────────────────
//
// Synchronous estimate at the seam: the cached per-token rate (pricingFor)
// times THIS turn's usage, at the price version live at turn time. The turn
// row carries only the pricing_at stamp (never money — D4a); the DAILY row
// accumulates the estimate. Unpriced model / cold cache → null (honest
// absence; the daily columns just don't accumulate for that turn).
function pricingOf(shaped) {
  const model = shaped.model ?? null;
  if (!model) return null;
  const rates = pricingFor(model);
  if (!rates) return null;
  const usage = shaped.usage ?? {};
  return estimateTurnCost(usage, rates);
}

// ── Turn metering (add-turn-metering) ────────────────────────────────────────
//
// Aggregate fields ride the SAME event row as columns (never detail JSON —
// detail is read by row, never queried). Absent dimension or unreported
// runtime field → NULL (honest absence), never 0 impersonating an observation.
// carrier comes from the execution-carrier mark (enqueue default or the worker
// slot claim) carried on outcome.metering by the executor — derived NOWHERE
// else. depth is the turnRequest's chain position (single derivation rule);
// wave reads the origin chain. presetSource classifies the roster id once:
// catalog pack entry → "catalog", custom preset → "custom", the platform's
// baseline composition id → "shipped", anything unresolvable → NULL.
const BASELINE_PRESET_ID = "standard";
function meteringOf(request, job, outcome) {
  const usage = outcome?.usage ?? {};
  const m = outcome?.metering ?? {};
  let presetSource = null;
  if (job?.preset) {
    if (job.preset === BASELINE_PRESET_ID) presetSource = "shipped";
    else {
      try {
        const persona = resolvePersona(job.preset);
        presetSource = persona ? (persona.customPreset ? "custom" : "catalog") : null;
      } catch { /* degrade open — source stays NULL */ }
    }
  }
  return {
    presetId: job?.preset ?? null,
    presetSource,
    provider: m.provider ?? null,
    effort: m.effort ?? null,
    carrier: m.carrier ?? null,
    carrierInstance: m.carrierInstance ?? null,
    laneId: outcome?.detail?.laneId ?? null,
    depth: request.depth ?? null,
    wave: job?.origin?.fleet?.wave ?? null,
    queueWaitMs: Number.isFinite(m.queueWaitMs) ? Math.max(0, Math.round(m.queueWaitMs)) : null,
    spinUpMs: Number.isFinite(m.spinUpMs) ? Math.max(0, Math.round(m.spinUpMs)) : null,
    ttftMs: Number.isFinite(m.ttftMs) ? Math.max(0, Math.round(m.ttftMs)) : null,
    usageCachedInput: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
    usageCacheWrite: Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null,
    usageReasoning: Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null,
  };
}

// Derived-lane carrier marking (add-turn-metering §15.115挂账 enrichment, cut ⑤
// follow-up): the handoff/fanout/event-wake seam writes synthetic failure rows
// for turns that NEVER dispatched (depth bound, missing edge args, hourly cap)
// — no task, no executor, so the execution-carrier mark never lands. Those rows
// still belong to a lane: a2a targets always ride the remote lane; persona
// members resolve through the same three layers as dispatch (member → fleet
// constraint → env default), mapped into the metering vocabulary
// (runner→remote, worker→worker, auto/cell→cell). The column marks the LANE,
// never a claimed body — carrierInstance stays null, and the runtime fields
// (queue/spin/ttft/usage) stay honestly absent. Tool/cluster targets carry no
// lane (consistent with executed tool turns, which stamp none). The layer
// order is pinned against resolveTaskCarrier by test.
export function derivedLaneCarrier({ member = null, fleet = null, targetKind = null } = {}) {
  if (targetKind === "a2a") return "remote";
  if (targetKind !== "persona") return null;
  const val = (v) => (["cell", "worker", "runner"].includes(v) ? v : null);
  const rc =
    val(member?.carrier) ??
    val(fleet?.orchestration?.constraints?.carrier) ??
    val(String(process.env.CELL_CARRIER_DEFAULT ?? "").trim()) ??
    "auto";
  return rc === "runner" ? "remote" : rc === "worker" ? "worker" : "cell";
}
