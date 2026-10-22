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
    };
  } catch (e) {
    console.warn(`[cluster-memory] unavailable (degrade open): ${e?.message || e}`);
    return null;
  }
}
