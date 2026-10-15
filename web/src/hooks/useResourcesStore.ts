// Resource library state (openspec: add-resource-library).
//
// REST owns the data; the `resources_changed` WS event triggers a REFETCH of
// the current query instead of a client-side merge — library lists are small
// and keeping filtering/paging in one place removes all merge logic. Events
// are coalesced: one assistant turn with three charts is three captures, and
// the page needs one refresh.
//
// The store is also the "already in the library" oracle the chat's save
// affordance consults before offering a save.

import { create } from "zustand";
import * as api from "@platform/core";
import type { Resource, ResourceFacets, ResourceGroup, ServerMessage } from "@platform/core";

export type ResourceTypeFilter = "all" | "chart" | "file";
export type ResourceTimePreset = "all" | "today" | "7d" | "30d";

const PAGE = 60;
// Capture bursts (a turn with several charts, a seeding run) collapse into one
// refetch.
const EVENT_COALESCE_MS = 300;

// The landing view (openspec: add-resource-filters): the common artifact kinds,
// pre-checked so the page opens on what most people came for. Deliberately a
// constant, not persisted state — the page always opens the same way, and no
// half-forgotten filter can silently hide a resource on a later visit.
export const DEFAULT_GROUPS: ResourceGroup[] = ["chart", "document", "spreadsheet", "image"];

interface ResourcesState {
  items: Resource[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  typeFilter: ResourceTypeFilter;
  search: string;
  timePreset: ResourceTimePreset;
  groups: ResourceGroup[];
  facets: ResourceFacets;
  // Bumped on every resources_changed, before the coalesced refetch settles —
  // the chat's delivery affordances (chart badge, artifact strip) re-ask their
  // status questions when this moves, without waiting for or depending on the
  // list refetch (add-artifact-delivery).
  eventSeq: number;

  setTypeFilter: (filter: ResourceTypeFilter) => void;
  setSearch: (search: string) => void;
  setTimePreset: (preset: ResourceTimePreset) => void;
  toggleGroup: (group: ResourceGroup) => void;
  resetFilters: () => void;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  applyEvent: (msg: ServerMessage) => void;
}

let eventTimer: ReturnType<typeof setTimeout> | null = null;

// The time presets are natural-day windows, computed here from the browser's
// own clock and sent as absolute instants: the server never interprets a
// timezone, and "today" means the user's today.
function windowFor(preset: ResourceTimePreset, now = new Date()): { since?: string; until?: string } {
  if (preset === "all") return {};
  const days = preset === "today" ? 0 : preset === "7d" ? 6 : 29;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0, 0);
  return { since: start.toISOString() };
}

// Which groups the query carries, given the tab. The tab already narrows by row
// type, so the group row is redundant on the charts tab (hidden in the UI) and
// must not carry the chart group on the files tab; sending a contradictory
// pair would filter everything out.
function groupsForQuery(typeFilter: ResourceTypeFilter, groups: ResourceGroup[]): ResourceGroup[] | undefined {
  if (typeFilter === "chart") return undefined;
  if (typeFilter === "file") return groups.filter((g) => g !== "chart");
  return groups;
}

export const useResourcesStore = create<ResourcesState>((set, get) => ({
  items: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: null,
  typeFilter: "all",
  search: "",
  timePreset: "all",
  groups: [...DEFAULT_GROUPS],
  facets: { chart: 0, document: 0, spreadsheet: 0, image: 0, slideshow: 0, archive: 0, web: 0, data: 0, other: 0 },
  eventSeq: 0,

  setTypeFilter: (typeFilter) => {
    set({ typeFilter });
    void get().load();
  },

  setSearch: (search) => {
    set({ search });
    void get().load();
  },

  setTimePreset: (timePreset) => {
    set({ timePreset });
    void get().load();
  },

  toggleGroup: (group) => {
    const { groups } = get();
    set({ groups: groups.includes(group) ? groups.filter((g) => g !== group) : [...groups, group] });
    void get().load();
  },

  resetFilters: () => {
    set({ typeFilter: "all", search: "", timePreset: "all", groups: [...DEFAULT_GROUPS] });
    void get().load();
  },

  load: async () => {
    const { typeFilter, search, timePreset, groups } = get();
    const win = windowFor(timePreset);
    set({ loading: true, error: null });
    try {
      const page = await api.listResources({
        type: typeFilter === "all" ? undefined : typeFilter,
        q: search.trim() || undefined,
        groups: groupsForQuery(typeFilter, groups),
        since: win.since,
        until: win.until,
        limit: PAGE,
        offset: 0,
      });
      set({ items: page.items, total: page.total, facets: page.facets, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  loadMore: async () => {
    const { typeFilter, search, timePreset, groups, items, loadingMore, loading } = get();
    if (loadingMore || loading) return;
    const win = windowFor(timePreset);
    set({ loadingMore: true });
    try {
      const page = await api.listResources({
        type: typeFilter === "all" ? undefined : typeFilter,
        q: search.trim() || undefined,
        groups: groupsForQuery(typeFilter, groups),
        since: win.since,
        until: win.until,
        limit: PAGE,
        offset: items.length,
      });
      const seen = new Set(items.map((r) => r.id));
      set({
        items: [...items, ...page.items.filter((r) => !seen.has(r.id))],
        total: page.total,
        facets: page.facets,
        loadingMore: false,
      });
    } catch (err) {
      set({ error: (err as Error).message, loadingMore: false });
    }
  },

  rename: async (id, title) => {
    await api.renameResource(id, title);
    await get().load();
  },

  remove: async (id) => {
    await api.deleteResource(id);
    await get().load();
  },

  applyEvent: (msg) => {
    if (msg.type !== "resources_changed") return;
    set((s) => ({ eventSeq: s.eventSeq + 1 }));
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = setTimeout(() => {
      eventTimer = null;
      void get().load();
    }, EVENT_COALESCE_MS);
  },
}));

// Dev/test seam: lets e2e specs seed/inspect the library without a real turn.
// Same gating as __chatStore — dev or e2e builds only, never shipped.
if (typeof window !== "undefined" && (import.meta.env.DEV || import.meta.env.VITE_E2E_SEAM === "1")) {
  (window as unknown as { __resourcesStore?: typeof useResourcesStore }).__resourcesStore =
    useResourcesStore;
}