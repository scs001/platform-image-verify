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
  "other",
];

const ERROR_KIND_PATTERNS = [
  ["runtime_not_ready", /not ready|still starting|stayed busy|could not switch the agent|runtime.*(busy|idle)|未就绪/i],
  ["timeout", /timeout|timed? ?out|超时/i],
  ["tool_permission", /permission|denied|forbidden|not authorized|unauthorized|403|工具|权限/i],
  ["model_upstream", /no runnable model|model switch|invalid model|429|quota|rate.?limit|provider|upstream|api.?key|api_error|service temporarily unavailable|5\d{2}\s*:|上游|模型/i],
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

// `outcome` is the executor's return: { ok, error?, interrupted?, usage? }.
// `meta` carries { startedAt, endedAt, model } from the seam (the wrapper
// knows when the turn began and what the runtime landed on). Returns the
// stored event, or null when the turn carries no fleet attribution.
export function recordTurnEvent(db, job, outcome, { startedAt, endedAt, model = null, rosterPresetId = (id) => id } = {}) {
  // Single derivation source (agent-turn-contract): attribution and source
  // both read off the same turnRequest — one rule for both doors.
  const request = buildTurnRequest(job);
  let fleetId = null;
  let memberId = null;
  if (request.evidence.sourceTag?.fleetId) {
    fleetId = request.evidence.sourceTag.fleetId;
    memberId = request.evidence.sourceTag.memberId ?? null;
  } else if (request.evidence.origin?.fleet?.fleetId) {
    fleetId = request.evidence.origin.fleet.fleetId;
    memberId = request.evidence.origin.fleet.memberId ?? null;
  } else {
    const post = attributedPostFor(db, request.targetRef.id, rosterPresetId);
    if (post) {
      fleetId = post.fleetId;
      memberId = post.memberId;
    }
  }
  if (!fleetId || !memberId) return null;

  const ok = outcome?.ok === true;
  const interrupted = outcome?.interrupted === true;
  const status = ok ? "ok" : interrupted ? "interrupted" : "failed";
  return db.appendTurnEvent({
    fleetId,
    memberId,
    source: request.source,
    status,
    errorKind: ok ? null : classifyErrorKind(outcome?.error),
    error: ok ? null : String(outcome?.error ?? "execution failed").slice(0, 500),
    model: model ?? outcome?.usage?.model ?? null,
    startedAt,
    endedAt,
    sessionId: job?.sessionId ?? null,
  });
}
