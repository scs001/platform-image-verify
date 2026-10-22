// AppCenterPage.tsx — the platform's discovery surface (openspec:
// add-app-center → app-center-unified-grid).
//
// Project federation, not melting: each ecosystem product keeps its own
// identity, site, and login — the center aggregates entry points only. ONE
// grid, ONE card shape (web/src/lib/appCatalog.ts owns ordering, brand
// attribution, and the connection-id map). Two data sources, both optional:
//   - Brand facts: static in appCatalog.ts — they never depend on the
//     network, so a dead backend still renders the five brand cards.
//   - Products: GET /api/catalog (role-filtered) and GET /api/connections
//     (read-only status projection, connection-center). Each fetch fails to
//     null independently: no products without a catalog, no badges or
//     connect actions without a status projection — never a broken page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Layers, Scale, Store, Orbit, Database, Package, Coins, Plug, PlugZap, ShieldAlert } from "lucide-react";
import { useAppConfig } from "@/hooks/useAppConfig";
import {
  APP_LINES,
  buildAppGrid,
  aggregateConnectionState,
  boardAvailable,
  boardPathFor,
  connectTargetFor,
  connectPathFor,
  type AppGridEntry,
  type CatalogApp,
} from "@/lib/appCatalog";

const BRAND_ICONS: Record<string, typeof Layers> = {
  yizuo: Layers,
  facet: Store,
  wanxing: Orbit,
  lex: Scale,
  wire: Database,
};

// Product-level icons; products fall back to their brand's icon.
const PRODUCT_ICONS: Record<string, typeof Layers> = {
  "yizuo-packs": Package,
  "wanxing-token": Coins,
  "wanxing-connector": PlugZap,
};

function iconFor(entry: AppGridEntry): typeof Layers {
  if (entry.kind === "product") {
    const product = PRODUCT_ICONS[entry.id];
    if (product) return product;
  }
  if (entry.brand) {
    const brand = BRAND_ICONS[entry.brand];
    if (brand) return brand;
  }
  return Layers;
}

const BADGE_DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  partial: "bg-amber-500",
  stale: "bg-amber-500",
  disconnected: "bg-muted-foreground/50",
};

const BADGE_TEXT: Record<string, string> = {
  connected: "text-emerald-600 dark:text-emerald-400",
  partial: "text-amber-600 dark:text-amber-400",
  stale: "text-amber-600 dark:text-amber-400",
  disconnected: "text-muted-foreground",
};

function AppCard({ entry, states }: { entry: AppGridEntry; states: Record<string, string> | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { lineBoardsEnabled } = useAppConfig();
  const Icon = iconFor(entry);

  // Nango products (simplify-chat-and-agents-ia, from the retired Agents-page
  // Apps tab): the primary action mints a connect session through the
  // platform's broker and redirects to the Connect UI; a failure stays on the
  // card, named — never a silent dead click.
  const isNango = entry.kind === "product" && entry.catalogKind === "nango-connect";
  const [nangoBusy, setNangoBusy] = useState(false);
  const [nangoError, setNangoError] = useState<string | null>(null);
  const nangoConnect = async () => {
    setNangoBusy(true);
    setNangoError(null);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(entry.id)}/connect`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      window.location.href = data.url as string;
    } catch (e) {
      setNangoError((e as Error).message);
      setNangoBusy(false);
    }
  };

  const state = states ? aggregateConnectionState(entry.connections, states) : null;
  const target = states ? connectTargetFor(entry.connections, states) : null;

  // Board as primary action (app-center spec, add-wire-line-board D7): the
  // deployment switch is on AND the board's OWN credential is connected —
  // not the card's aggregate badge, which may fold in unrelated connections
  // (wire's paper-trading). With a board, "打开原站" stays as the secondary.
  const canShowBoard = boardAvailable(entry.id, states, lineBoardsEnabled);
  const boardPath = boardPathFor(entry.id);

  return (
    <div
      data-testid={`app-card-${entry.id}`}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary-deep text-primary-foreground">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="flex items-center gap-1.5">
          {state && (
            <span
              data-testid={`app-card-${entry.id}-connection-badge`}
              data-state={state}
              title={t(`appCenter.connection.${state}`)}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${BADGE_DOT[state]}`} aria-hidden="true" />
              <span className={BADGE_TEXT[state]}>{t(`appCenter.connection.${state}`)}</span>
            </span>
          )}
          {entry.status === "early" && (
            <span
              data-testid={`app-card-${entry.id}-early-badge`}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              <ShieldAlert className="h-3 w-3" aria-hidden="true" />
              {t("appCenter.status.early")}
            </span>
          )}
        </div>
      </div>
      <div>
        <h3 className="font-medium">
          {entry.kind === "brand" ? t(entry.nameKey) : entry.name}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {entry.kind === "brand" ? t(entry.taglineKey) : entry.description ?? ""}
        </p>
      </div>
      <div className="mt-auto flex items-center gap-4 pt-1">
        {isNango ? (
          <span className="flex flex-col items-start gap-1">
            <button
              type="button"
              data-testid={`app-card-${entry.id}-nango-connect`}
              disabled={nangoBusy}
              onClick={() => void nangoConnect()}
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline disabled:opacity-50"
            >
              {nangoBusy ? t("appCenter.nangoConnecting") : t("appCenter.nangoConnect")}
              <Plug className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {nangoError && (
              <span data-testid={`app-card-${entry.id}-nango-error`} className="text-xs text-destructive">
                {nangoError}
              </span>
            )}
          </span>
        ) : entry.self ? (
          <span data-testid={`app-card-${entry.id}-self`} className="text-xs text-muted-foreground">
            {t("appCenter.here")}
          </span>
        ) : entry.embedded ? (
          // external-service with embedding allowed: the in-app proxy route
          // (app-center spec「直达外链与内嵌页」; restored after it was dropped
          // alongside the board CTA in the sister change).
          <button
            type="button"
            data-testid={`app-card-${entry.id}-open`}
            onClick={() => navigate(`/external/${entry.id}`)}
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t("appCenter.open")}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <>
            {/* Primary action: 看板 when the board is available, else 打开 */}
            {canShowBoard ? (
              <>
                <button
                  type="button"
                  data-testid={`app-card-${entry.id}-board`}
                  onClick={() => navigate(boardPath)}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t("appCenter.board")}
                </button>
                <a
                  href={entry.url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`app-card-${entry.id}-open`}
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("appCenter.openOrigin")}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </>
            ) : (
              <a
                href={entry.url ?? "#"}
                target="_blank"
                rel="noreferrer"
                data-testid={`app-card-${entry.id}-open`}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {t("appCenter.open")}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </>
        )}
        {state && state !== "connected" && target && (
          <button
            type="button"
            data-testid={`app-card-${entry.id}-connect`}
            onClick={() => navigate(connectPathFor(target))}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            <Plug className="h-3.5 w-3.5" aria-hidden="true" />
            {t("appCenter.connection.connect")}
          </button>
        )}
      </div>
    </div>
  );
}

export function AppCenterPage() {
  const { t } = useTranslation();
  // null = the fetch failed or hasn't landed; brand cards render regardless.
  const [apps, setApps] = useState<CatalogApp[] | null>(null);
  const [states, setStates] = useState<Record<string, string> | null>(null);

  const load = useCallback(async () => {
    // Parallel and independent: a dead catalog keeps badges, a dead
    // /api/connections keeps the cards — neither blocks the other.
    fetch("/api/catalog")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c) => setApps(c.apps ?? []))
      .catch(() => setApps(null));
    fetch("/api/connections")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c) => {
        const byId: Record<string, string> = {};
        for (const item of c.connections ?? []) byId[item.id] = item.state;
        setStates(byId);
      })
      .catch(() => setStates(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const grid = useMemo(() => buildAppGrid(APP_LINES, apps), [apps]);

  return (
    <main className="h-full overflow-y-auto bg-background" data-testid="app-center-page">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="text-xl font-semibold">{t("appCenter.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("appCenter.subtitle")}</p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="app-center-grid">
          {grid.map((entry) => (
            <AppCard key={entry.id} entry={entry} states={states} />
          ))}
        </div>
      </div>
    </main>
  );
}
