// 壹座智能体构建器 hub (add-agent-builder-hub): four areas on one route.
// Build = the visual studio's direct entry (/studio); Supply = three cabinets
// (Agent Materials Plaza | skills | MCP) gathered out of the legacy tabs and Settings;
// Creations = my drafts, presets, clusters and the installed-experts roster;
// Tuning = skill-candidate review plus the persona-amendment placeholder.
// Legacy deep links canonicalize in one place (surfaces.ts
// SURFACE_SLUG_ALIASES: ?tab=agents→creations, ?tab=market→supply).
//
// Data sources unchanged from the pre-hub page: GET /api/catalog is
// role-filtered and redacted server-side; /api/clusters/mine backs the
// cluster rows. Both reads stay cached (openspec: polish-web-surfaces).

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useListCache } from "@/hooks/useListCache";
import { Skeleton } from "@/components/ui/states-kit";
import { AGENTS_TAB_SURFACES, canonicalSlug } from "@platform/core";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CustomPresetsPage } from "@/pages/CustomPresetsPage";
import { PacksPage } from "@/pages/PacksPage";
import { PackDraftsView } from "@/components/packs/PackDraftsView";
import { ExtensionsPage } from "@/pages/ExtensionsPage";
import { SkillCandidatesView } from "@/components/skills/SkillCandidatesView";
import { PersonaAmendmentsView } from "@/components/persona/PersonaAmendmentsView";
import { ClusterComposerModal } from "@/components/clusters/ClusterComposerModal";
import { Link } from "react-router-dom";
import { Blocks } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AgentInfo } from "@platform/core";

type Tab = "build" | "supply" | "creations" | "tuning";

// A dynamic cluster row; shape mirrors GET /api/clusters/mine exactly.
interface MineCluster {
  clusterId: string;
  name: string;
  agentCount: number;
  status: string;
}

// Module-level fetchers: stable identities for useListCache. Non-JSON (an SPA
// fallback or an older server without the route) means "no clusters", never a
// thrown parse error.
async function fetchCatalogPage(): Promise<{ agents?: AgentInfo[] }> {
  const r = await fetch("/api/catalog");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchMineClusters(): Promise<{ clusters: MineCluster[] }> {
  const r = await fetch("/api/clusters/mine");
  if (!r.ok || !(r.headers.get("content-type") || "").includes("application/json")) {
    return { clusters: [] };
  }
  const data = await r.json();
  return { clusters: data.clusters ?? [] };
}

// The tab label keys live client-side (the registry carries slugs/testids —
// labels are presentation). One map, so a new tab cannot land with a missing
// label silently.
const TAB_LABEL_KEYS: Record<string, string> = {
  build: "agentsPage.build",
  supply: "agentsPage.supply",
  creations: "agentsPage.creations",
  tuning: "agentsPage.tuning",
};

// Supply-area cabinets (add-agent-builder-hub): the pack market cabinet rides
// only on marketplace deployments; skills/MCP reuse the Settings section
// components unchanged (settings-surface: sections reuse existing page
// components unchanged — two entries, one component, no fork).
type Cabinet = "packs" | "skills" | "mcp";

export function AgentsPage() {
  const { t } = useTranslation();
  const { packMarketplace, resolvedLayout } = useAppConfig();
  const [searchParams, setSearchParams] = useSearchParams();

  // Both reads are cached (openspec: polish-web-surfaces, web-list-surfaces):
  // a revisit paints instantly from cache and revalidates in the background,
  // instead of showing an empty grid / clusters area and waiting for a refetch.
  const catalog = useListCache("catalog", fetchCatalogPage);
  const mine = useListCache("clusters.mine", fetchMineClusters);
  const agents = catalog.data?.agents ?? [];
  const error = catalog.error;
  const dynamicClusters = mine.data?.clusters ?? [];

  const [composerOpen, setComposerOpen] = useState(false);
  // Cluster detail (Manage): the summary row carries no agent list, so the full
  // record is fetched on open. Terminate is the one lifecycle action here.
  const [detail, setDetail] = useState<{
    id: string;
    name: string;
    description?: string;
    status: string;
    createdAt?: number;
    agents?: Array<{ agentId: string; packId: string; status: string }>;
  } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  // The tab set comes from the server-resolved layout (layout-configuration);
  // without it (older server) the client falls back to the full registry set —
  // every hub area is a plain surface with no predicate. Resolved slugs
  // canonicalize here too, so a stale server preset naming `agents`/`market`
  // still selects its successor area.
  const visibleTabs = useMemo(() => {
    const canon = (slug: string) => canonicalSlug("agentsTabs", slug);
    const resolved = resolvedLayout?.agentsTabs;
    const byRegistry = new Map(AGENTS_TAB_SURFACES.map((e) => [e.slug, e]));
    const sources = resolved ? resolved.map(canon) : AGENTS_TAB_SURFACES.map((s) => s.slug);
    const seen = new Set<string>();
    const kept: Array<{ slug: string; testId: string; labelKey: string }> = [];
    for (const slug of sources) {
      const entry = slug ? byRegistry.get(slug) : undefined;
      // Belt and braces: `apps` is retired from every factory preset and its
      // entries live in the app center; a stale preset must not re-surface it.
      if (!entry || entry.slug === "apps" || seen.has(entry.slug)) continue;
      const labelKey = TAB_LABEL_KEYS[entry.slug];
      if (!labelKey) continue;
      seen.add(entry.slug);
      kept.push({ slug: entry.slug, testId: entry.testId, labelKey });
    }
    return kept;
  }, [resolvedLayout]);

  // ?tab= supply|creations|tuning|build (legacy agents/market canonicalize);
  // the requested tab stands only while it is visible, otherwise the first
  // visible tab wins (layout-configuration: a hidden tab's deep link falls
  // back rather than erroring).
  const tabParam = searchParams.get("tab");
  const requestedTab = tabParam ? canonicalSlug("agentsTabs", tabParam) : null;
  const activeTab: Tab =
    requestedTab && visibleTabs.some((tab) => tab.slug === requestedTab)
      ? (requestedTab as Tab)
      : ((visibleTabs[0]?.slug ?? "build") as Tab);

  // Supply cabinets: the pack market cabinet rides only on marketplace
  // deployments; the choice defaults to the first visible cabinet and the
  // user's pick wins while it stays available.
  const cabinets = useMemo<Cabinet[]>(
    () => (packMarketplace ? ["packs", "skills", "mcp"] : ["skills", "mcp"]),
    [packMarketplace],
  );
  const [cabinetChoice, setCabinetChoice] = useState<Cabinet | null>(null);
  const activeCabinet: Cabinet =
    cabinetChoice && cabinets.includes(cabinetChoice) ? cabinetChoice : cabinets[0] ?? "skills";

  const openClusterDetail = async (clusterId: string) => {
    if (!clusterId) return;
    try {
      const r = await fetch(`/api/clusters/${encodeURIComponent(clusterId)}`);
      if (!r.ok) return;
      setDetail(await r.json());
    } catch {
      /* detail is best-effort; the list stays usable */
    }
  };

  const terminateCluster = async (clusterId: string) => {
    setDetailBusy(true);
    try {
      const r = await fetch(`/api/clusters/${encodeURIComponent(clusterId)}`, { method: "DELETE" });
      if (r.ok) {
        setDetail(null);
        void mine.refresh();
      }
    } finally {
      setDetailBusy(false);
    }
  };

  const switchTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "build") sp.delete("tab");
    else sp.set("tab", next);
    setSearchParams(sp, { replace: true });
  };

  // Sort: featured first, then alphabetical by id.
  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => {
      if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
      return a.id.localeCompare(b.id);
    }),
    [agents],
  );
  // Custom-preset entries are represented (and managed) in the presets
  // section below — exclude them from the catalog grid to avoid double rows.
  const sortedCatalogExperts = useMemo(
    () => sortedAgents.filter((a) => !a.customPreset),
    [sortedAgents],
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6" data-testid="agents-page">
      <h1 className="text-2xl font-semibold">{t("agentsPage.title")}</h1>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="agents-error">
          {t("agentsPage.loadFailed", { error })}
        </div>
      )}

      {/* Area tabs */}
      <div className="mt-4 border-b border-border">
        <nav className="flex gap-4" role="tablist" aria-label={t("agentsPage.title")}>
          {visibleTabs.map((tab) => (
            <button
              key={tab.slug}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.slug}
              data-testid={tab.testId}
              onClick={() => switchTab(tab.slug as Tab)}
              className={cn(
                "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                activeTab === tab.slug
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(tab.labelKey)}
            </button>
          ))}
          {/* 智能体构建器画布直达 (add-agent-studio / add-agent-builder-hub):
              reachable from every area, one click beside the tabs. */}
          <Link
            to="/studio"
            data-testid="agents-studio-link"
            className="ml-auto inline-flex items-center gap-1 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <Blocks className="h-4 w-4" />
            {t("agentsPage.studio")}
          </Link>
        </nav>
      </div>

      <div className="mt-4">
        {activeTab === "build" && (
          <section data-testid="build-section" className="flex flex-col gap-4">
            <div className="rounded-lg border border-border bg-gradient-to-br from-primary/5 to-transparent p-6">
              <div className="flex items-start gap-4">
                <div className="shrink-0 rounded-md bg-primary/10 p-3 text-primary">
                  <Blocks className="h-6 w-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-medium">{t("hub.build.title")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t("hub.build.desc")}</p>
                  <div className="mt-4">
                    <Link
                      to="/studio"
                      data-testid="build-studio-btn"
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
                    >
                      <Blocks className="h-4 w-4" />
                      {t("hub.build.cta")}
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "supply" && (
          <section data-testid="supply-section" className="flex flex-col gap-4">
            {/* Cabinet switcher: three supply shelves in one area. */}
            <div className="border-b border-border">
              <nav className="flex gap-4" aria-label={t("agentsPage.supply")}>
                {cabinets.map((cabinet) => (
                  <button
                    key={cabinet}
                    type="button"
                    aria-selected={activeCabinet === cabinet}
                    data-testid={`supply-cabinet-${cabinet}`}
                    onClick={() => setCabinetChoice(cabinet)}
                    className={cn(
                      "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                      activeCabinet === cabinet
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`hub.supply.${cabinet}`)}
                  </button>
                ))}
              </nav>
            </div>
            {activeCabinet === "packs" && packMarketplace && (
              <div data-testid="market-section">
                <PacksPage />
              </div>
            )}
            {activeCabinet === "skills" && (
              <div data-testid="supply-skills" className="rounded-lg border border-border">
                <ExtensionsPage type="skills" />
              </div>
            )}
            {activeCabinet === "mcp" && (
              <div data-testid="supply-mcp" className="rounded-lg border border-border">
                <ExtensionsPage type="mcp" />
              </div>
            )}
          </section>
        )}

        {activeTab === "creations" && (
          <section data-testid="creations-section" className="flex flex-col gap-6">
            {/* Creator drafts (add-agent-builder-hub): the drafts surface gets
                a dedicated home here; the same component also serves the
                market cabinet's 我的 tab — one component, no fork. */}
            {packMarketplace && <PackDraftsView />}
            {/* Dynamic clusters (agent-cluster-platform): the section (and its
                create entry) is always present — a user with no clusters needs a
                way to make one. */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t("agentsPage.myClusters")}
                </h3>
                <button
                  type="button"
                  onClick={() => setComposerOpen(true)}
                  className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
                  data-testid="new-cluster-btn"
                >
                  + {t("clusters.composer.title")}
                </button>
              </div>
              {dynamicClusters.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {dynamicClusters.map((cluster) => (
                    <ClusterCard
                      key={cluster.clusterId}
                      cluster={cluster}
                      onManage={() => void openClusterDetail(cluster.clusterId)}
                    />
                  ))}
                </div>
              ) : mine.status === "loaded" ? (
                <p className="text-xs text-muted-foreground" data-testid="clusters-empty">
                  {t("agentsPage.clustersEmpty")}
                </p>
              ) : null}
            </div>

            {/* Catalog experts grid */}
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {catalog.status === "loading" &&
                [0, 1, 2].map((i) => <Skeleton key={`catalog-sk-${i}`} className="h-40" data-testid="catalog-skeleton" />)}
              {sortedCatalogExperts.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  onOpenLink={() => a.url && window.open(a.url, "_blank", "noreferrer")}
                />
              ))}
            </div>
            {/* 我的专家 — the cell's composed experts with their full
                management surface (create / edit / delete / convert), moved
                here from the retired Settings section. It refetches on the
                same catalog_changed pulse as the grid above. */}
            <CustomPresetsPage />
            <ClusterComposerModal
              open={composerOpen}
              onOpenChange={setComposerOpen}
              onSuccess={() => {
                setComposerOpen(false);
                void mine.refresh();
              }}
            />

            {/* Cluster detail (Manage): what is in this cluster, and the one
                lifecycle action — terminate. Agents and packs stay installed. */}
            <Dialog open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>{detail?.name || t("agentsPage.clusterDetail")}</DialogTitle>
                </DialogHeader>
                {detail && (
                  <div className="space-y-3 text-sm" data-testid="cluster-detail">
                    {detail.description && (
                      <p className="text-muted-foreground">{detail.description}</p>
                    )}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>
                        {t("agentsPage.clusterStatus")}: <b className="text-foreground">{detail.status}</b>
                      </span>
                      <span>
                        {t("packs.detail.cluster.agentCount", { count: detail.agents?.length ?? 0 })}
                      </span>
                      {detail.createdAt && (
                        <span>
                          {t("agentsPage.clusterCreated")}:{" "}
                          {new Date(detail.createdAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">
                        {t("agentsPage.clusterAgents")}
                      </p>
                      <ul className="space-y-1">
                        {(detail.agents ?? []).map((a) => (
                          <li key={a.agentId} className="flex items-center gap-2 text-xs">
                            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                            <span className="font-mono">{a.agentId}</span>
                            <span className="text-muted-foreground">({a.status})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="border-t border-border pt-3">
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        {t("agentsPage.clusterTerminateHint")}
                      </p>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setDetail(null)}
                          className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
                        >
                          {t("agentsPage.close")}
                        </button>
                        <button
                          type="button"
                          disabled={detailBusy}
                          onClick={() => void terminateCluster(detail.id)}
                          data-testid="cluster-terminate-btn"
                          className="rounded-md bg-destructive-deep px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive-deep/90 disabled:opacity-50"
                        >
                          {t("agentsPage.clusterTerminate")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </section>
        )}

        {activeTab === "tuning" && (
          <section data-testid="tuning-section" className="flex flex-col gap-6">
            {/* Skill-candidate review (openspec: skill-self-evolution): the
                review surface gets its dedicated home here; the same component
                also serves the skills cabinet — one component, no fork. */}
            <SkillCandidatesView />
            {/* Persona amendments (add-persona-self-evolution): the review
                surface with its honest empty state (the placeholder contract —
                the empty area keeps the tuning-persona-placeholder testid). */}
            <PersonaAmendmentsView />
          </section>
        )}
      </div>
    </main>
  );
}

// ── AgentCard ────────────────────────────────────────────────────────────

function AgentCard({ agent, onOpenLink }: { agent: AgentInfo; onOpenLink: () => void }) {
  const isExternalLink = agent.type === "agent-remote" && agent.mode === "link" && agent.url;
  // Deployed Agent Service (add-a2a-agent-serving): chat through the A2A
  // gateway from the agent picker (5.3); on this page it is informational —
  // never an openable external link.
  const isA2aService = agent.type === "agent-remote" && agent.mode === "a2a";
  return (
    <div
      className={cn(
        "rounded-lg border border-border p-4 transition-colors hover:border-primary/50",
        agent.featured && "border-primary/30 bg-primary/5",
      )}
      data-testid="agent-row"
      data-agent-id={agent.id}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-md bg-muted p-2 text-muted-foreground">
          <Icon name={agent.icon || "bot"} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium">{agent.name || agent.id}</h3>
            {agent.featured && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
                Featured
              </span>
            )}
            {agent.version && (
              <span className="text-[10px] text-muted-foreground">v{agent.version}</span>
            )}
          </div>
          {agent.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>
          )}
          {agent.tags && agent.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {agent.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            {agent.type === "agent-remote" && agent.mode === "chat" && agent.model && (
              <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-mono">
                {agent.model}
              </span>
            )}
            {isA2aService && (
              <span
                data-testid="a2a-service-badge"
                className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              >
                A2A
              </span>
            )}
            {isExternalLink && (
              <button
                onClick={onOpenLink}
                className="ml-auto text-xs text-primary hover:underline"
                data-testid="open-external-btn"
              >
                Open <Icon name="external-link" size={10} className="inline" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ClusterCard ───────────────────────────────────────────────────────────

interface ClusterCardProps {
  cluster: {
    clusterId: string;
    name: string;
    agentCount: number;
    status: string;
  };
  onManage: () => void;
}

function ClusterCard({ cluster, onManage }: ClusterCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className="rounded-lg border border-border p-4 transition-colors hover:border-primary/50 bg-gradient-to-br from-primary/5 to-transparent"
      data-testid="cluster-row"
      data-cluster-id={cluster.clusterId}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-md bg-primary/10 p-2 text-primary">
          <Icon name="users" size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <h3 className="truncate font-medium">{cluster.name}</h3>
            <span className="text-[10px] text-muted-foreground">
              {t("packs.detail.cluster.agentCount", { count: cluster.agentCount })}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Status: {cluster.status}
            </span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={onManage}
              className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
              data-testid="cluster-manage-btn"
            >
              {t("clusters.composer.manage")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
