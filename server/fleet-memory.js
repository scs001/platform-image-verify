// ── fleet working memory (add-zhiyu-team-memory 刀A) ────────────────────────
//
// The cell-side lane for a FLEET's working memory: the owner's person token
// writes turn facts as pages of the `f/<fleetId>` project under the owner's
// memory root, over fd-memory's platform-seam /pages + /digest faces — the
// SAME infrastructure the cluster shared-memory lane uses
// (server/cluster-memory.js), not a second service. Zero LLM at capture
// (L0/L1 observations); L2 distillation rides fd-memory's own budgeted lane.
//
// Degrade-open by contract (spec: capture 失败 MUST NOT 阻塞回合，digest 缺席
// 即段缺席): every failure is a counter, never an error into the turn.
//
// Five fact kinds (spec: fleet-turn-memory): turn (报数摘要 via outcome),
// health (状态迁移 ok↔failed flip), decision-opened, decision-resolved, swap.
// Idempotency: a bounded in-process key set dedupes (fleetId, memberId, kind,
// ts) replays; cross-restart replay is a non-goal (fire-and-forget capture).

import { cellMemoryConfig, personTokenFor } from "../cell-memory.js";
import { digestTimeoutMs } from "./cluster-memory.js";

export function fleetProjectId(fleetId) {
  const out = String(fleetId ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
  return out ? `f/${out}` : "f/unknown";
}

const CAPTURE_DEDUP_MAX = 512;

export function createFleetMemoryCapture({ memory, clock = Date.now } = {}) {
  if (!memory) return null;
  const seen = new Set();
  const seenKeys = [];
  let failures = 0;
  let captured = 0;
  return {
    get failures() {
      return failures;
    },
    get captured() {
      return captured;
    },
    async capture(fleetId, memberId, kind, title, body) {
      const ts = clock();
      // The idempotency key includes the CONTENT, not just the timestamp: a
      // fixed clock (tests, fast back-to-back turns) must not dedupe two
      // distinct facts; a genuine replay (same fact re-delivered) still does.
      const key = `${fleetId}|${memberId}|${kind}|${ts}|${title}|${body}`;
      if (seen.has(key)) return null; // replay within the window → idempotent
      seen.add(key);
      seenKeys.push(key);
      if (seenKeys.length > CAPTURE_DEDUP_MAX) seen.delete(seenKeys.shift());
      try {
        await memory.writeFleetPage(fleetId, `[${kind}][${memberId}] ${title}`, body);
        captured += 1;
        return true;
      } catch {
        failures += 1; // the turn never learns; the counter is the observability
        return false; // false = failed (null = replay-deduped, no attempt made)
      }
    },
  };
}

// Health-flip tracker: remembers each member's last settled status and emits
// an observation when it FLIPS (ok↔failed) — the memory narrative for "who
// recovered / who started failing" without per-turn noise.
export function createHealthFlipTracker() {
  const last = new Map();
  return (fleetId, memberId, status) => {
    const key = `${fleetId}|${memberId}`;
    const prev = last.get(key);
    last.set(key, status);
    if (prev === undefined || prev === status) return false;
    return true;
  };
}

// Returns { writeFleetPage, readDigest } or null (config off / no owner /
// mint failure) — the degrade-open posture clusterMemoryFor established.
export async function fleetMemoryFor(env, ownerEmail, fetchImpl = fetch) {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    return {
      async writeFleetPage(fleetId, title, body) {
        const r = await fetchImpl(`${cfg.url}/pages`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ project: fleetProjectId(fleetId), title, body }),
        });
        if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
        return await r.json();
      },
      // The digest face for the fleetContext memory section — server-side
      // rendered, member-relevant via the relevance query (the member title),
      // same budget discipline as the cluster lane. Degrade-open: the caller
      // treats any throw as "section absent".
      async readDigest(fleetId, q, { k = 5, budget = 1200 } = {}) {
        const u = new URL(`${cfg.url}/digest`);
        u.searchParams.set("project", fleetProjectId(fleetId));
        u.searchParams.set("q", String(q ?? ""));
        u.searchParams.set("k", String(k));
        u.searchParams.set("budget", String(budget));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), digestTimeoutMs(env));
        try {
          const r = await fetchImpl(u, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
          if (!r.ok) throw new Error(`digest HTTP ${r.status}`);
          return await r.json();
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (e) {
    console.warn(`[fleet-memory] unavailable (degrade open): ${e?.message || e}`);
    return null;
  }
}
