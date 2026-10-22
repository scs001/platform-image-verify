// ConnectionsSection — Settings → 连接 (settings-connect-center).
//
// The single home for user-level credential connect cards and the search
// wiring. The five panels moved here verbatim from the extensions market tab
// (their mint/store/disconnect flows are unchanged — container only), the
// search card moved from its former own section. A collapsible brand
// quick-reference on top decodes the ecosystem names.
//
// Deep link: /settings/connections?panel=<id> scrolls to and highlights one
// card. The install gates (credential-required) and the line-mint round trip
// land here. Unknown panel values render the section normally.

import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { RegistryConnectPanel } from "@/components/extensions/RegistryConnectPanel";
import { ConnectorConnectPanel } from "@/components/extensions/ConnectorConnectPanel";
import { FacetMarketConnectPanel } from "@/components/extensions/FacetMarketConnectPanel";
import { LineOpsConnectPanel } from "@/components/extensions/LineOpsConnectPanel";
import { PaperTradingConnectPanel } from "@/components/extensions/PaperTradingConnectPanel";
import { CiyuanAccountConnectPanel } from "@/components/extensions/CiyuanAccountConnectPanel";
import { ChatwootConnectPanel } from "@/components/extensions/ChatwootConnectPanel";
import { SearchServiceCard } from "./SearchServiceCard";

const GLOSSARY_BRANDS = ["ciyuan", "facet", "connector", "wire", "lex"] as const;

// A panel target: the anchor wrapper around one card (or one group). `ids`
// are the deep-link panel values that resolve here — the line block answers
// all three line panel ids because one panel renders three rows.
function CardAnchor({
  ids,
  active,
  subtitleKey,
  children,
}: {
  ids: string[];
  active: boolean;
  // Optional: cards that render their own header (SearchServiceCard) skip it.
  subtitleKey?: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active]);

  return (
    <div
      ref={ref}
      id={`conn-${ids[0]}`}
      data-panel={ids[0]}
      data-panel-active={active ? "true" : "false"}
      className={cn("flex flex-col gap-1.5 rounded-lg", active && "ring-2 ring-primary/60 p-1")}
    >
      {subtitleKey && <p className="px-3 text-xs text-muted-foreground">{t(subtitleKey)}</p>}
      {children}
    </div>
  );
}

export function ConnectionsSection() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  // The registry panel renders nothing until its store slice is known (never
  // claim "not connected" before known) — prime it here like the market shelf
  // used to. The other panels self-fetch.
  const { refreshRegistryConnection } = useExtensionsStore();
  useEffect(() => {
    refreshRegistryConnection();
  }, [refreshRegistryConnection]);
  const panel = searchParams.get("panel") ?? "";
  const isActive = (...ids: string[]) => ids.includes(panel);

  return (
    <div className="flex flex-col gap-5 p-6" data-testid="settings-connections">
      <p className="text-sm text-muted-foreground">{t("settings.connections.subtitle")}</p>

      {/* Brand quick-reference: collapsed by default, expands in place. */}
      <details
        data-testid="connections-glossary"
        className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs"
      >
        <summary className="cursor-pointer select-none text-muted-foreground">
          {t("settings.connections.glossary.title")}
        </summary>
        <dl className="mt-2 flex flex-col gap-1">
          {GLOSSARY_BRANDS.map((brand) => (
            <div key={brand} className="flex gap-1.5">
              <dt className="shrink-0 font-medium text-foreground">
                {t(`settings.connections.glossary.${brand}.name`)}
              </dt>
              <dd className="text-muted-foreground">
                {t(`settings.connections.glossary.${brand}.desc`)}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      {/* 词元 account first (ciyuan-account-lane): the one key behind the model
          lane and the 萬星 operations MCP. `line-wanxing-caller` is the retired
          panel id kept as an alias so older deep links still land here. */}
      <CardAnchor
        ids={["ciyuan-account", "line-wanxing-caller"]}
        active={isActive("ciyuan-account", "line-wanxing-caller")}
        subtitleKey="settings.connections.cards.ciyuanAccount.subtitle"
      >
        <CiyuanAccountConnectPanel />
      </CardAnchor>

      {/* 谦面 grouped card: the tool market login and the market device
          pairing are two rows of one brand family (settings-connect-center
          D1) — same brand, two products, two auth models. */}
      <section data-testid="connections-group-facet" className="flex flex-col gap-1.5">
        <h2 className="px-3 text-sm font-semibold text-foreground">
          {t("settings.connections.cards.facetGroup.title")}
        </h2>
        <CardAnchor
          ids={["registry"]}
          active={isActive("registry")}
          subtitleKey="settings.connections.cards.registry.subtitle"
        >
          <RegistryConnectPanel />
        </CardAnchor>
        <CardAnchor
          ids={["facet-market"]}
          active={isActive("facet-market")}
          subtitleKey="settings.connections.cards.facetMarket.subtitle"
        >
          <FacetMarketConnectPanel />
        </CardAnchor>
      </section>

      <CardAnchor
        ids={["connector"]}
        active={isActive("connector")}
        subtitleKey="settings.connections.cards.connector.subtitle"
      >
        <ConnectorConnectPanel />
      </CardAnchor>

      <CardAnchor
        ids={["line-wire-customer", "line-lex"]}
        active={isActive("line-wire-customer", "line-lex")}
        subtitleKey="settings.connections.cards.lines.subtitle"
      >
        <LineOpsConnectPanel />
      </CardAnchor>

      <CardAnchor
        ids={["paper-trading"]}
        active={isActive("paper-trading")}
        subtitleKey="settings.connections.cards.paperTrading.subtitle"
      >
        <PaperTradingConnectPanel />
      </CardAnchor>

      {/* 商家 Chatwoot BYOK（add-crm-desk-pack-embed）：自带 token 驱动自己的
          租户面；登录对仅嵌入代登录用。 */}
      <CardAnchor
        ids={["chatwoot"]}
        active={isActive("chatwoot")}
        subtitleKey="settings.connections.cards.chatwoot.subtitle"
      >
        <ChatwootConnectPanel />
      </CardAnchor>

      {/* The search card renders its own title + subtitle (SearchServiceCard). */}
      <CardAnchor ids={["search"]} active={isActive("search")}>
        <SearchServiceCard highlight={isActive("search")} />
      </CardAnchor>
    </div>
  );
}
