// ── cluster shared memory (add-memory-scopes-and-cluster-sharing) ───────────
//
// The cell-side lane for a cluster's shared memory: the owner's person token
// reads and writes pages of the cluster-id project under the owner's memory
// root, over fd-memory's platform-seam /pages face. Used by the cron engine's
// two cluster-turn hooks (context injection before fan-out, digest write-back
// after aggregation). Degrade-open by contract: any failure returns null (or
// throws from a call) and the cluster turn proceeds exactly as with memory
// off — memory never fails a task.

import { cellMemoryConfig, personTokenFor } from "../cell-memory.js";

export function clusterProjectId(clusterId) {
  const out = String(clusterId ?? "").trim().replace(/[/\\]+/g, "-").slice(0, 128);
  return out || "cluster";
}

// The digest read timeout (fix-digest-adaptive-embed-deadline). Must sit ABOVE
// fd-memory's internal embed budget cap, or we hang up on a request the
// callee is still finishing and lose the block instead of receiving its
// degraded form. Defaults to 9000 (cap 8000 + transport headroom); set it
// below the cap and the ladder will skip straight past the digest rung, which
// is exactly the misconfiguration this exists to make visible.
export function digestTimeoutMs(env = process.env) {
  const raw = Number(env.CELL_MEMORY_DIGEST_TIMEOUT_MS ?? 9000);
  const n = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 9000;
  return Math.max(500, Math.min(60_000, n));
}

// Returns { readShared, writeDigest } or null (config off / no owner / mint
// failure). The person token is the same one the memory mount mints and
// caches on disk — one mint per owner, restart-stable.
export async function clusterMemoryFor(env, ownerEmail, fetchImpl = fetch) {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    return {
      async readShared(clusterId, limit = 5) {
        const r = await fetchImpl(
          `${cfg.url}/pages?project=${encodeURIComponent(clusterProjectId(clusterId))}&limit=${limit}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
        const doc = await r.json();
        return Array.isArray(doc?.pages) ? doc.pages : [];
      },
      async writeDigest(clusterId, title, body) {
        const r = await fetchImpl(`${cfg.url}/pages`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ project: clusterProjectId(clusterId), title, body }),
        });
        if (!r.ok) throw new Error(`pages HTTP ${r.status}`);
        return await r.json();
      },
      // The digest read face (add-cluster-digest-injection): server-side
      // rendered block from fd-memory — one shot, no retry (the caller's ladder
      // falls back to the title list on any failure).
      //
      // Timeout (fix-digest-adaptive-embed-deadline): this used to be a flat
      // 5s, which sat BELOW fd-memory's own embed budget (8000ms). When the
      // embedding upstream was slow, fd-memory was still working on the answer
      // while we had already hung up — so the block was lost outright instead
      // of arriving in its degraded (keyword) form. The caller must be more
      // patient than the callee's internal budget, hence the 9s default; it
      // costs nothing on the fast path (milliseconds) and is configurable.
      async readDigest(clusterId, q, { k = 5, budget = 1500 } = {}) {
        const u = new URL(`${cfg.url}/digest`);
        u.searchParams.set("project", clusterProjectId(clusterId));
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
    console.warn(`[cluster-memory] unavailable (degrade open): ${e?.message || e}`);
    return null;
  }
}

// The injection ladder (add-cluster-digest-injection design D3): digest face
// first (server-rendered block, proven by the continuation eval), fall back
// to the title list, fall back to nothing. One warn per degraded rung;
// memory never fails a turn. Extracted at project level (add-chat-memory-
// injection D3) so the chat lane runs the same ladder under its own switch;
// the cluster wrapper keeps its exact historical bytes (pinned by tests).
// Returns the block alone (empty string when memory is off/unavailable) so a
// caller that assembles its OWN prompt can append the identical text the chat
// lane would have produced — the room lane does (add-unified-memory-and-outputs
// D7: facade/智语 ride the same seam, not a parallel one). Every rung keeps the
// chat lane's exact bytes; the prompt-composing wrappers below are the proof.
async function digestLadder(cm, project, prompt, { digestOn, k, budget, titlesLabel, warnTag, warnName }) {
  if (!cm) return { block: "", source: "none" };
  if (digestOn) {
    try {
      const d = await cm.readDigest(project, prompt, { k, budget });
      if (d?.digest) return { block: d.digest, source: "digest" };
    } catch (e) {
      console.warn(`[${warnTag}] digest read failed for ${warnName} (fallback to titles): ${e?.message || e}`);
    }
  }
  try {
    const sharedPages = await cm.readShared(project, 5);
    if (sharedPages.length) {
      const lines = sharedPages.map((p) => `- ${p.title}（${String(p.updated_at ?? "").slice(0, 10)}）`).join("\n");
      return { block: `${titlesLabel}\n${lines}`, source: "titles" };
    }
  } catch (e) {
    console.warn(`[${warnTag}] shared-memory read failed for ${warnName} (degrade open): ${e?.message || e}`);
  }
  return { block: "", source: "none" };
}

const ladderEnv = (env) => ({
  k: Number(env.CELL_MEMORY_DIGEST_K ?? 5) || 5,
  budget: Number(env.CELL_MEMORY_DIGEST_BUDGET ?? 1500) || 1500,
});

// Chat-lane ladder config, shared by the prompt wrapper and the block reader
// so the two can never drift (the room lane reads the block from here).
const CHAT_TITLES_LABEL = "【工作记忆】此前会话的沉淀，供参考：";
const chatLadder = (cm, query, env) =>
  digestLadder(cm, "default", String(query ?? ""), {
    digestOn: true,
    ...ladderEnv(env),
    titlesLabel: CHAT_TITLES_LABEL,
    warnTag: "chat-memory",
    warnName: "default",
  });

// Cluster lane: CELL_MEMORY_DIGEST=0 is the rollback lever that skips the
// digest rung only. Signature and behavior unchanged.
export async function memoryInjectionFor(clusterMemory, clusterId, prompt, env = process.env) {
  const { block, source } = await digestLadder(clusterMemory, clusterProjectId(clusterId), prompt, {
    digestOn: env.CELL_MEMORY_DIGEST !== "0",
    ...ladderEnv(env),
    titlesLabel: "【集群共享记忆】本集群此前回合的沉淀，供参考：",
    warnTag: "cluster",
    warnName: clusterId,
  });
  return { prompt: block ? `${prompt}\n\n${block}` : prompt, source };
}

// Chat lane (add-chat-memory-injection D2/D3): same ladder over the owner's
// memory root, project fixed to "default" — the project person tokens' MCP
// writes land in (fd-memory namespaceParts) — so the read face equals the
// write face. CELL_MEMORY_CHAT_DIGEST=0 is the chat lane's TOTAL kill switch
// (spec: byte-identical prompt, zero fd-memory requests) — unlike the cluster
// lever, which skips only the digest rung; k/budget shared with the cluster.
export async function chatMemoryInjectionFor(clusterMemory, prompt, env = process.env) {
  if (env.CELL_MEMORY_CHAT_DIGEST === "0") return { prompt, source: "none" };
  const { block, source } = await chatLadder(clusterMemory, prompt, env);
  return { prompt: block ? `${prompt}\n\n${block}` : prompt, source };
}

// The block face of the chat lane (add-unified-memory-and-outputs D7): callers
// that assemble their own prompt (the 智语 room turn) get the identical text
// and the identical switch, so their lanes can never diverge from chat. "" on
// off/kill/unavailable — never throws.
export async function chatMemoryBlockFor(ownerEmail, query, env = process.env, fetchImpl = fetch) {
  if (!ownerEmail || env.CELL_MEMORY_CHAT_DIGEST === "0") return { block: "", source: "none" };
  try {
    const cm = await chatMemoryClientFor(ownerEmail, env, fetchImpl);
    if (!cm) return { block: "", source: "none" };
    return await chatLadder(cm, query, env);
  } catch (e) {
    console.warn(`[chat-memory] block read failed for ${ownerEmail} (degrade open): ${e?.message || e}`);
    return { block: "", source: "none" };
  }
}

// Client cache for the ws chat lane: one memory client per owner email.
// Resolved clients are cached for the process lifetime; a null result while
// the config is on (transient mint failure) is dropped so the next turn
// retries instead of staying dark until restart.
const chatClients = new Map();
export async function chatMemoryClientFor(ownerEmail, env = process.env, fetchImpl = fetch) {
  if (!ownerEmail) return null;
  let p = chatClients.get(ownerEmail);
  if (!p) {
    p = clusterMemoryFor(env, ownerEmail, fetchImpl);
    chatClients.set(ownerEmail, p);
  }
  const cm = await p;
  if (!cm && cellMemoryConfig(env)) chatClients.delete(ownerEmail);
  return cm;
}

// The ws-lane wiring (add-chat-memory-injection D1): no identity or any
// failure leaves the prompt untouched — memory never fails a chat turn.
export async function chatPromptWithMemory(ownerEmail, prompt, env = process.env, fetchImpl = fetch) {
  if (!ownerEmail) return prompt;
  try {
    const cm = await chatMemoryClientFor(ownerEmail, env, fetchImpl);
    if (!cm) return prompt;
    return (await chatMemoryInjectionFor(cm, prompt, env)).prompt;
  } catch (e) {
    console.warn(`[chat-memory] injection failed for ${ownerEmail} (degrade open): ${e?.message || e}`);
    return prompt;
  }
}
