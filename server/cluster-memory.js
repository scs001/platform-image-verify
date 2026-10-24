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
      // rendered block from fd-memory — 5s budget, one shot, no retry (the
      // caller's ladder falls back to the title list on any failure).
      async readDigest(clusterId, q, { k = 5, budget = 1500 } = {}) {
        const u = new URL(`${cfg.url}/digest`);
        u.searchParams.set("project", clusterProjectId(clusterId));
        u.searchParams.set("q", String(q ?? ""));
        u.searchParams.set("k", String(k));
        u.searchParams.set("budget", String(budget));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
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

// The fan-out injection ladder (add-cluster-digest-injection design D3):
// digest face first (server-rendered block, proven by the continuation eval),
// fall back to the historical title list, fall back to nothing. One warn per
// degraded rung; memory never fails a turn. CELL_MEMORY_DIGEST=0 is the
// rollback lever that skips the digest rung only.
export async function memoryInjectionFor(clusterMemory, clusterId, prompt, env = process.env) {
  if (!clusterMemory) return { prompt, source: "none" };
  if (env.CELL_MEMORY_DIGEST !== "0") {
    try {
      const d = await clusterMemory.readDigest(clusterId, prompt, {
        k: Number(env.CELL_MEMORY_DIGEST_K ?? 5) || 5,
        budget: Number(env.CELL_MEMORY_DIGEST_BUDGET ?? 1500) || 1500,
      });
      if (d?.digest) return { prompt: `${prompt}\n\n${d.digest}`, source: "digest" };
    } catch (e) {
      console.warn(`[cluster] digest read failed for ${clusterId} (fallback to titles): ${e?.message || e}`);
    }
  }
  try {
    const sharedPages = await clusterMemory.readShared(clusterId, 5);
    if (sharedPages.length) {
      const block = sharedPages.map((p) => `- ${p.title}（${String(p.updated_at ?? "").slice(0, 10)}）`).join("\n");
      return { prompt: `${prompt}\n\n【集群共享记忆】本集群此前回合的沉淀，供参考：\n${block}`, source: "titles" };
    }
  } catch (e) {
    console.warn(`[cluster] shared-memory read failed for ${clusterId} (degrade open): ${e?.message || e}`);
  }
  return { prompt, source: "none" };
}
