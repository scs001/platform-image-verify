// Surface registry + layout presets (openspec: layout-configuration; ADR-0026).
//
// The single authority for WHICH surfaces exist. Three containers in v1 —
// primary navigation tabs, Settings sections, Agents page sub-tabs — each
// entry keyed by its existing public route slug (the R1 "slug is public API"
// commitment) and carrying its platform predicates and stable identity
// metadata. The web renders from this; the server resolves presets against
// it. Nothing else may hardcode a surface list.
//
// Layout resolution is a four-layer narrowing chain: factory preset →
// deployment default → business-role preset → user adjustment. Each layer may
// only HIDE or REORDER what the layer above left; nothing re-reveals.
// Deployment hiding is terminal (ADR-0026). Platform predicates are absolute
// — no preset can conjure the desktop fleet into a browser.

// ── Registry ────────────────────────────────────────────────────────────────

export type SurfaceContainer = "nav" | "settings" | "agentsTabs";

export interface SurfacePredicates {
  /** Desktop shell only (the Electron app's own runner fleet). */
  desktopOnly?: boolean;
  /** Present only where the deployment reports the pack marketplace. */
  packMarketplace?: boolean;
  /** Present only where documents are enabled. */
  documentsEnabled?: boolean;
  /** Admin-only when auth is on (mirrors the section's server gate). */
  adminOnly?: boolean;
}

export interface RegistryEntry {
  container: SurfaceContainer;
  slug: string;
  /** i18n key the label resolves from (stable across locales). */
  i18nKey: string;
  testId: string;
  predicates?: SurfacePredicates;
}

export const NAV_SURFACES: RegistryEntry[] = [
  { container: "nav", slug: "chat", i18nKey: "nav.chat", testId: "nav-chat" },
  { container: "nav", slug: "knowledge", i18nKey: "nav.knowledge", testId: "nav-knowledge" },
  { container: "nav", slug: "resources", i18nKey: "nav.resources", testId: "nav-resources" },
  { container: "nav", slug: "agents", i18nKey: "nav.agents", testId: "nav-agents" },
  { container: "nav", slug: "apps", i18nKey: "nav.apps", testId: "nav-apps" },
  { container: "nav", slug: "tasks", i18nKey: "nav.tasks", testId: "nav-tasks" },
  // Agent fleets (agent-fleet-core): the organization layer over personas,
  // clusters and a2a services. Plain web surface — no predicate (unlike the
  // desktop-only runner console `fleet`).
  { container: "nav", slug: "fleets", i18nKey: "nav.fleets", testId: "nav-fleets" },
  { container: "nav", slug: "fleet", i18nKey: "nav.fleet", testId: "nav-fleet", predicates: { desktopOnly: true } },
];

// Settings section slugs in canonical order, mirroring sections.ts. The
// registry is the authority the resolver narrows; sections.ts consumes it for
// order and membership (labels/icons/components stay there — presentation
// concerns the server never needs).
export const SETTINGS_SURFACES: RegistryEntry[] = [
  { container: "settings", slug: "general", i18nKey: "settings.sections.general", testId: "settings-section-general" },
  { container: "settings", slug: "account", i18nKey: "settings.sections.account", testId: "settings-section-account" },
  { container: "settings", slug: "wechat-app", i18nKey: "settings.sections.wechat-app", testId: "settings-section-wechat-app" },
  { container: "settings", slug: "devices", i18nKey: "settings.sections.devices", testId: "settings-section-devices" },
  { container: "settings", slug: "connections", i18nKey: "settings.sections.connections", testId: "settings-section-connections" },
  { container: "settings", slug: "mcp", i18nKey: "settings.sections.mcp", testId: "settings-section-mcp" },
  { container: "settings", slug: "models", i18nKey: "settings.sections.models", testId: "settings-section-models" },
  { container: "settings", slug: "roles", i18nKey: "settings.sections.roles", testId: "settings-section-roles", predicates: { adminOnly: true } },
  { container: "settings", slug: "layout", i18nKey: "settings.sections.layout", testId: "settings-section-layout", predicates: { adminOnly: true } },
  { container: "settings", slug: "channels", i18nKey: "settings.sections.channels", testId: "settings-section-channels" },
  { container: "settings", slug: "diagnostics", i18nKey: "settings.sections.diagnostics", testId: "settings-section-diagnostics" },
  { container: "settings", slug: "status", i18nKey: "settings.sections.status", testId: "settings-section-status" },
  { container: "settings", slug: "branding", i18nKey: "settings.sections.branding", testId: "settings-section-branding", predicates: { adminOnly: true } },
];

export const AGENTS_TAB_SURFACES: RegistryEntry[] = [
  { container: "agentsTabs", slug: "agents", i18nKey: "agents.tab.agents", testId: "agents-tab-agents" },
  { container: "agentsTabs", slug: "market", i18nKey: "agents.tab.market", testId: "agents-tab-market", predicates: { packMarketplace: true } },
  { container: "agentsTabs", slug: "apps", i18nKey: "agents.tab.apps", testId: "agents-tab-apps" },
];

export const SURFACE_REGISTRY: Record<SurfaceContainer, RegistryEntry[]> = {
  nav: NAV_SURFACES,
  settings: SETTINGS_SURFACES,
  agentsTabs: AGENTS_TAB_SURFACES,
};

export const SURFACE_CONTAINERS: SurfaceContainer[] = ["nav", "settings", "agentsTabs"];

export function registryFor(container: SurfaceContainer): RegistryEntry[] {
  return SURFACE_REGISTRY[container] ?? [];
}

// Aliases: retired/legacy slugs that still resolve to a registry slug. Kept
// next to the registry so a slug cannot be added in one place only.
export const SURFACE_SLUG_ALIASES: Partial<Record<SurfaceContainer, Record<string, string>>> = {
  settings: { skills: "mcp" },
};

export function canonicalSlug(container: SurfaceContainer, slug: string): string {
  return SURFACE_SLUG_ALIASES[container]?.[slug] ?? slug;
}

// True when `slug` addresses `entry` (canonically or via an alias).
export function surfaceMatches(entry: RegistryEntry, slug: string | undefined): boolean {
  if (!slug) return false;
  return entry.slug === slug || canonicalSlug(entry.container, slug) === entry.slug;
}

// ── Predicates ──────────────────────────────────────────────────────────────

export interface PredicateFacts {
  isDesktop?: boolean;
  packMarketplace?: boolean;
  documentsEnabled?: boolean;
  isAdmin?: boolean;
  authOn?: boolean;
}

// A predicate is satisfied (surface remains) unless its fact is explicitly
// present AND adverse. Absent facts mean "unknown" and leave the surface in
// place, so a client that cannot answer (a stale config, a test harness, the
// bare registry read) never loses surfaces it would otherwise have. The
// adminOnly case follows the same rule: filtering happens only when the caller
// affirmatively states `authOn: true` and `isAdmin` is not true.
export function predicateAllows(entry: RegistryEntry, facts: PredicateFacts): boolean {
  const p = entry.predicates;
  if (!p) return true;
  if (p.desktopOnly && facts.isDesktop === false) return false;
  if (p.packMarketplace && facts.packMarketplace === false) return false;
  if (p.documentsEnabled && facts.documentsEnabled === false) return false;
  // adminOnly: drop only when we know auth is on and the user is not an admin.
  if (p.adminOnly && facts.authOn === true && facts.isAdmin !== true) return false;
  return true;
}

// ── Presets ─────────────────────────────────────────────────────────────────

export interface LayoutPreset {
  version: 1;
  nav?: string[];
  settings?: string[];
  agentsTabs?: string[];
}

export interface PresetCatalog {
  [slug: string]: LayoutPreset;
}

// The default preset is a verbatim snapshot of the pre-change hardcoded
// surfaces (every registry slug, canonical order). A deployment with no
// layout data anywhere resolves to exactly today's UI.
export const FACTORY_PRESET_SLUG = "standard-snapshot";

// The non-technical skeleton: the four work surfaces, and Settings reduced to
// the Basics group. A preset names surfaces to KEEP; absence hides.
export const FACTORY_PRESETS: PresetCatalog = {
  [FACTORY_PRESET_SLUG]: {
    version: 1,
    nav: NAV_SURFACES.map((s) => s.slug),
    settings: SETTINGS_SURFACES.map((s) => s.slug),
    // simplify-chat-and-agents-ia: the Apps sub-tab is retired from every
    // factory preset — its entries live in the app center (openspec:
    // app-center). The `apps` slug STAYS in the registry so stored presets
    // and deep links keep validating; resolution just never selects it.
    agentsTabs: ["agents", "market"],
  },
  simple: {
    version: 1,
    // `apps` rides in the non-technical skeleton too: the app center is the
    // discovery surface and the connection entry (every card's 去连接, the
    // 词元 account binding), and the business-role recipes are exactly the
    // users who must reach it (role-nav-apps, 2026-10-18). `tasks`/`fleet`
    // stay technical.
    nav: ["chat", "knowledge", "resources", "agents", "apps"],
    // `connections` rides in the non-technical skeleton: it is where a user
    // makes their tools and search work at all, and the business-role recipes
    // (legal/stock/economic) all resolve to this preset. Leaving it out made
    // the section invisible — and every connect deep link fell back to
    // General — for exactly the users those recipes provision (2026-10-18).
    settings: ["general", "account", "wechat-app", "devices", "connections"],
    agentsTabs: ["agents", "market"],
  },
};

export function factoryPreset(slug: string | undefined | null): LayoutPreset {
  if (slug && FACTORY_PRESETS[slug]) return FACTORY_PRESETS[slug];
  return FACTORY_PRESETS[FACTORY_PRESET_SLUG]!;
}

// Validate a stored/edited preset: known slug, correct container, no unknown
// slugs. A container may be omitted (the layer does not speak to it) — an
// empty array is allowed too and means "narrow to nothing", which resolution
// treats as no-narrowing only when it would blank the container.
export function validatePreset(preset: unknown): { ok: true; preset: LayoutPreset } | { ok: false; error: string } {
  if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
    return { ok: false, error: "preset must be an object" };
  }
  const p = preset as Partial<LayoutPreset>;
  const out: LayoutPreset = { version: 1 };
  for (const container of SURFACE_CONTAINERS) {
    const list = p[container];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, error: `${container} must be an array` };
    const known = new Set(registryFor(container).map((e) => e.slug));
    for (const slug of list) {
      if (typeof slug !== "string") return { ok: false, error: `${container} entries must be strings` };
      if (!known.has(slug)) return { ok: false, error: `unknown ${container} surface '${slug}'` };
    }
    out[container] = [...new Set(list)];
  }
  return { ok: true, preset: out };
}

// ── Resolution ──────────────────────────────────────────────────────────────

// One layer's contribution: an optional preset to narrow with, plus optional
// direct hides (the deployment's terminal-hide list).
export interface LayoutLayer {
  preset?: LayoutPreset | null;
  hidden?: string[] | null;
}

export interface LayoutLayers {
  deployment?: LayoutLayer;
  role?: LayoutLayer;
  user?: LayoutLayer;
}

export interface ResolvedLayout {
  nav: string[];
  settings: string[];
  agentsTabs: string[];
}

// Narrow one container: apply each layer in order (deployment → role → user).
// A layer's preset decides membership among the slugs still present AND
// supplies their relative order (the most specific layer's order wins, which
// is how a user reorder takes effect). A preset naming slugs the previous
// layer already hid changes nothing for them (no re-reveal). A preset that
// would blank the container is treated as no-narrowing — a half-built preset
// must not empty a surface. Direct `hidden` slugs are removed last. Unknown
// slugs (stale data) are ignored, never fatal.
export function resolveContainer(container: SurfaceContainer, layers: LayoutLayers): string[] {
  let current = registryFor(container).map((e) => e.slug);
  const narrow = (layer: LayoutLayer | undefined) => {
    if (!layer) return;
    const presetList = layer.preset?.[container];
    if (Array.isArray(presetList)) {
      const keep = new Set(presetList);
      const survivors = current.filter((slug) => keep.has(slug));
      if (survivors.length) {
        // The preset's order governs the survivors: a user reorder is a
        // preset whose list is a permutation of the inherited survivors.
        const byPresetOrder = presetList.filter((slug) => survivors.includes(slug));
        current = byPresetOrder.length ? byPresetOrder : survivors;
      }
    }
    if (Array.isArray(layer.hidden) && layer.hidden.length) {
      const drop = new Set(layer.hidden);
      current = current.filter((slug) => !drop.has(slug));
    }
  };
  narrow(layers.deployment);
  narrow(layers.role);
  narrow(layers.user);
  return current;
}

// Full resolution across containers plus the predicate/admin filter. Predicates
// are applied LAST and absolutely: no layer can defeat them.
export function resolveLayout(layers: LayoutLayers, facts: PredicateFacts = {}): ResolvedLayout {
  // Administrators are exempt from business-role narrowing (admin-layout-exempt):
  // the role preset is the non-technical skeleton for business users, and
  // applying it to an operator hides administration surfaces the adminOnly
  // predicate alone cannot bring back (models/channels/diagnostics carry no
  // predicate). Only an affirmative admin answer with auth on counts; auth off
  // keeps narrowing so local role preview and hermetic tests still see it.
  const effective: LayoutLayers =
    facts.authOn === true && facts.isAdmin === true ? { ...layers, role: undefined } : layers;
  const out: ResolvedLayout = { nav: [], settings: [], agentsTabs: [] };
  for (const container of SURFACE_CONTAINERS) {
    const slugs = resolveContainer(container, effective);
    const allowed = new Set(
      registryFor(container)
        .filter((e) => predicateAllows(e, facts))
        .map((e) => e.slug),
    );
    out[container] = slugs.filter((s) => allowed.has(s));
  }
  return out;
}

// Parse a stored preset document (deployment config / env). Unparseable or
// invalid input degrades to null with a warning — a bad hand-edited value must
// never take the UI down.
export function parsePresetSource(raw: unknown): LayoutPreset | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn("[layout] preset source is not valid JSON; ignoring");
      return null;
    }
  }
  const result = validatePreset(parsed);
  if (!result.ok) {
    console.warn(`[layout] preset source failed validation (${result.error}); ignoring`);
    return null;
  }
  return result.preset;
}

export function parseHiddenSource(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((s): s is string => typeof s === "string");
}

// A preset slug reference (deployment default / per-role map). Unknown slugs
// resolve to the factory default rather than erroring.
export function presetBySlugOrFactory(slug: string | undefined | null, catalog: PresetCatalog = FACTORY_PRESETS): LayoutPreset {
  if (slug && catalog[slug]) return catalog[slug];
  return catalog[FACTORY_PRESET_SLUG]!;
}
