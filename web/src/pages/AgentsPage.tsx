// Agents & Apps catalog page. GET /api/catalog is role-filtered and
// redacted server-side; link entries open externally, nango-connect entries
// mint a connect session via the server-side broker then redirect, and
// external-service entries (NEW API) embed via /external/:appId iframe proxy.
//
// Layout: two sub-tabs (Experts | Packs) selected via ?tab=agents|market for
// deep-linking (simplify-ia-non-technical, then simplify-chat-and-agents-ia
// retired the Apps tab — its entries moved to the app center, and the legacy
// ?tab=apps value falls back to the first visible tab). Experts unifies the
// catalog roster with the cell's custom presets — the preset management
// surface (add-custom-presets) is embedded below the catalog grid, so
// composing, managing, and picking an expert happen in one place. Packs hosts
// the pack marketplace (moved out of Settings) on deployments that report it.
// Featured items appear first; entries sort by id within their tier.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useListCache } from "@/hooks/useListCache";
import { AGENTS_TAB_SURFACES } from "@platform/core";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CustomPresetsPage } from "@/pages/CustomPresetsPage";
import { PacksPage } from "@/pages/PacksPage";
import { ClusterComposerModal } from "@/components/clusters/ClusterComposerModal";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AgentInfo } from "@platform/core";

type Tab = "agents" | "market";

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
  agents: "agentsPage.agents",
  market: "agentsPage.market",
};

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
  // without it (older server) the client falls back to the factory set with
  // its own marketplace gate — the pre-change behavior exactly.
  const visibleTabs = useMemo(() => {
    const resolved = resolvedLayout?.agentsTabs;
    if (!resolved) {
      // Older server without the layout field: the factory set minus the
      // retired apps slug (the registry keeps it for stored-preset compat,
      // but no factory preset selects it — match that here too).
      return AGENTS_TAB_SURFACES.filter((s) => s.slug !== "apps")
        .filter((s) => !s.predicates?.packMarketplace || packMarketplace)
        .map((s) => ({
          slug: s.slug,
          testId: s.testId,
          labelKey: TAB_LABEL_KEYS[s.slug]!,
        }));
    }
    const byRegistry = new Map(AGENTS_TAB_SURFACES.map((e) => [e.slug, e]));
    const kept = resolved
      .map((slug) => byRegistry.get(slug))
      .filter((e): e is (typeof AGENTS_TAB_SURFACES)[number] => Boolean(e));
    // Belt and braces: the server already applied the predicate, but a stale
    // resolvedLayout must never surface the market on a market-less deployment.
    return kept
      .filter((s) => !s.predicates?.packMarketplace || packMarketplace)
      .map((s) => ({ slug: s.slug, testId: s.testId, labelKey: TAB_LABEL_KEYS[s.slug]! }));
  }, [resolvedLayout, packMarketplace]);

  // ?tab=apps|market|agents; the requested tab stands only while it is visible,
  // otherwise the first visible tab wins (layout-configuration: a hidden tab's
  // deep link falls back rather than erroring).
  const tabParam = searchParams.get("tab");
  const activeTab: Tab =
    tabParam && visibleTabs.some((tab) => tab.slug === tabParam) ? (tabParam as Tab) : ((visibleTabs[0]?.slug ?? "agents") as Tab);

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
    if (next === "agents") sp.delete("tab");
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
  // Custom-preset entries are represented (and managed) in the 我的专家
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

      {/* Sub-tabs */}
      <div className="mt-4 border-b border-border">
        <nav className="flex gap-4" role="tablist" aria-label={t("agentsPage.title")}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "agents"}
            data-testid="agents-tab-agents"
            onClick={() => switchTab("agents")}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              activeTab === "agents"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("agentsPage.agents")}
          </button>
          {packMarketplace && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "market"}
              data-testid="agents-tab-market"
              onClick={() => switchTab("market")}
              className={cn(
                "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                activeTab === "market"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t("agentsPage.market")}
            </button>
          )}
        </nav>
      </div>

      <div className="mt-4">
        {activeTab === "agents" && (
          <section data-testid="agents-section" className="flex flex-col gap-6">
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
                          className="rounded-md bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
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

        {activeTab === "market" && packMarketplace && (
          <section data-testid="market-section">
            <PacksPage />
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
