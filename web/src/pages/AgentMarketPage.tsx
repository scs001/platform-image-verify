// 智能体市场门面 (add-supply-studio-migration 4.2/4.3, hub spec MODIFIED):
// the /agents route keeps its slug/route identity (layout-configuration) but
// the four-zone builder facade is dissolved — this page is the agent-market
// entry: the primary affordance deep-links to the supply-domain market
// (facet), and the in-panel install action panel (本机已装包/可装机列表,
// pack-installation contract) stays for runtime-domain installs.
//
// The supply three-cabinet BROWSE face is the supply-domain market now
// (W1 unified catalog projection); Settings' MCP/skill management alias
// entries are untouched (settings-surface contract intact).
import { useTranslation } from "react-i18next";
import { Blocks, ExternalLink, PackageOpen } from "lucide-react";
import { MyPacksView } from "@/components/packs/MyPacksView";

// Supply-domain market origin (facet) lives in @/lib/studio-origin — one
// definition shared with the studio redirect and the fleet 来源蓝图 chip.
import { STUDIO_ORIGIN, studioHref } from "@/lib/studio-origin";

export function AgentMarketPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col bg-background" data-testid="agent-market-page">
      <div className="border-b border-border px-6 py-3">
        <h1 className="text-base font-semibold" data-testid="agent-market-title">
          {t("nav.agents")}
        </h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("agents.market.subtitle")}</p>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          {/* Primary affordance: the supply-domain market hall (external deep
              link). The facade route itself never re-hosts a second supply
              catalog face (hub spec REMOVED 供给区三柜合一 migration note). */}
          <a
            href={`${STUDIO_ORIGIN}/#/packs`}
            target="_blank"
            rel="noopener"
            data-testid="agent-market-open"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Blocks className="h-4 w-4" />
            {t("agents.market.openMarket")}
            <ExternalLink className="h-3.5 w-3.5 opacity-60" />
          </a>
          <a
            href={studioHref()}
            target="_blank"
            rel="noopener"
            data-testid="agent-market-studio"
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {t("agents.market.openStudio")}
          </a>
        </div>
        {/* Install action panel: what's installed on this machine + the
            installed-packs management (updates/uninstall) — the runtime half
            that stays on 壹座 (pack-installation contract). */}
        <section data-testid="agent-market-installed">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <PackageOpen className="h-4 w-4" />
            {t("agents.market.installed")}
          </h2>
          <MyPacksView />
        </section>
      </div>
    </div>
  );
}
