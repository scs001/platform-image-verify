// external-sources.js — Read-only mirror of external skill markets (刀一).
//
// openspec: add-external-skill-sources. Each external market is an adapter
// implementing two operations (list + get) that return the normalized Entry
// shape below. The registry decides which adapters are enabled
// (EXTERNAL_SKILL_SOURCES); a snapshot cache bounds upstream traffic (TTL
// ≤1h) and keeps the last good data on failure (stale-on-failure, the same
// posture registry-bridge established for the self-hosted registry).
//
// Read-only boundary (spec): nothing here writes the database, the skill
// store, or the materialization tree — external metadata is display-only.
// Installation is 刀二 territory with its own governance surface.

const SNAPSHOT_TTL_MS = 60 * 60 * 1000; // spec: at most 1 hour
const DEFAULT_PAGE_SIZE = 20; // design D6
const MAX_PAGE_SIZE = 50;

export function parseSourceSelection(env, knownIds) {
  const raw = (env ?? "").trim();
  // Unset/empty = all known sources enabled (spec scenario).
  if (!raw) return [...knownIds];
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  // Unknown ids are ignored silently (design D6) — a typo must not kill the shelf.
  return knownIds.filter((id) => wanted.includes(id));
}

export function requestedPageSize(env) {
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

// Shared outbound helper (design D7): bounded, credential-free, platform UA.
export async function outboundFetch(url, { signal, headers } = {}) {
  const timer = AbortSignal.timeout(10_000);
  const composed = signal ? AbortSignal.any([signal, timer]) : timer;
  return fetch(url, {
    signal: composed,
    headers: {
      Accept: "application/json",
      "User-Agent": "yizuo-external-skill-sources/1.0 (+https://finddatatech.cloud)",
      ...headers,
    },
  });
}

// ── Snapshot cache ────────────────────────────────────────────────────────────
// Key = request shape (sourceId + op + params). Bad/failed refreshes keep the
// previous { at, data } and flag it stale; a source that has never succeeded
// reports an error state instead of inventing data.

export function createSnapshotCache({ ttlMs = SNAPSHOT_TTL_MS, now = Date.now } = {}) {
  const map = new Map();
  async function resolve(key, loader) {
    const hit = map.get(key);
    // fresh = this call actually ran the loader (first load or past-TTL revalidate)
    if (hit && now() - hit.at < ttlMs && !hit.stale) return { ...hit, fresh: false };
    try {
      const data = await loader();
      const entry = { at: now(), data, stale: false };
      map.set(key, entry);
      return { ...entry, fresh: true };
    } catch (err) {
      if (hit) return { ...hit, stale: true, error: String(err?.message || err) };
      throw err;
    }
  }
  return { resolve, peek: (key) => map.get(key), size: () => map.size };
}

// ── Normalized Entry shape ────────────────────────────────────────────────────
// licenseState: declared / not-declared / unknown (spec: exactly these three)
// versionLayer: which metadata layer a version came from (Tencent's own
// packages carry contradictory versions across layers — recorded, not judged).

export function normalizeEntry({ source, id, name, displayName, description, originUrl, licenseState, licenseText, version, versionLayer, downloads, stars, tags, extras }) {
  return {
    source,
    id: String(id ?? name),
    name: String(name ?? id ?? ""),
    displayName: displayName || name || String(id ?? ""),
    description: String(description ?? "").slice(0, 2000),
    originUrl: originUrl || null,
    licenseState: licenseState === "declared" || licenseState === "not-declared" ? licenseState : "unknown",
    licenseText: licenseText ?? null,
    version: version != null ? String(version) : null,
    versionLayer: versionLayer ?? null,
    downloads: Number.isFinite(downloads) ? downloads : null,
    stars: Number.isFinite(stars) ? stars : null,
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
    extras: extras && typeof extras === "object" ? extras : null,
  };
}

// ── Source adapters ───────────────────────────────────────────────────────────

// Tencent SkillHub (skillhub.cn) — free public REST, no auth (verified live
// 2026-10-14). Search has no cursor/total; the limit param IS the cap. Entries
// carry no license field → licenseState "unknown" (self-descriptions in free
// text are not machine-checkable). originUrl is the market page.
const SKILLHUB_BASE = process.env.SKILLHUB_API_BASE || "https://api.skillhub.cn/api/v1";

export function createSkillhubAdapter({ fetchImpl = outboundFetch } = {}) {
  async function search(q, limit) {
    const url = `${SKILLHUB_BASE}/search?q=${encodeURIComponent(q)}&limit=${limit}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`skillhub search HTTP ${res.status}`);
    const doc = await res.json();
    const results = Array.isArray(doc?.results) ? doc.results : [];
    return results.map((r) =>
      normalizeEntry({
        source: "skillhub",
        id: r.slug,
        name: r.slug,
        displayName: r.displayName || r.name || r.slug,
        description: r.description || r.description_zh || r.summary || "",
        originUrl: r.namespace?.publicSlug
          ? `https://skillhub.cn/skills/${r.namespace.publicSlug}`
          : `https://skillhub.cn/skills/${r.slug}`,
        licenseState: "unknown",
        version: r.version ?? null,
        versionLayer: "market-metadata",
        downloads: Number(r.downloads),
        stars: Number(r.stars),
        tags: Array.isArray(r.tags) ? r.tags : [r.category].filter(Boolean),
        extras: { category: r.category ?? null, requiresApiKey: Boolean(r.labels?.requires_api_key) },
      }),
    );
  }
  async function get(slug) {
    const res = await fetchImpl(`${SKILLHUB_BASE}/skills/${encodeURIComponent(slug)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`skillhub detail HTTP ${res.status}`);
    const r = await res.json();
    const entry = Array.isArray(r) ? r[0] : r?.skill ?? r;
    if (!entry) return null;
    return normalizeEntry({
      source: "skillhub",
      id: entry.slug ?? slug,
      name: entry.slug ?? slug,
      displayName: entry.displayName || entry.name || slug,
      description: entry.description || entry.description_zh || entry.summary || "",
      originUrl: `https://skillhub.cn/skills/${entry.slug ?? slug}`,
      licenseState: "unknown",
      version: entry.version ?? null,
      versionLayer: "market-metadata",
      downloads: Number(entry.downloads),
      stars: Number(entry.stars),
      tags: Array.isArray(entry.tags) ? entry.tags : [entry.category].filter(Boolean),
    });
  }
  return { id: "skillhub", displayName: "腾讯 SkillHub", list: search, get };
}

// Smithery (smithery.ai) — free public read API, no auth (verified live
// 2026-10-14; 25k+ skills). gitUrl points at the upstream repo directory —
// that URL is the honest origin. License lives upstream (LICENSE in the repo),
// not in the API payload → unknown here; 刀二 upgrade path fetches it.
const SMITHERY_BASE = process.env.SMITHERY_API_BASE || "https://api.smithery.ai";

export function createSmitheryAdapter({ fetchImpl = outboundFetch } = {}) {
  async function search(q, limit) {
    const url = `${SMITHERY_BASE}/skills?pageSize=${limit}&q=${encodeURIComponent(q)}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`smithery search HTTP ${res.status}`);
    const doc = await res.json();
    const skills = Array.isArray(doc?.skills) ? doc.skills : [];
    return skills.map((s) =>
      normalizeEntry({
        source: "smithery",
        id: s.slug,
        name: s.slug,
        displayName: s.displayName || s.slug,
        description: s.description || "",
        originUrl: s.gitUrl || (s.namespace ? `https://smithery.ai/@${s.namespace}/${s.slug}` : null),
        licenseState: "unknown",
        version: null,
        versionLayer: null,
        downloads: Number(s.totalActivations),
        stars: Number(s.externalStars),
        tags: Array.isArray(s.categories) ? s.categories : [],
        extras: { namespace: s.namespace ?? null, verified: Boolean(s.verified) },
      }),
    );
  }
  async function get(slug) {
    // The read API exposes list + search; a single-slug endpoint is not part
    // of the verified surface. Detail resolves through search on the slug —
    // exact enough for a display card, and the snapshot cache bounds traffic.
    const res = await fetchImpl(`${SMITHERY_BASE}/skills?pageSize=5&q=${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error(`smithery detail HTTP ${res.status}`);
    const doc = await res.json();
    const hit = (doc?.skills ?? []).find((s) => s.slug === slug);
    if (!hit) return null;
    return normalizeEntry({
      source: "smithery",
      id: hit.slug,
      name: hit.slug,
      displayName: hit.displayName || hit.slug,
      description: hit.description || "",
      originUrl: hit.gitUrl || null,
      licenseState: "unknown",
      version: null,
      versionLayer: null,
      downloads: Number(hit.totalActivations),
      stars: Number(hit.externalStars),
      tags: Array.isArray(hit.categories) ? hit.categories : [],
      extras: { namespace: hit.namespace ?? null, verified: Boolean(hit.verified) },
    });
  }
  return { id: "smithery", displayName: "Smithery", list: search, get };
}

// ── Source registry ───────────────────────────────────────────────────────────

export function createExternalSourceRegistry({ env = process.env, cache, fetchImpl } = {}) {
  const snapshot = cache ?? createSnapshotCache();
  const all = [
    createSkillhubAdapter({ fetchImpl }),
    createSmitheryAdapter({ fetchImpl }),
  ];
  const knownIds = all.map((a) => a.id);
  const enabledIds = parseSourceSelection(env.EXTERNAL_SKILL_SOURCES, knownIds);
  const adapters = all.filter((a) => enabledIds.includes(a.id));

  // list/get through the snapshot cache (key = request shape, design D2).
  async function list(adapter, query, limit) {
    const key = `${adapter.id}:list:${query}:${limit}`;
    return snapshot.resolve(key, () => adapter.list(query, limit));
  }
  async function get(adapter, slug) {
    const key = `${adapter.id}:get:${slug}`;
    return snapshot.resolve(key, () => adapter.get(slug));
  }

  return {
    enabled: adapters.map((a) => ({ id: a.id, displayName: a.displayName })),
    isEnabled: (id) => enabledIds.includes(id),
    searchAll: async (query, limit) => {
      const settled = await Promise.allSettled(
        adapters.map(async (a) => {
          const out = await list(a, query, limit);
          return {
            source: a.id,
            sourceDisplayName: a.displayName,
            entries: out.data,
            stale: Boolean(out.stale),
            snapshotAt: out.at,
            error: out.error ?? null,
            // A never-succeeded source surfaces its error; a stale one keeps
            // serving the last good snapshot (spec posture).
            failed: !out.stale && out.error != null ? out.error : null,
          };
        }),
      );
      // allSettled over snapshot-resolve: resolve() itself keeps stale data on
      // failure, so rejected promises here mean a source with NO prior
      // snapshot — surfaced as a failed group, never crashing the response.
      return settled.map((s, i) =>
        s.status === "fulfilled"
          ? s.value
          : {
              source: adapters[i].id,
              sourceDisplayName: adapters[i].displayName,
              entries: [],
              stale: false,
              snapshotAt: null,
              error: String(s.reason?.message || s.reason),
              failed: String(s.reason?.message || s.reason),
            },
      );
    },
    getEntry: async (sourceId, slug) => {
      const adapter = adapters.find((a) => a.id === sourceId);
      if (!adapter) return null;
      const out = await get(adapter, slug);
      return out
        ? { entry: out.data, stale: Boolean(out.stale), snapshotAt: out.at }
        : null;
    },
  };
}
