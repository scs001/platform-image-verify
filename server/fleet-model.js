// Fleet post-model core (add-fleet-post-model).
//
// Two pure pieces shared by the write face and the turn path:
//   1. fleetModelChoiceError — the write-time gate, the SAME three gates the
//      serving deploy config uses (shape → roster → lanes when known), so a
//      fleet post and a served agent refuse illegal models with one voice.
//   2. resolveModelChain — the turn-time resolution chain
//      [post model, post fallback, fleet default, cell default]: deduped,
//      first roster hit wins. Declared-but-missing hops yield notices for the
//      turn's blocker trace; undeclared hops pass silently (inheritance is
//      normal, failure is an event). Write-time validity never guarantees
//      runtime validity — the roster drifts — which is exactly why the chain
//      exists (design D2/D5).

import { MODEL_ID_RE } from "../lib/pack-manifest.js";
import { modelChoiceError } from "../lib/agent-serving.js";

// Returns the error string or null. `roster`/`lanes` null = unknowable → that
// gate stays open (mirrors modelChoiceError's own degrade-open semantics).
export function fleetModelChoiceError({ model, roster = null, lanes = null }) {
  if (typeof model !== "string" || !MODEL_ID_RE.test(model)) {
    return `model '${model}' is not a valid model identifier`;
  }
  return modelChoiceError({ model, whitelist: null, lanes, roster });
}

const SOURCE_LABELS = {
  member: "post model",
  "member-fallback": "post fallback model",
  "fleet-default": "fleet default model",
  "cell-default": "cell default model",
};

// The chain, in resolution order. Returns:
//   candidates — roster-valid hops in order (all roster-valid when the roster
//                is unknown; the switch loop walks past one if drift bites)
//   effective  — candidates[0]?.model ?? null (null = honest turn failure)
//   notices    — one line per DECLARED hop the roster rejected
export function resolveModelChain({ model = null, fallbackModel = null, fleetDefault = null, cellDefault = null, roster = null }) {
  const declared = [
    { model, source: "member" },
    { model: fallbackModel, source: "member-fallback" },
    { model: fleetDefault, source: "fleet-default" },
    { model: cellDefault, source: "cell-default" },
  ];
  const seen = new Set();
  const chain = [];
  for (const hop of declared) {
    if (!hop.model || seen.has(hop.model)) continue;
    seen.add(hop.model);
    chain.push(hop);
  }
  const candidates = [];
  const notices = [];
  let landed = false;
  for (const hop of chain) {
    const alive = roster == null || roster.includes(hop.model);
    if (alive) {
      candidates.push(hop);
      landed = true;
    } else if (!landed) {
      // Only hops consulted BEFORE the landing are "fallen through"; hops past
      // the effective one are silent walk-past backups — noticing them would
      // cry wolf about models the turn never needed.
      notices.push(`declared ${SOURCE_LABELS[hop.source]} '${hop.model}' is not in the runner's model roster — falling through`);
    }
  }
  return { effective: candidates[0]?.model ?? null, candidates, notices };
}
