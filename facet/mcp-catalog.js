// ── Facet MCP catalog (add-facet-platform S2, design D6) ────────────────────
//
// The registry's MCP servers, presented as cards on the facet surface:
// read-only aggregation through registry-bridge (same env as the platform:
// REGISTRY_URL + MARKET_REGISTRY_TOKEN, 300s TTL), visibility computed per
// viewer against the same registry-groups mapping the platform market uses.
// An entry with no required groups is public; an entry with groups is visible
// to a viewer whose identity carries one of them (group names or org ids —
// the mapping lists both). The facet surface never writes registry state
// (ADR-0015: homing is management-surface only).
//
// add-facet-infra-pages widens this surface to two layers: the card list keeps
// its six-field shape (no tool surfaces in the default payload), and per-server
// depth routes carry the tool surface and provenance on demand. The skills
// catalog rides the same visibility rule over the bridge's skill entries.
//
// add-mcp-annotation-overlay: supply annotations project per request locale
// through the ONE shared helper (lib/supply-annotations.js, zh 唯一回落);
// unannotated entries carry no annotation key — the payload stays
// byte-identical to the pre-change shape. Raw stored text remains in
// name/description (never replaced).

import { resolveLocale } from "../lib/pack-locale.js";
import { projectAnnotation } from "../lib/supply-annotations.js";

// The one visibility rule every MCP-server surface shares: no required groups =
// public, groups = a viewer carrying one of them (group names or org ids).
// Module-level and exported so other projections (the MCP Registry server.json
// face) consume THIS function instead of restating the predicate — a second
// copy is exactly the drift pack-marketplace forbids (design C2).
export function visibleTo(entry, viewer) {
  const required = Array.isArray(entry.groups) ? entry.groups : [];
  const groups = new Set(viewer?.groups ?? []);
  return required.length === 0 || required.some((g) => groups.has(g));
}

export function registerFacetMcpRoutes(app, {
  resolveUser,
  entriesFn, // injection seam; default reads the registry bridge snapshot
  skillsFn = () => [], // injection seam for the skills catalog
  refreshFn = null, // optional forced refresh before serving (tests inject noop)
}) {
  const requestLocale = (req) =>
    resolveLocale({ locale: req.query.locale, acceptLanguage: req.headers["accept-language"] });

  const projected = (annotation, locale) => {
    if (!annotation) return undefined;
    const p = projectAnnotation(annotation, locale);
    return p ?? undefined;
  };

  const listVisible = (entries, viewer, locale) =>
    entries
      .filter((e) => visibleTo(e, viewer))
      .map((e) => {
        const row = {
          name: e.name,
          displayName: e.displayName || e.name,
          description: e.description || "",
          endpoint: e.configTemplate?.url ?? "",
          requiredGroups: Array.isArray(e.groups) ? e.groups : [],
        };
        const ann = projected(e.annotations, locale);
        if (ann) row.annotation = ann;
        return row;
      });

  const listSkills = (entries, viewer, locale) =>
    entries
      .filter((e) => visibleTo(e, viewer))
      .map((e) => {
        const row = {
          name: e.name,
          displayName: e.displayName || e.name,
          description: e.description || "",
          repositoryUrl: e.repositoryUrl ?? null,
          author: e.author ?? null,
          version: e.version ?? null,
          tags: Array.isArray(e.tags) ? e.tags : [],
        };
        const ann = projected(e.annotations, locale);
        if (ann) row.annotation = ann;
        return row;
      });

  app.get("/api/mcp-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const entries = entriesFn();
    res.json({ servers: listVisible(entries, viewer, requestLocale(req)) });
  });

  // Per-server depth view (add-facet-infra-pages): tool surface + provenance.
  // Visibility is the same rule — an entry the viewer cannot see answers
  // not-found (probing teaches nothing, the packs private-pack posture).
  app.get("/api/mcp-catalog/:name", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    const entry = entriesFn().find((e) => e.name === req.params.name);
    if (!entry || !visibleTo(entry, viewer)) {
      return res.status(404).json({ error: "Server not found" });
    }
    const locale = requestLocale(req);
    const toolAnnotations = entry.annotations?.tools ?? null;
    const tools = Array.isArray(entry.toolDetails)
      ? entry.toolDetails.map((t) => {
          const ann = toolAnnotations && typeof t?.name === "string" ? projected(toolAnnotations[t.name], locale) : undefined;
          return ann ? { ...t, annotation: ann } : t;
        })
      : (entry.toolDetails ?? null);
    const row = {
      name: entry.name,
      displayName: entry.displayName || entry.name,
      description: entry.description || "",
      endpoint: entry.configTemplate?.url ?? "",
      requiredGroups: Array.isArray(entry.groups) ? entry.groups : [],
      // Depth payload — absent fields stay null; the view renders "not
      // declared" rather than inventing values (spec: honest rendering).
      tools,
      toolCount: entry.numTools ?? entry.toolList?.length ?? null,
      license: entry.license ?? null,
      providerOrganization: entry.providerOrganization ?? null,
      deployment: entry.deployment ?? null,
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    };
    const ann = projected(entry.annotations, locale);
    if (ann) row.annotation = ann;
    res.json(row);
  });

  // Skills catalog (add-facet-infra-pages): provenance marks per
  // openspec: ecosystem-curation. Same visibility rule; read-only always.
  app.get("/api/skills-catalog", async (req, res) => {
    if (typeof refreshFn === "function") await refreshFn().catch(() => {});
    const viewer = resolveUser(req);
    res.json({ skills: listSkills(skillsFn(), viewer, requestLocale(req)) });
  });

  return { listVisible, listSkills, visibleTo };
}

// Boot wiring: start the bridge's TTL refresh against the real registry and
// hand its snapshot to the routes. Degrades to an empty catalog when the
// registry source is unconfigured or unreachable (last-good kept by the
// bridge itself). No per-request refresh — initRegistryBridge already owns
// the boot fetch + TTL timer.
export async function initFacetMcpCatalog(app, { resolveUser }) {
  const bridge = await import("../registry-bridge.js");
  bridge.initRegistryBridge({});
  return registerFacetMcpRoutes(app, {
    resolveUser,
    entriesFn: () => bridge.getMarketEntries().mcpServers ?? [],
    skillsFn: () => bridge.getMarketEntries().skills ?? [],
  });
}
