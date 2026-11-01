// 策展板 — the facet curation board (add-facet-content-management), the
// admin surface that finally makes 谦面's content manageable in its own
// domain: every pack (unlisted and private included, via the admin viewer),
// inline category/featured writes, and per-pack usage from the platform
// gateway's aggregate (weekly actives / turns — the M1 exit metric). Usage
// degrades honestly; curation never depends on it. Presentation-level only:
// curation never changes visibility, content, or installability.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackSummary } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";

type UsageRow = { packId: string | null; turns: number; activeUsers: number; lastUsedAt: number };

export function CurateView() {
  const { t } = useTranslation();
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await api.listPacks({ pageSize: 100 });
      setPacks(r.packs);
    } catch (err) {
      setPacks([]);
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .getPackUsageBoard()
      .then((r) => setUsage(r.rows))
      .catch((e: Error) => setUsageError(e.message));
  }, [refresh]);

  const save = async (pack: PackSummary, body: { category?: string; featured?: boolean }) => {
    try {
      await api.setPackCuration(pack.id, body);
      setNotice(t("facetCurate.saved", { name: pack.name }));
      await refresh();
    } catch (err) {
      setNotice(t("facetCurate.saveFailed", { name: pack.name, message: (err as Error).message }));
    }
  };

  const usageOf = (id: string) => usage?.find((r) => r.packId === id) ?? null;

  if (!packs) return <BoardSkeleton />;
  if (loadError)
    return (
      <div className="text-sm text-destructive space-y-2" data-testid="facet-curate-error">
        <p>{t("facetCurate.errorLoad", { message: loadError })}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t("common.retry")}
        </Button>
      </div>
    );

  return (
    <section data-testid="facet-curate-view" className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">{t("facetCurate.title")}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t("facetCurate.subtitle")}</p>
      </header>

      {notice && (
        <p data-testid="facet-curate-notice" className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">
          {notice}
        </p>
      )}

      {usageError && (
        <p data-testid="facet-curate-usage-degraded" className="text-xs text-amber-600 border border-amber-600/30 bg-amber-500/5 rounded-md px-3 py-2">
          {t("facetCurate.usageDegraded", { message: usageError })}
        </p>
      )}

      {packs.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="facet-curate-empty">
          {t("facetCurate.empty")}
        </p>
      )}

      <div className="grid gap-3">
        {packs.map((p) => {
          const u = usageOf(p.id);
          return (
            <div key={p.id} data-testid={`facet-curate-row-${p.id}`} className="border border-border rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className="text-xs text-muted-foreground">
                  v{p.version} · {p.authorEmail}
                  {p.unlisted ? ` · ${t("facetCurate.unlisted")}` : ""}
                  {p.visibility === "private" ? ` · ${t("facetCurate.private")}` : ""}
                  {u ? ` · ${t("facetCurate.usage", { users: u.activeUsers, turns: u.turns })}` : ""}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={drafts[p.id] ?? p.category ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  placeholder={t("facetCurate.categoryPlaceholder")}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs w-56"
                  data-testid={`facet-curate-category-${p.id}`}
                />
                <Button variant="outline" size="sm" onClick={() => void save(p, { category: (drafts[p.id] ?? p.category ?? "").trim() })}>
                  {t("facetCurate.setCategory")}
                </Button>
                <Button
                  variant={p.featured ? "default" : "outline"}
                  size="sm"
                  onClick={() => void save(p, { featured: !p.featured })}
                  data-testid={`facet-curate-featured-${p.id}`}
                >
                  {p.featured ? t("facetCurate.unfeature") : t("facetCurate.feature")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Structural skeleton matching a loaded row: title line + meta line + control line. */
function BoardSkeleton() {
  return (
    <section className="space-y-4" data-testid="facet-curate-skeleton">
      <div className="h-6 w-40 animate-pulse rounded bg-muted" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-border rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 w-56 animate-pulse rounded-md bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded-md bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
      ))}
    </section>
  );
}
