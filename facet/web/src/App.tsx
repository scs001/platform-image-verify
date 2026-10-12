// Facet's thin shell: a header (text site mark + identity + locale switcher +
// login/logout) over hash-addressed views — the mechanism-first intro
// (#/, the default landing), the 壹座 packs market surface reused verbatim
// (#/packs), the MCP catalog (#/mcp), and the docs view (#/docs). v1 scope on
// the facet domain: browse, inspect, subscribe (recorded at the market),
// publish via the same /api/packs API. Cell-side install stays a 壹座 surface
// — the service answers /api/mypacks/* with a guided 501 and the dialog shows it.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { PackMarketView } from "@/components/packs/PackMarketView";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/i18n/useLanguage";
import { FACET_HELP_COMMAND } from "./cliFacts";
import { ErrorBoundary } from "./ErrorBoundary";
import { CurateView } from "./CurateView";
import { DocsView } from "./DocsView";
import { IntroView } from "./IntroView";
import { McpCatalog } from "./McpCatalog";
import { MineView } from "./MineView";
import { PageFooter } from "./PageFooter";
import { SiteMark } from "./SiteMark";

// Conditional views (add-facet-content-management): #/mine needs a signed-in
// viewer, #/curate needs an admin — an unauthorized deep link falls back to
// the intro landing (the data plane rejects those calls anyway).
type View = "intro" | "packs" | "mcp" | "docs" | "mine" | "curate";

type WhoamiUser = { email: string; groups: string[]; creator?: boolean; admin?: boolean } | null;

const VIEW_HASH: Record<View, string> = {
  intro: "#/",
  packs: "#/packs",
  mcp: "#/mcp",
  docs: "#/docs",
  mine: "#/mine",
  curate: "#/curate",
};

/** Hash → view, gated by identity; unknown/empty/unauthorized fall back to intro. */
function viewFromHash(hash: string, user: WhoamiUser): View {
  if (hash === "#/packs") return "packs";
  if (hash === "#/mcp") return "mcp";
  if (hash === "#/docs") return "docs";
  if (hash === "#/mine") return user ? "mine" : "intro";
  if (hash === "#/curate") return user?.admin ? "curate" : "intro";
  return "intro";
}

function Whoami({ onUser }: { onUser: (u: WhoamiUser) => void }) {
  useEffect(() => {
    fetch("/api/whoami")
      .then((r) => r.json())
      .then((d) => onUser(d?.email ? d : null))
      .catch(() => onUser(null));
  }, [onUser]);
  return null;
}

/** Five-locale switcher; an explicit choice persists in the app's locale store. */
function LocaleSwitcher() {
  const { t } = useTranslation();
  const { locale, locales, changeLocale } = useLanguage();
  return (
    <select
      aria-label={t("facetShell.langLabel")}
      data-testid="facet-locale-switcher"
      value={locale}
      onChange={(e) => changeLocale(e.target.value as (typeof locales)[number]["code"])}
      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
    >
      {locales.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

export function App() {
  const { t } = useTranslation();
  const [user, setUser] = useState<WhoamiUser>(null);
  const [view, setView] = useState<View>(() => viewFromHash(window.location.hash, null));

  // Whoami resolves after first paint: re-derive the view once identity is in,
  // so an authorized deep link to #/mine or #/curate lands after the probe.
  useEffect(() => {
    setView(viewFromHash(window.location.hash, user));
  }, [user]);

  useEffect(() => {
    const onHash = () => setView(viewFromHash(window.location.hash, user));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [user]);

  // Tabs write the hash (deep-linkable, reload-stable); the hashchange listener
  // above is the single place that moves the view.
  const go = useCallback((next: View) => {
    if (window.location.hash === VIEW_HASH[next]) setView(next);
    else window.location.hash = VIEW_HASH[next];
  }, []);

  const tabs: [View, string][] = [
    ["intro", t("facetShell.tabs.intro")],
    ["packs", t("facetShell.tabs.packs")],
    ["mcp", t("facetShell.tabs.mcp")],
    ["docs", t("facetShell.tabs.docs")],
    ...(user ? ([["mine", t("facetShell.tabs.mine")]] as [View, string][]) : []),
    ...(user?.admin ? ([["curate", t("facetShell.tabs.curate")]] as [View, string][]) : []),
  ];

  return (
    <div className="flex flex-col h-full min-h-screen bg-background text-foreground">
      <Whoami onUser={setUser} />
      <header className="border-b border-border px-6 py-3 flex flex-wrap items-center justify-between gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SiteMark chars="谦" size="md" />
          <span className="text-lg font-semibold">谦面 Facet</span>
          <nav className="ml-2 flex gap-2" data-testid="facet-tabs">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                onClick={() => go(id)}
                className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                  view === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <LocaleSwitcher />
          {user ? (
            <>
              <span className="text-sm text-muted-foreground">{user.email}</span>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = "/api/auth/logout")}>
                {t("auth.logout")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => (window.location.href = "/auth/login")}>
              {t("auth.login")}
            </Button>
          )}
        </div>
      </header>
      <main className="flex-1 overflow-auto p-6">
        {/* key={view} resets the boundary when tabs switch: a contained
            failure never leaks into the next view (spec: facet-platform,
            tabs still work after a contained failure). */}
        <ErrorBoundary key={view}>
          {view === "intro" && <IntroView />}
          {view === "packs" && (
            <div className="space-y-4">
              {/* onOpenChat={null}: the next-steps wizard footer points at a
                  conversation view this shell doesn't have (installing stays a
                  壹座 surface), so the footer is suppressed — the report panel
                  itself renders unchanged (spec: pack-marketplace). */}
              <PackMarketView onSubscribed={() => {}} onOpenChat={null} />
              <p className="text-xs text-muted-foreground">
                {t("facetShell.packsFootnote")} <code className="font-mono">{FACET_HELP_COMMAND}</code>
              </p>
            </div>
          )}
          {view === "mcp" && <McpCatalog />}
          {view === "docs" && <DocsView />}
          {view === "mine" && <MineView />}
          {view === "curate" && <CurateView />}
        </ErrorBoundary>
        <PageFooter />
      </main>
    </div>
  );
}