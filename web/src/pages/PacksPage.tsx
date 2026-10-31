// PacksPage.tsx — the pack marketplace surface (add-pack-marketplace), served
// on the agents page's Packs tab (simplify-chat-and-agents-ia) on
// gateway-fronted deployments only (design D15; the registry gates this
// section on /api/config's packMarketplace flag).
//
// Two tabs (simplify-chat-and-agents-ia merged the third into the second):
// the market (browse/inspect/subscribe) and 我的 — installed snapshots
// (updates, uninstall) as one section, creator drafts (authoring + publish)
// as the section below it. A preset-conversion handoff lands on 我的 with
// the drafts section consumed. Mounted only when config.packMarketplace is
// true, so no code path here needs a local-deployment fallback.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { MyPacksView } from "@/components/packs/MyPacksView";
import { PackDraftsView } from "@/components/packs/PackDraftsView";
import { hasBridgeHandoff } from "@/lib/pack-draft-bridge";

type Tab = "market" | "mine";

export function PacksPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("market");

  // A preset conversion handoff lands with this page already targeted — go
  // straight to 我的, where PackDraftsView consumes it (opens the converted
  // draft, shows the report once).
  useEffect(() => {
    if (hasBridgeHandoff()) setActiveTab("mine");
  }, []);

  return (
    <div className="flex flex-col h-full bg-background" data-testid="packs-page">
      <div className="border-b border-border px-6">
        <nav className="flex gap-4" data-testid="packs-tabs">
          {(
            [
              ["market", "packs.tabs.market"],
              ["mine", "packs.tabs.mine"],
            ] as const
          ).map(([tab, key]) => (
            <button
              key={tab}
              data-testid={`packs-tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(key)}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {activeTab === "market" && <PackMarketView onSubscribed={() => setActiveTab("mine")} />}
        {activeTab === "mine" && (
          <div className="flex flex-col gap-8" data-testid="packs-mine">
            <section>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground" data-testid="packs-mine-installed">
                {t("packs.mineSections.installed")}
              </h2>
              <MyPacksView />
            </section>
            <section>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground" data-testid="packs-mine-creations">
                {t("packs.mineSections.creations")}
              </h2>
              <PackDraftsView onPublished={() => setActiveTab("market")} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
