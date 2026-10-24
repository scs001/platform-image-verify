// PackMarketView — browse, search, inspect, subscribe (add-pack-marketplace).
// All parts of a pack are inspectable BEFORE subscribing: the detail dialog
// shows every skill's full body, MCP references with required groups, and
// agent personas (spec: pack-marketplace, browse-and-inspect).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import * as api from "@/lib/packs-api";
import type { PackSummary, PackReport } from "@/lib/packs-api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/packs/Badge";
import { PackDetailDialog } from "./PackDetailDialog";
import { publishPackInspection } from "@/lib/copilot-pack-context";

// Agent-count buckets (agent-cluster-platform marketplace views): the spec's
// "cluster size" filter, expressed over the count every pack carries — a
// multi-agent pack is cluster material whether or not it declares cluster
// metadata yet. State lives in the `agents` URL param (stateful per spec).
const AGENT_SIZE_FILTERS = [
  { key: "", min: 0, max: Number.POSITIVE_INFINITY },
  { key: "1", min: 1, max: 1 },
  { key: "2-3", min: 2, max: 3 },
  { key: "4+", min: 4, max: Number.POSITIVE_INFINITY },
] as const;

/** Card-grid skeleton matching the loaded market rows (polish-facet-usability
 *  state contract): title+version line, two description lines, tag row. */
function MarketSkeleton() {
  return (
    <div className="grid gap-3" data-testid="pack-market-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="h-4 w-36 animate-pulse rounded bg-muted" />
            <div className="h-4 w-10 animate-pulse rounded bg-muted" />
          </div>
          <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="mt-1.5 h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="mt-2 flex gap-1.5">
            <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
            <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PackMarketView({
  onOpenChat,
  onRequireLogin,
  onGotoMine,
}: {
  onSubscribed?: () => void;
  // The report footer's open-chat hook. Hosts without a conversation view
  // (the facet shell) pass null to drop the footer entirely; the default
  // navigates 壹座's chat route. See NextStepsFooter for why the routing
  // call lives there and not here.
  onOpenChat?: (() => void) | null;
  // Signed-out signal forwarded to the detail dialog (polish-facet-
  // interactions): hosts with anonymous viewers wire it, 壹座 omits it.
  onRequireLogin?: () => void;
  // Host-selected "go to my packs" affordance (polish-facet-interactions
  // follow-up): forwarded to the dialog, which routes it through the login
  // guidance when the host also wired onRequireLogin and the viewer is
  // signed out.
  onGotoMine?: () => void;
}) {
  const { t } = useTranslation();
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [search, setSearch] = useState("");
  // Curation (add-facet-content-management): a category filter chips row
  // (from the distinct live categories) and a featured rail. Both render
  // only when curation data exists — an uncatalogued market looks exactly
  // as before.
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Publish the inspected pack for the copilot dock (add-facet-copilot D2):
  // opening/switching publishes the pack, closing publishes null. The packs
  // array is the name/version source of truth (the id is all the dialog owns).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dock context keys on the inspected pack's id — a name/version refresh mid-inspection must not re-fire it, so only the id (via detailId) is the trigger
  useEffect(() => {
    const pack = detailId ? packs.find((p) => p.id === detailId) ?? null : null;
    publishPackInspection(pack && { id: pack.id, name: pack.name, version: pack.version });
  }, [detailId]);
  useEffect(() => () => publishPackInspection(null), []);

  // Agent-count filter state rides the URL (?agents=2-3) so a refresh keeps
  // it (spec: filter state persists across page refreshes). Deliberately NOT
  // react-router's useSearchParams: the facet shell mounts this view with no
  // Router ancestor, and a top-level router hook blanks its #/packs (the
  // shell sentinel's exact regression class, regressed 2026-10-21) — plain
  // window.location keeps the same URL-lived contract router-free.
  const [sizeKey, setSizeKeyState] = useState(
    () => new URLSearchParams(window.location.search).get("agents") || "",
  );
  const setSizeKey = useCallback((key: string) => {
    const url = new URL(window.location.href);
    if (key) url.searchParams.set("agents", key);
    else url.searchParams.delete("agents");
    window.history.replaceState({}, "", url.toString());
    setSizeKeyState(key);
  }, []);
  const sizeFilter = AGENT_SIZE_FILTERS.find((f) => f.key === sizeKey) ?? AGENT_SIZE_FILTERS[0];
  // Countless summaries (a pre-upgrade server) pass through unfiltered
  // rather than vanishing.
  const visiblePacks = packs.filter(
    (p) =>
      p.agentCount === undefined ||
      (p.agentCount >= sizeFilter.min && p.agentCount <= sizeFilter.max),
  );

  const refresh = useCallback(
    async (q: string, cat = category) => {
      setLoading(true);
      setError(null);
      try {
        const r = await api.listPacks({ ...(q ? { search: q } : {}), ...(cat ? { category: cat } : {}) });
        setPacks(r.packs);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [category],
  );

  useEffect(() => {
    void refresh("");
  }, [refresh]);

  // Chip set from the live catalog (v1 volumes: one page is the catalog).
  useEffect(() => {
    api
      .listPacks({ pageSize: 100 })
      .then((r) => setCategories([...new Set(r.packs.map((p) => p.category).filter((c): c is string => Boolean(c)))].sort()))
      .catch(() => {});
  }, []);

  const [report, setReport] = useState<PackReport | null>(null);
  const [reportPack, setReportPack] = useState<string>("");
  const [reportPackId, setReportPackId] = useState<string>("");
  // Honest guide hint (add-facet-copilot): ask the existing focused-preset
  // endpoint whether the facet assistant is installed. Only the "resolves to
  // null" answer shows the hint; a failed/absent probe shows nothing (the
  // dock's own degradation already narrates there).
  const [guideUnfocused, setGuideUnfocused] = useState(false);
  useEffect(() => {
    fetch("/api/boards/facet/copilot")
      .then((r) => (r.ok ? r.json() : { error: true }))
      .then((b) => setGuideUnfocused(!b.error && b.copilot == null))
      .catch(() => setGuideUnfocused(false));
  }, []);

  // Deep-link target (simplify-chat-and-agents-ia): a pack with a
  // successfully installed role goes straight into a conversation with it
  // (`?preset=`); a multi-role pack additionally carries its cluster id so the
  // chat binds the whole group and switches to the roster's lead. A pack
  // without roles (skill/tool-only) keeps the plain navigation — the
  // conversation needs no switch.
  const installedAgents = (report?.agents ?? []).filter(
    (a) => a.status === "installed" || a.status === "reused" || a.status === "replaced",
  );
  const chatTarget =
    report && installedAgents.length > 0
      ? installedAgents.length >= 2 && reportPackId
        ? `/chat?preset=${encodeURIComponent(installedAgents[0]!.id)}&cluster=${encodeURIComponent(reportPackId)}`
        : `/chat?preset=${encodeURIComponent(installedAgents[0]!.id)}`
      : "/chat";
  const chatClusterMode = installedAgents.length >= 2;

  return (
    <section data-testid="pack-market-section">
      {guideUnfocused && (
        <p
          data-testid="pack-market-guide-hint"
          className="mb-3 rounded-md border border-amber-600/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {t("packs.market.assistantHint")}
        </p>
      )}
      <div className="flex items-center gap-2 mb-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void refresh(search)}
          placeholder={t("packs.market.searchPlaceholder")}
          className="max-w-sm"
          data-testid="pack-search-input"
        />
        <Button variant="outline" size="sm" onClick={() => void refresh(search)}>
          {t("packs.market.search")}
        </Button>
        <select
          value={sizeKey}
          onChange={(e) => setSizeKey(e.target.value)}
          aria-label={t("packs.market.agentSize")}
          data-testid="pack-agent-size-filter"
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
        >
          {AGENT_SIZE_FILTERS.map((f) => (
            <option key={f.key || "all"} value={f.key}>
              {f.key
                ? t("packs.market.agentSizeValue", { value: f.key })
                : t("packs.market.agentSizeAny")}
            </option>
          ))}
        </select>
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3" data-testid="pack-category-chips">
          <button
            onClick={() => {
              setCategory("");
              void refresh(search, "");
            }}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              category === "" ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("packs.market.allCategories")}
          </button>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => {
                setCategory(c);
                void refresh(search, c);
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                category === c ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {!category && !search &&
        visiblePacks.filter((p) => p.featured).length > 0 && (
          <div className="mb-4" data-testid="pack-featured-rail">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">{t("packs.market.featured")}</p>
            <div className="grid gap-3">
              {visiblePacks
                .filter((p) => p.featured)
                .map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setDetailId(p.id)}
                    className="text-left border border-primary/40 rounded-lg p-4 hover:border-primary/70 transition-colors bg-primary/5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground flex items-center gap-1.5">
                        {p.name}
                        {p.facade && <Badge data-testid={`pack-facade-badge-${p.id}`}>{t("packs.market.facade")}</Badge>}
                      </span>
                      <span className="text-xs text-muted-foreground">v{p.version}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{p.description}</p>
                  </button>
                ))}
            </div>
          </div>
        )}
      {loading && <MarketSkeleton />}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md mb-4 space-y-1" data-testid="pack-market-error">
          <p>{error}</p>
          <button type="button" className="text-sm text-destructive underline" onClick={() => void refresh(search)}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {!loading && !error && visiblePacks.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("packs.market.empty")}</p>
      )}

      <div className="grid gap-3">
        {visiblePacks.map((pack) => (
          <button
            key={pack.id}
            onClick={() => setDetailId(pack.id)}
            data-testid={`pack-card-${pack.id}`}
            className="text-left border border-border rounded-lg p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground flex items-center gap-1.5">
                {pack.name}
                {pack.facade && <Badge data-testid={`pack-facade-badge-${pack.id}`}>{t("packs.market.facade")}</Badge>}
              </span>
              <span className="text-xs text-muted-foreground">v{pack.version}</span>
            </div>
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{pack.description}</p>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {pack.tags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
              <span className="text-xs text-muted-foreground ml-auto">{pack.authorEmail}</span>
            </div>
          </button>
        ))}
      </div>

      <PackDetailDialog
        packId={detailId}
        onOpenChange={(open) => !open && setDetailId(null)}
        onSubscribed={(r, name, packId) => {
          setReport(r);
          setReportPack(name);
          setReportPackId(packId);
          void refresh(search);
        }}
        onGotoMine={onGotoMine}
        onRequireLogin={onRequireLogin}
      />

      {/* Post-subscribe per-part report (spec: pack-installation). */}
      {report && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="pack-install-report"
          onClick={() => setReport(null)}
        >
          <div
            className="bg-background border border-border rounded-lg max-w-lg w-full max-h-[80vh] overflow-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-foreground mb-1">{t("packs.report.title", { name: reportPack })}</h3>
            <p className="text-xs text-muted-foreground mb-3">{t("packs.report.hint")}</p>
            <div className="space-y-1 text-sm">
              {report.skills.map((s) => (
                <div key={s.name} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.skill")}</span>
                  <span className="text-foreground">{s.name}</span>
                  <span className="ml-auto">{statusLabel(t, s.status)}</span>
                  {s.reason && <span className="text-xs text-destructive w-full">{s.reason}</span>}
                  {/* Disclosure (add-packaged-skills 5.2): tree skills state
                      their file count and name their script files. */}
                  {s.fileCount != null && (
                    <span className="text-xs text-muted-foreground w-full" data-testid={`pack-report-files-${s.name}`}>
                      {s.scriptFiles?.length
                        ? t("packs.report.filesWithScripts", {
                            count: s.fileCount,
                            scripts: s.scriptFiles.join("、"),
                          })
                        : t("packs.report.files", { count: s.fileCount })}
                    </span>
                  )}
                </div>
              ))}
              {report.mcpServers.map((m) => (
                <div key={m.name} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.mcp")}</span>
                  <span className="text-foreground">{m.name}</span>
                  <span className="ml-auto">{statusLabel(t, m.status)}</span>
                  {m.reason && <span className="text-xs text-destructive w-full">{m.reason}</span>}
                </div>
              ))}
              {report.agents.map((a) => (
                <div key={a.id} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.agent")}</span>
                  <span className="text-foreground">{a.name}</span>
                  <span className="ml-auto">{statusLabel(t, a.status)}</span>
                  {a.reason && <span className="text-xs text-destructive w-full">{a.reason}</span>}
                </div>
              ))}
              {/* Bot units (pack-bot-units): mirror the agents rows; an
                  awaiting-credential bot is information, not an error — the
                  operator's channel setup is the explicit next step. */}
              {(report.bots ?? []).map((b) => (
                <div key={b.id} className="flex gap-2" data-testid={`pack-report-bot-${b.id}`}>
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.bot")}</span>
                  <span className="text-foreground">{b.name}</span>
                  <span className="ml-auto">{statusLabel(t, b.status)}</span>
                  {b.reason && (
                    <span className="text-xs text-muted-foreground w-full">{b.reason}</span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <Button size="sm" onClick={() => setReport(null)}>
                {t("common.close")}
              </Button>
            </div>
            {/* Next-steps wizard footer (add-pack-tutorials-and-wizard +
                simplify-chat-and-agents-ia): the report ends by taking the
                user straight into a conversation with what they just
                installed — the CTA carries the installed role (and, for a
                multi-role pack, the cluster bind intent), so no manual
                re-selection step remains. The report itself is unchanged. */}
            <NextStepsFooter
              target={chatTarget}
              clusterMode={chatClusterMode}
              onOpenChat={onOpenChat}
              onDismiss={() => setReport(null)}
            />
          </div>
        </div>
      )}
    </section>
  );
}

// The report's next-steps footer — the only routing-dependent piece of this
// view, and therefore its own component: useNavigate runs only when the
// footer actually renders. Hosts that pass onOpenChat={null} never mount it,
// so this view stays borrowable by router-less shells (facet-platform: the
// facet shell adds no router dependency — a top-level useNavigate here is
// exactly what blanked #/packs in production).
function NextStepsFooter({
  target,
  clusterMode,
  onOpenChat,
  onDismiss,
}: {
  target: string;
  clusterMode: boolean;
  onOpenChat?: (() => void) | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (onOpenChat === null) return null;
  return (
    <div
      className="mt-3 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
      data-testid="pack-install-next"
    >
      <span className="text-xs text-muted-foreground">
        {t(clusterMode ? "packs.report.nextHintCluster" : "packs.report.nextHint")}
      </span>
      <button
        className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        onClick={() => {
          onDismiss();
          onOpenChat ? onOpenChat() : navigate(target);
        }}
        data-testid="pack-install-open-chat"
      >
        {t(clusterMode ? "packs.report.openChatCluster" : "packs.report.openChat")}
      </button>
    </div>
  );
}

function statusLabel(t: (k: string) => string, status: string) {
  const key = `packs.report.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}
