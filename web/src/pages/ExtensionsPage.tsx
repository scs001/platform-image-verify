// ExtensionsPage.tsx — the Settings section for Tools & Skills management.
// Accepts a `type` prop to determine whether to show MCP or Skills management.
// Used by: /settings/mcp (tools view), /settings/skills (skills view).
//
// Two tabs: 已启用 (installed management) and 商店 (the market shelf —
// catalog zone plus, in the skills view, the external-market zone per
// external-skill-sources). The former external tab resolves into the market
// tab's external zone. Credential connect cards do NOT live here — they moved
// to the Settings connections section (settings-connect-center), and the
// install gates deep-link there via connectPath.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { McpInstalledView } from "@/components/extensions/McpInstalledView";
import { McpMarketView } from "@/components/extensions/McpMarketView";
import { SkillsInstalledView } from "@/components/extensions/SkillsInstalledView";
import { SkillsMarketView } from "@/components/extensions/SkillsMarketView";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { useEffect } from "react";

export interface ExtensionsPageProps {
  type: "mcp" | "skills";
}

type Tab = "installed" | "market";

// The line-credential mint callback used to land on ?tab=market (the connect
// cards lived there); it now lands on the connections section directly. The
// external deep link (?tab=external, from the retired third tab) resolves
// into the market tab's external zone.
function initialTab(): { tab: Tab; anchor: string | null } {
  try {
    const tab = new URL(window.location.href).searchParams.get("tab");
    if (tab === "external") return { tab: "market", anchor: "market-external" };
    if (tab === "market") return { tab: "market", anchor: null };
  } catch {
    /* default below */
  }
  return { tab: "installed", anchor: null };
}

export function ExtensionsPage({ type }: ExtensionsPageProps) {
  const { t } = useTranslation();
  const initial = initialTab();
  const [activeTab, setActiveTab] = useState<Tab>(initial.tab);
  const [anchor] = useState<string | null>(initial.anchor);
  const { load, loading, error } = useExtensionsStore();

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (anchor && activeTab === "market") {
      document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [anchor, activeTab]);

  // No page header: this renders as a Settings section, and the modal's nav
  // already names it. The old <h1> duplicated that label, and its subtitle
  // read `extensions.mcp.description` — a key that was never defined in any
  // locale (check-locales verifies parity across locales, not existence, so it
  // passed). Deleting the header removes the duplication and the broken key.
  return (
    <div className="flex flex-col h-full bg-background" data-testid="extensions-page" data-extensions-type={type}>
      {/* Tabs */}
      <div className="border-b border-border px-6">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab("installed")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "installed"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("extensions.tabs.installed")}
          </button>
          <button
            onClick={() => setActiveTab("market")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "market"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid="extensions-tab-market"
          >
            {t("extensions.tabs.market")}
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-muted-foreground">{t("common.loading")}</div>
          </div>
        )}
        {error && (
          <div className="p-6">
            <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>
          </div>
        )}
        {!loading && !error && (
          <div className="p-6">
            {activeTab === "installed" &&
              (type === "mcp" ? <McpInstalledView /> : <SkillsInstalledView />)}
            {activeTab === "market" &&
              (type === "mcp" ? (
                <McpMarketView onInstalled={() => setActiveTab("installed")} />
              ) : (
                <SkillsMarketView onInstalled={() => setActiveTab("installed")} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
