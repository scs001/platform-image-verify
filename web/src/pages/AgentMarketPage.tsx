// 智能体市场 (restructure-yizuo-ia): the product's SINGLE in-product pack
// doorway, at the existing `/agents` route (the slug is public API).
//
// Before this change supply had three doors: this façade, a standalone `/packs`
// page (with ZERO links to it — the creator drafts/publish flow was reachable
// only by typing the URL), and the external facet market. The standalone page's
// two tabs are absorbed here:
//   市场 — browse / inspect / subscribe (PackMarketView), plus the explicit
//          outbound entries: the supply-domain market hall and the Studio.
//   我的 — installed snapshots (updates, uninstall) and creator drafts /
//          publish (PackDraftsView consumes the preset-conversion handoff).
//
// The tab set is registry-resolved (`agentsTabs` = market, mine) and may be
// narrowed by the layout chain; the pack-marketplace predicate lives on the
// `market` tab entry, so a market-less deployment renders 我的 alone instead of
// an empty market shell (installed packs and drafts are local state).
//
// Legacy deep links: `/agents?tab=agents|creations|supply|apps|build` resolve
// through SURFACE_SLUG_ALIASES; `/packs?…` is redirected by the route layer and
// keeps `deployCastPack=` so the Studio's deploy handoff still lands.

import { useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Blocks, ExternalLink } from "lucide-react";
import { useChatStore } from "@platform/core";
import { useAppConfig } from "@/hooks/useAppConfig";
import { hasBridgeHandoff } from "@/lib/pack-draft-bridge";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { MyPacksView } from "@/components/packs/MyPacksView";
import { PackDraftsView } from "@/components/packs/PackDraftsView";
import { studioHref } from "@/lib/studio-origin";
import { cn } from "@/lib/utils";

type Tab = "market" | "mine";

const ALL_TABS: Tab[] = ["market", "mine"];
const TAB_LABEL: Record<Tab, string> = {
  market: "agents.tab.market",
  mine: "agents.tab.mine",
};

// Legacy/retired tab slugs → their successor. Kept client-side as well because
// the URL is read before any layout round-trip; the aliases themselves live in
// @platform/core (SURFACE_SLUG_ALIASES) so presets normalize identically.
const LEGACY_TAB: Record<string, Tab> = {
  agents: "mine",
  creations: "mine",
  supply: "market",
  apps: "market",
  build: "market",
};

export function AgentMarketPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const { packMarketplace, resolvedLayout } = useAppConfig();

  // The visible set comes from the server-resolved layout; an older server
  // (no field) falls back to the factory pair minus the predicate we can check
  // locally (packMarketplace is part of the same /api/config payload).
  const tabs = useMemo<Tab[]>(() => {
    const resolved = resolvedLayout?.agentsTabs;
    const raw = resolved ?? ALL_TABS;
    const visible = raw.filter((slug): slug is Tab => (ALL_TABS as string[]).includes(slug));
    const gated = packMarketplace === false ? visible.filter((slug) => slug !== "market") : visible;
    return gated.length ? gated : ["mine"];
  }, [resolvedLayout, packMarketplace]);

  const requested = searchParams.get("tab") ?? "";
  const active: Tab = useMemo(() => {
    const candidate = LEGACY_TAB[requested] ?? requested;
    const normalized = (ALL_TABS as string[]).includes(candidate) ? (candidate as Tab) : null;
    return normalized && tabs.includes(normalized) ? normalized : (tabs[0] ?? "mine");
  }, [requested, tabs]);

  // Keep the URL truthful: a legacy slug or a hidden tab normalizes to the tab
  // actually rendered, so a reload cannot land somewhere else.
  useEffect(() => {
    if (requested === active) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", active);
    setSearchParams(next, { replace: true });
  }, [requested, active, searchParams, setSearchParams]);

  // A preset-conversion handoff lands with 我的 targeted — PackDraftsView
  // consumes it there (opens the converted draft, shows the report once).
  useEffect(() => {
    if (hasBridgeHandoff() && tabs.includes("mine")) {
      const next = new URLSearchParams(searchParams);
      next.set("tab", "mine");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, tabs]);

  // deployCastPack deep link (add-supply-studio-migration 2.2): the supply
  // Studio hands the cast pack off here; the market opens its detail dialog
  // straight on it (install surface → from-template wizard → team page).
  const deployCastPack = searchParams.get("deployCastPack") ?? undefined;

  const selectTab = (tab: Tab) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next);
  };

  return (
    <div className="flex h-full flex-col bg-background" data-testid="agent-market-page">
      <div className="border-b border-border px-6 py-3">
        <h1 className="text-base font-semibold" data-testid="agent-market-title">
          {t("nav.agents")}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("agents.market.subtitle")}</p>
      </div>

      <div className="border-b border-border px-6">
        <nav className="flex gap-4" data-testid="agent-market-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              data-testid={`agent-market-tab-${tab}`}
              data-active={active === tab ? "true" : "false"}
              onClick={() => selectTab(tab)}
              className={cn(
                "-mb-px border-b-2 px-1 py-2 text-sm font-medium transition-colors",
                active === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(TAB_LABEL[tab])}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {active === "market" && (
          <div data-testid="agent-market-panel-market">
            {/* The marketplace is INTERNAL (drop-external-market-door): its
                catalogue is this deployment's own market plane, so a button
                leaving the product for "the market" would present the same
                catalogue as another product with another identity. The one
                outbound door left is authoring — the supply-domain Studio —
                and it is labelled as authoring, never as the market. */}
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <a
                href={studioHref()}
                target="_blank"
                rel="noopener"
                data-testid="agent-market-studio"
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Blocks className="h-4 w-4" />
                {t("agents.market.openStudio")}
                <ExternalLink className="h-3.5 w-3.5 opacity-60" />
              </a>
            </div>
            <PackMarketView
              initialDetailId={deployCastPack}
              onSubscribed={() => tabs.includes("mine") && selectTab("mine")}
              onUsePrompt={(prompt) => {
                // Parked-draft channel (P2 3.5, same as DocumentsPage): the
                // composer consumes it exactly once on the chat page.
                setComposerDraft(prompt);
                navigate("/chat");
              }}
            />
          </div>
        )}

        {active === "mine" && (
          <div className="flex flex-col gap-8" data-testid="agent-market-panel-mine">
            <section data-testid="agent-market-mine-installed">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                {t("packs.mineSections.installed")}
              </h2>
              <MyPacksView />
            </section>
            <section data-testid="agent-market-mine-creations">
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">
                {t("packs.mineSections.creations")}
              </h2>
              <PackDraftsView onPublished={() => tabs.includes("market") && selectTab("market")} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
