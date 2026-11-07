// ── fleet working memory (add-zhiyu-team-memory 刀A; add-member-knowledge-
// profile capture split) ─────────────────────────────────────────────────────
//
// The cell-side lane for a FLEET's working memory. Since the member split,
// facts land in the DEPLOYMENT namespace with per-member deployment tokens:
//   岗位私有 (turn / health)      → the member's own partition d/<pack>/<member>
//   团队事实 (decision-* / swap) → the pack's shared partition
// Each page carries FIRST-CLASS metadata {fleetId, memberId, kind} (openspec:
// agent-memory-foundation) — titles are human text again, never machine
// addressing. The legacy `f/<fleetId>` owner project STOPS receiving writes;
// its pages stay readable and the digest composes them during the transition
// window (they decay naturally — no new rows ever land there).
//
// Degrade-open by contract (spec: capture 失败 MUST NOT 阻塞回合，digest 缺席
// 即段缺席): every failure is a counter, never an error into the turn.
//
// Five fact kinds (spec: fleet-turn-memory): turn (报数摘要 via outcome),
// health (状态迁移 ok↔failed flip), decision-opened, decision-resolved, swap.
// Idempotency: a bounded in-process key set dedupes (fleetId, memberId, kind,
// ts) replays; cross-restart replay is a non-goal (fire-and-forget capture).

import { cellMemoryConfig, personTokenFor, memberTokenFor } from "../cell-memory.js";
import { digestTimeoutMs } from "./cluster-memory.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

const CAPTURE_DEDUP_MAX = 512;

// The closed own/shared split (spec: five kinds is a closed set — the mapping
// is deliberately NOT configurable; a fourth opinion here would be a fourth
// caliber). turn/health are the post's PRIVATE output; decisions and swaps
// are team facts every member must see.
const KIND_PARTITION = {
  turn: "own",
  health: "own",
  "decision-opened": "shared",
  "decision-resolved": "shared",
  swap: "shared",
};

export function fleetProjectId(fleetId) {
  const out = String(fleetId ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
  return out ? `f/${out}` : "f/unknown";
}

// The member's own-partition project name inside the d/ root: fd-memory
// resolves d/<packId>/<memberId> to root "d-<packId>", project "<memberId>"
// — the wire project IS the memberId (registry metadata.agentId coordinate,
// same rule agent-runner/memory-mount.js runs on the runner carrier).
export function memberProjectId(memberId) {
  const out = String(memberId ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
  return out || "unknown";
}

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
      const partition = KIND_PARTITION[kind];
      if (!partition) {
        // Unknown kind: never silently dropped into a wrong partition — count
        // it as a failure so the operator sees the fifth-kind drift.
        failures += 1;
        return false;
      }
      try {
        await memory.writeFact({ fleetId, memberId, kind, partition, title, body });
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

// Returns { writeFact, writeSharedPage, readDigest } or null (config off / no
// owner / mint failure) — the degrade-open posture fleetMemoryFor established.
export async function fleetMemoryFor(env, ownerEmail, fetchImpl = fetch) {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    // The person token stays for the legacy transition read (f/ digest); the
    // member token is minted lazily PER FLEET MEMBER — the fleet IS the
    // deployment (d/<fleetId>/<memberId>, shared = d/<fleetId>/shared), so
    // each team gets its own root and its own team-facts partition. Cache is
    // by (fleetId, memberId): 换防不换 (the token belongs to the role), and a
    // renamed fleet keeps its id.
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    const memberTokens = new Map();
    const tokenForMember = async (fleetId, memberId) => {
      const key = `${fleetId}|${memberId}`;
      const cached = memberTokens.get(key);
      if (cached) return cached;
      const t = await memberTokenFor(cfg, { packId: fleetId, memberId, ownerEmail }, fetchImpl);
      memberTokens.set(key, t);
      return t;
    };
    const post = async (tok, project, title, body, metadata) => {
      // Outbound call discipline: shared deadline wrapper (default env bound);
      // fetchImpl stays the test seam.
      const r = await fetchWithTimeout(`${cfg.url}/pages`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify({ project, title, body, ...(metadata ? { metadata } : {}) }),
      }, { fetchImpl });
      if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
      return await r.json();
    };
    const digestOnce = async (tok, project, q, { k = 5, budget = 1200 } = {}) => {
      const u = new URL(`${cfg.url}/digest`);
      u.searchParams.set("project", project);
      if (q) u.searchParams.set("q", String(q));
      u.searchParams.set("k", String(k));
      u.searchParams.set("budget", String(budget));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), digestTimeoutMs(env));
      try {
        const r = await fetchImpl(u, { headers: { authorization: `Bearer ${tok}` }, signal: controller.signal });
        if (!r.ok) throw new Error(`digest HTTP ${r.status}`);
        const json = await r.json();
        // fd-memory's face names the rendered text `digest`; the ladder below
        // reads `.block` — normalize here so every segment speaks one shape.
        return { block: typeof json?.digest === "string" ? json.digest : (json?.block ?? "") };
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      // The split write: partition comes from the closed kind map; metadata
      // carries the structured triple, titles stay human. IMPORTANT: BOTH
      // partitions go through the MEMBER's deployment token — fd-memory
      // resolves project "shared" for a deployment token to the PACK's shared
      // partition (d/<fleetId>/shared), so a person token here would
      // misfile team facts into the owner's u/ root.
      async writeFact({ fleetId, memberId, kind, partition, title, body }) {
        const metadata = { fleetId, memberId, kind };
        const tok = await tokenForMember(fleetId, memberId);
        if (partition === "own") {
          await post(tok, memberProjectId(memberId), title, body, metadata);
        } else {
          await post(tok, "shared", title, body, metadata);
        }
      },
      // The team's own direct shared write (used by lanes that already know
      // they are team-level, e.g. the swap recorder on other carriers). Rides
      // the acting member's deployment token for the same reason as above.
      async writeSharedPage({ fleetId, memberId, title, body, metadata }) {
        const tok = await tokenForMember(fleetId, memberId);
        await post(tok, "shared", title, body, metadata ?? null);
      },
      // The fleetContext memory section — the ladder composes THREE sources
      // under one budget, gated by the member's knowledge scope: the member's
      // own partition, the fleet's shared partition (BOTH through the
      // member's deployment token — the shared project name resolves to
      // d/<fleetId>/shared only for a deployment token), and the legacy f/
      // digest via the person token (transition window; decays as it stops
      // receiving writes). Each segment renders server-side with the same
      // budget discipline; any failure drops THAT segment, never the whole
      // section. scope "shared" skips the own probe; "off" never reaches
      // this call (the caller checks first).
      async readDigest(fleetId, memberId, q, { k = 5, budget = 1200, scope = "own+shared" } = {}) {
        const segBudget = Math.max(64, Math.floor(budget / 3));
        let memberTok = null;
        if (scope === "own+shared") {
          try {
            memberTok = await tokenForMember(fleetId, memberId);
          } catch {
            // the member token IS the own/shared identity — without it both
            // d/ segments drop and only the legacy f/ digest can render
          }
        }
        const segments = [];
        const probes = [
          { name: "own", project: memberProjectId(memberId), token: memberTok, q: q ?? "" },
          { name: "shared", project: "shared", token: memberTok, q: q ?? "" },
          { name: "legacy", project: fleetProjectId(fleetId), token, q: (q ?? "") || String(memberId ?? "") },
        ];
        for (const probe of probes) {
          if (!probe.token) continue;
          try {
            const out = await digestOnce(probe.token, probe.project, probe.q, { k, budget: segBudget });
            if (typeof out?.block === "string" && out.block.trim()) {
              segments.push({ source: probe.name, block: out.block });
            }
          } catch {
            // one segment failing is a counter-shaped absence, not an error
          }
        }
        if (segments.length === 0) return null;
        // The renderer's own header repeats per segment — the ladder labels
        // each source once and concatenates bodies; empty segments are gone.
        return {
          sources: segments.map((s) => s.source),
          block: segments.map((s) => `【${s.source === "own" ? "本岗位记忆" : s.source === "shared" ? "团队记忆" : "历史团队记忆"}】\n${s.block}`).join("\n\n"),
        };
      },
    };
  } catch (e) {
    console.warn(`[fleet-memory] unavailable (degrade open): ${e?.message || e}`);
    return null;
  }
}
