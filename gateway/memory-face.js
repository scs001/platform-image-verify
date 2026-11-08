// ── Memory read face (harden-platform-memory-carrier 1.2) ───────────────────
//
// GET /api/monitoring/memory — the three-layer distribution face: container
// cgroup水位 → per-cell process RSS groups → process rows. One route, two
// scopes: admins see the full pod; a signed-in owner sees the shared container
//水位 plus ONLY their own cells' rows (the owner-board discipline — 部署级
// 信息不向普通用户枚举别人的进程). The threshold rides the response so the
// cockpit card ambers against the exact number the admission gate enforces.

import { headroomPct } from "../lib/proc-memory.js";

export function defaultAdmissionThreshold(env = process.env) {
  const raw = Number(env.CELL_MEMORY_ADMISSION_FLOOR ?? 0.15);
  return Number.isFinite(raw) ? raw : 0.15;
}

// Pure projection: the sampler's snapshot + registry rows → response shape.
// Non-admin scoping: cells filtered to the caller's own rows (registry join by
// ownerEmail); gateway/ungrouped reduce to totals so another user's process
// list never leaks, while the shared container truth (usage/limit) still reads.
export function memoryFace({ sample, registryDb = null, ownerEmail = null, isAdmin = false, threshold = defaultAdmissionThreshold() }) {
  if (!sample?.available) {
    return {
      available: false,
      reason: sample?.reason ?? "metrics_unavailable",
      sampledAt: sample?.sampledAt ?? Date.now(),
    };
  }
  const ownerByCellId = new Map(
    (registryDb?.all?.() ?? []).map((r) => [r.cellId, r.ownerEmail ?? null]),
  );
  const withOwner = (cell) => ({ ...cell, ownerEmail: ownerByCellId.get(cell.cellId) ?? null });
  const totalsOnly = ({ totalBytes }) => ({ totalBytes });

  const cells = sample.cells.map(withOwner);
  const scoped = isAdmin
    ? {
        cells,
        gateway: sample.gateway,
        ungrouped: sample.ungrouped,
      }
    : {
        cells: cells.filter((c) => ownerEmail != null && c.ownerEmail === ownerEmail),
        gateway: totalsOnly(sample.gateway),
        ungrouped: totalsOnly(sample.ungrouped),
      };

  const container = {
    ...sample.container,
    ...(sample.container?.available
      ? { headroomPct: headroomPct(sample.container) }
      : {}),
    threshold,
  };
  return {
    available: true,
    sampledAt: sample.sampledAt,
    container,
    ...scoped,
    buckets: sample.buckets,
  };
}

export function registerMemoryFaceRoute(app, { sampler, registryDb = null, resolveUser, rejectUnauthenticated, isAdminUser, threshold = defaultAdmissionThreshold() }) {
  app.get("/api/monitoring/memory", (req, res) => {
    const user = resolveUser(req);
    if (!user) return rejectUnauthenticated(req, res);
    try {
      const face = memoryFace({
        sample: sampler.sample(),
        registryDb,
        ownerEmail: user.email,
        isAdmin: isAdminUser(user),
        threshold,
      });
      res.json(face);
    } catch (err) {
      console.error("[gateway] memory face error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
}
