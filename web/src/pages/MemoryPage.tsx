// MemoryPage.tsx — 记忆面板（add-unified-memory-and-outputs 3.3, spec:
// memory-portal-ui）。owner 看自己的 u/ 记忆：类型/层/tier/tag/时间筛选，
// reference 名份行可跳资料库/成果原位；降级态解释而不空转。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  listMemoryEntries, listPromotions, acceptPromotion, ignorePromotion,
  type MemoryEntry, type MemoryQuery, type PromotionProposal,
} from "@/api/memory";

const LAYERS = ["L0", "L1", "L2"] as const;
const TIERS = ["draft", "stable", "canonical"] as const;

const LAYER_LABEL: Record<string, string> = { L0: "观察", L1: "笔记/交接", L2: "事实/经验" };

export function MemoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [items, setItems] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [layer, setLayer] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [scope, setScope] = useState<string>("");
  // 待确认晋升（add-tier-promotion-candidates 5.1）：AI 提议、人批。读失败
  // 静默——这个区块是列表上的增益，坏了不能拖累记忆本面。
  const [promotions, setPromotions] = useState<PromotionProposal[]>([]);
  const [busyPromotion, setBusyPromotion] = useState<string | null>(null);

  const loadPromotions = useCallback(async () => {
    try {
      const out = await listPromotions(scope.trim() || undefined);
      setPromotions(out.proposals);
    } catch {
      setPromotions([]);
    }
  }, [scope]);

  useEffect(() => {
    void loadPromotions();
  }, [loadPromotions]);

  const load = useCallback(async () => {
    setLoading(true);
    setDegraded(null);
    const q: MemoryQuery = { limit: 100 };
    if (layer) q.layer = layer;
    if (tier) q.tier = tier;
    if (scope.trim()) q.scope = scope.trim();
    try {
      const out = await listMemoryEntries(q);
      setItems(out.items);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setDegraded(code === "memory_unavailable" ? t("memory.degraded.unavailable") : String((e as Error).message));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [layer, tier, scope, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPromotionGesture = async (kind: "accept" | "ignore", path: string) => {
    setBusyPromotion(path);
    try {
      await (kind === "accept" ? acceptPromotion(path) : ignorePromotion(path));
    } catch {
      /* 降级静默：手势失败不打断面板，提议留在面上可重试 */
    } finally {
      setBusyPromotion(null);
      setPromotions((prev) => prev.filter((p) => p.path !== path));
      void load(); // 接受会翻 tier——列表/徽章取最新（5.2 复用既有 tier 渲染，不另造解析）
    }
  };

  const projects = useMemo(() => [...new Set(items.map((i) => i.project))].slice(0, 8), [items]);

  return (
    <div className="flex h-full flex-col bg-background" data-testid="memory-page">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">{t("memory.title")}</h1>
          <span className="text-xs text-muted-foreground">{t("memory.subtitle")}</span>
          <div className="ml-auto flex items-center gap-2">
            <input
              className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              placeholder={t("memory.scopePlaceholder")}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              data-testid="memory-scope"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="memory-filters">
          <span className="text-xs text-muted-foreground">{t("memory.layerLabel")}</span>
          {([null, ...LAYERS] as const).map((l) => (
            <button
              key={`layer-${l ?? "all"}`}
              className={`rounded-md px-2.5 py-1 text-xs ${layer === l ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setLayer(l)}
              data-testid={`memory-layer-${l ?? "all"}`}
            >
              {l === null ? t("memory.all") : `${l}·${LAYER_LABEL[l]}`}
            </button>
          ))}
          <span className="ml-2 text-xs text-muted-foreground">{t("memory.tierLabel")}</span>
          {([null, ...TIERS] as const).map((tr) => (
            <button
              key={`tier-${tr ?? "all"}`}
              className={`rounded-md px-2.5 py-1 text-xs ${tier === tr ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"}`}
              onClick={() => setTier(tr)}
              data-testid={`memory-tier-${tr ?? "all"}`}
            >
              {tr === null ? t("memory.all") : t(`resources.memory.tier.${tr}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {!degraded && promotions.length > 0 ? (
          <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 p-3" data-testid="memory-promotions">
            <div className="text-sm font-medium text-primary" data-testid="memory-promotions-count">
              {t("memory.promotions.title")} <span className="text-xs font-normal text-muted-foreground">({promotions.length})</span>
            </div>
            <div className="mt-2 space-y-2">
              {promotions.map((p) => (
                <div key={p.path} className="rounded-md border border-border bg-background px-3 py-2" data-testid="memory-promotion">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm" data-testid="memory-promotion-title">{p.title}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {t(`resources.memory.tier.${p.current_tier}`)} → {t(`resources.memory.tier.${p.proposed_tier}`)}
                    </span>
                  </div>
                  {p.reason ? <div className="mt-1 text-xs text-muted-foreground">{p.reason}</div> : null}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                      onClick={() => void runPromotionGesture("accept", p.path)}
                      disabled={busyPromotion === p.path}
                      data-testid="memory-promotion-accept"
                    >
                      {t("memory.promotions.accept")}
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                      onClick={() => void runPromotionGesture("ignore", p.path)}
                      disabled={busyPromotion === p.path}
                      data-testid="memory-promotion-ignore"
                    >
                      {t("memory.promotions.ignore")}
                    </button>
                    <span className="text-xs text-muted-foreground">{String(p.proposed_at ?? "").slice(0, 10)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {degraded ? (
          <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground" data-testid="memory-degraded">
            {degraded}
          </div>
        ) : loading ? (
          <div className="text-sm text-muted-foreground">{t("memory.loading")}</div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground" data-testid="memory-empty">
            {t("memory.empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div key={it.path} className="rounded-md border border-border px-3 py-2" data-testid="memory-entry">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {it.layer}·{it.type ?? "page"}
                  </span>
                  {it.tier && it.tier !== "draft" ? (
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs border ${it.tier === "canonical" ? "border-amber-500/50 bg-amber-500/10 text-amber-500" : "border-primary/40 bg-primary/10 text-primary"}`}
                    >
                      {t(`resources.memory.tier.${it.tier}`)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-sm" data-testid="memory-entry-title">{it.title}</span>
                  <span className="text-xs text-muted-foreground">{String(it.ts ?? "").slice(0, 10)}</span>
                </div>
                {(it.tags?.length ?? 0) > 0 || it.source_ref ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    {it.tags?.map((tag) => (
                      <span key={tag} className="rounded-full bg-muted/60 px-2 py-0.5">{tag}</span>
                    ))}
                    {it.source_ref?.startsWith("resource:") ? (
                      <button
                        type="button"
                        className="rounded-md border border-border px-2 py-0.5 hover:bg-muted"
                        onClick={() => navigate("/resources")}
                        data-testid="memory-jump-source"
                      >
                        {t("memory.openInLibrary")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {projects.length > 1 ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t("memory.projects")}</span>
            {projects.map((p) => (
              <button key={p} className="rounded-md border border-border px-2 py-0.5 hover:bg-muted" onClick={() => setScope(p)}>
                {p}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default MemoryPage;
