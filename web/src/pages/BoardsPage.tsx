// ── Boards page (add-line-boards-and-action-gate task 11; add-wire-line-board 5.2/5.3)
//
// /boards/:line — renders a line board with blocks (metrics/list/timeline).
// Tabs via hash (#overview, #datasets, …); blocks carry the tab name in their
// id. Each block loads independently; errors are per-block. Every block keeps
// a deep link into the product's own console, and the page never claims to be
// the product.
//
// Connection truth comes from the adapter: `connected: false` renders the
// not-connected / re-authorize card with the connect-card pointer and NO data.
// Inline actions (block-level and row-level) go through the action gate —
// POST /api/actions/propose — and the resulting proposal is confirmed right
// here with the same ActionCard the copilot uses (user-filled fields included).
//
// Surfaces exist only while the deployment switch is on (useAppConfig
// .lineBoardsEnabled, add-wire-line-board D8).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { ExternalLink, Loader2, AlertCircle, Plug } from "lucide-react";
import { useAppConfig } from "@/hooks/useAppConfig";
import { ActionCard, type ActionProposal } from "@/components/ActionCard";

interface BlockAction {
  id: string;
  label: string;
  args?: unknown;
}

interface BlockLink {
  label: string;
  href: string;
}

interface ListRow {
  id?: string | number;
  title?: string;
  subtitle?: string;
  badges?: string[];
  href?: string;
  rowActions?: BlockAction[];
  [key: string]: unknown;
}

interface Block {
  id: string;
  type: "metrics" | "list" | "timeline";
  title: string;
  data?: unknown;
  error?: string;
  actions?: BlockAction[];
  links?: BlockLink[];
  href?: string;
  partial?: string[];
}

interface BoardData {
  line: string;
  title: string;
  originUrl: string;
  blocks: Block[];
  connected?: boolean;
  reason?: "not_connected" | "expired";
  connectPath?: string;
}

const TABS: Record<string, string[]> = {
  facet: ["overview", "my-packs", "publish-history"],
  wanxing: ["fleet-summary", "missions", "deployments"],
  wire: ["overview", "datasets", "artifacts", "demands"],
};

export function BoardsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { lineBoardsEnabled } = useAppConfig();
  const { line } = useParams<{ line: string }>();
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  // Current tab from hash or default to first available
  const [currentTab, setCurrentTab] = useState(() => {
    if (!line || !TABS[line]) return "";
    const hash = window.location.hash.slice(1);
    return TABS[line].includes(hash) ? hash : TABS[line][0];
  });

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (line && TABS[line] && TABS[line].includes(hash)) {
        setCurrentTab(hash);
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [line]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is a deliberate refetch trigger
  useEffect(() => {
    if (!line || !lineBoardsEnabled) return;

    setLoading(true);
    setError(null);

    fetch(`/api/boards/${line}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || json.error || res.statusText);
        return json;
      })
      .then((json) => {
        if (json.error) {
          setError(json.message || json.error || t("board.notFound"));
          setData(null);
        } else {
          setData(json);
        }
      })
      .catch((err) => {
        setError(err.message || t("board.notFound"));
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [line, refreshTick, lineBoardsEnabled]);

  // Refresh signals: `board_changed` after an approved action executed, and
  // `line_credential_stale` when the upstream rejected the user's credential —
  // the refetch then lands on the not-connected card.
  useEffect(() => {
    if (!line) return;
    const onBoardChanged = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { line?: string } | undefined;
      if (!detail?.line || detail.line === line) refresh();
    };
    const onStale = () => refresh();
    window.addEventListener("board_changed", onBoardChanged as EventListener);
    window.addEventListener("line_credential_stale", onStale);
    return () => {
      window.removeEventListener("board_changed", onBoardChanged as EventListener);
      window.removeEventListener("line_credential_stale", onStale);
    };
  }, [line, refresh]);

  if (!lineBoardsEnabled) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6" data-testid="board-disabled">
        <div className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">{t("board.disabled")}</div>
      </div>
    );
  }

  // First load only: a refetch (board_changed / credential stale / after an
  // inline action) keeps the current blocks on screen so the user's tab,
  // scroll and any open confirmation card survive (line-boards spec: refresh
  // must not reset the board's state).
  if (loading && !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6" data-testid="board-not-found">
        <div className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">{t("board.notFound")}</div>
        {data && <OriginLink href={(data as BoardData).originUrl} label={t("board.openOrigin")} />}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6" data-testid={`board-${data.line}`}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{data.title}</h1>
          <p className="text-sm text-muted-foreground">{t("board.subtitle", { line: data.line })}</p>
        </div>
        <OriginLink href={data.originUrl} label={t("board.openOrigin")} />
      </div>

      {data.connected === false ? (
        <div data-testid="board-unconnected" className="space-y-3 rounded-md border border-border bg-muted px-4 py-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Plug className="h-4 w-4" />
            {data.reason === "expired" ? t("board.unconnected.expiredTitle") : t("board.unconnected.title")}
          </div>
          <p className="text-muted-foreground">
            {data.reason === "expired" ? t("board.unconnected.expiredBody") : t("board.unconnected.body", { title: data.title })}
          </p>
          {data.connectPath && (
            <button
              type="button"
              data-testid="board-connect"
              onClick={() => navigate(data.connectPath!)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("board.unconnected.connect")}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Tabs */}
          {line && TABS[line] && TABS[line].length > 1 && (
            <div className="flex items-center gap-2 border-b border-border">
              {TABS[line].map((tab) => (
                <button
                  type="button"
                  key={tab}
                  data-testid={`board-tab-${tab}`}
                  onClick={() => {
                    window.location.hash = tab;
                  }}
                  className={
                    currentTab === tab
                      ? "border-b-2 border-primary px-4 py-2 text-sm font-medium text-primary"
                      : "px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
                  }
                >
                  {t(`board.tab.${tab}`, { defaultValue: tab.replace("-", " ") })}
                </button>
              ))}
            </div>
          )}

          {/* Blocks filtered by tab */}
          <div className="space-y-4">
            {data.blocks
              .filter((block) => {
                if (!currentTab) return true;
                return block.id.includes(currentTab) || block.id === "metrics" || block.id === "recent_events";
              })
              .map((block) => (
                <BlockCard key={block.id} block={block} onChanged={refresh} />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function OriginLink({ href, label, small = false }: { href: string; label: string; small?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        small
          ? "inline-flex items-center gap-1 text-xs text-primary hover:underline"
          : "inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
      }
    >
      <ExternalLink className={small ? "h-3 w-3" : "h-3.5 w-3.5"} />
      {label}
    </a>
  );
}

// Propose through the gate and hand the proposal to an inline ActionCard.
function useProposer(onChanged: () => void) {
  const { t } = useTranslation();
  const [proposing, setProposing] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ActionProposal | null>(null);
  const [failure, setFailure] = useState<{ message: string; connectPath?: string } | null>(null);

  const propose = async (action: BlockAction, key: string) => {
    setProposing(key);
    setFailure(null);
    try {
      const res = await fetch("/api/actions/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: action.id, args: action.args ?? {} }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        setFailure({ message: json.details || json.error || t("action.failed"), connectPath: json.connectPath });
      } else {
        setProposal(json as ActionProposal);
      }
    } catch (err: unknown) {
      setFailure({ message: err instanceof Error ? err.message : t("action.failed") });
    } finally {
      setProposing(null);
    }
  };

  const card = proposal ? (
    <div className="px-4 pb-3">
      <ActionCard
        proposal={proposal}
        onResolved={(o) => {
          if (o.state === "executed" || o.state === "approved") onChanged();
        }}
      />
    </div>
  ) : null;

  return { propose, proposing, card, failure, clearProposal: () => setProposal(null) };
}

interface MetricsBlockProps {
  block: Block & { type: "metrics"; data?: Record<string, number | string> };
}

function MetricsBlock({ block }: MetricsBlockProps) {
  const { t } = useTranslation();
  const data = block.data ?? {};
  return (
    <div data-testid={`block-${block.id}`} className="rounded-md border border-border bg-background px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">{block.title}</h3>
        {block.href && <OriginLink href={block.href} label={t("board.openOrigin")} small />}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="text-center">
            <div className="text-lg font-semibold">{String(value)}</div>
            <div className="text-xs text-muted-foreground">{key}</div>
          </div>
        ))}
      </div>
      {block.partial && block.partial.length > 0 && (
        <p data-testid={`block-${block.id}-partial`} className="mt-2 text-xs text-warning">
          {t("board.partial", { blocks: block.partial.join("、") })}
        </p>
      )}
    </div>
  );
}

interface ListBlockProps {
  block: Block & { type: "list"; data?: unknown[] };
  onChanged: () => void;
}

function ListBlock({ block, onChanged }: ListBlockProps) {
  const { t } = useTranslation();
  const rows = (Array.isArray(block.data) ? block.data : []) as ListRow[];
  const { propose, proposing, card, failure } = useProposer(onChanged);

  return (
    <div data-testid={`block-${block.id}`} className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm font-medium">
        <span>{block.title}</span>
        {block.href && <OriginLink href={block.href} label={t("board.openOrigin")} small />}
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">{t("board.empty")}</div>
      ) : (
        <div className="divide-y divide-border">
          {rows.slice(0, 20).map((row, i) => {
            const key = row.id !== undefined ? `${block.id}-${row.id}` : `${block.id}-row-${i}`;
            const isShaped = typeof row === "object" && row !== null && typeof row.title === "string";
            return (
              <div key={key} data-testid={`${block.id}-row`} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                {isShaped ? (
                  <>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{row.title}</span>
                        {(row.badges ?? []).map((b) => (
                          <span key={b} className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {b}
                          </span>
                        ))}
                      </div>
                      {row.subtitle && <div className="truncate text-xs text-muted-foreground">{row.subtitle}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {(row.rowActions ?? []).map((a) => (
                        <button
                          type="button"
                          key={a.id}
                          data-testid={`row-action-${a.id}`}
                          onClick={() => propose(a, key + a.id)}
                          disabled={proposing !== null}
                          className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          {proposing === key + a.id ? t("board.proposing") : a.label}
                        </button>
                      ))}
                      {row.href && <OriginLink href={row.href} label={t("board.openOrigin")} small />}
                    </div>
                  </>
                ) : (
                  <span className="break-all font-mono text-xs">{typeof row === "object" ? JSON.stringify(row) : String(row)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* Block-level actions + links */}
      {((block.actions && block.actions.length > 0) || (block.links && block.links.length > 0)) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 px-4 pb-3">
          {(block.actions ?? []).map((action) => (
            <button
              type="button"
              key={action.id}
              data-testid={`block-action-${action.id}`}
              onClick={() => propose(action, action.id)}
              disabled={proposing !== null}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {proposing === action.id ? t("board.proposing") : action.label}
            </button>
          ))}
          {(block.links ?? []).map((l) => (
            <OriginLink key={l.href} href={l.href} label={l.label} small />
          ))}
        </div>
      )}
      {failure && (
        <div data-testid="block-propose-failure" className="px-4 pb-3 text-xs text-destructive">
          {failure.message}
          {failure.connectPath && (
            <a href={failure.connectPath} className="ml-2 text-primary hover:underline">
              {t("board.unconnected.connect")}
            </a>
          )}
        </div>
      )}
      {card}
    </div>
  );
}

interface TimelineBlockProps {
  block: Block & { type: "timeline"; data?: unknown[] };
}

function TimelineBlock({ block }: TimelineBlockProps) {
  const { t } = useTranslation();
  const events = Array.isArray(block.data) ? block.data : [];

  return (
    <div data-testid={`block-${block.id}`} className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 text-sm font-medium">
        <span>{block.title}</span>
        {block.href && <OriginLink href={block.href} label={t("board.openOrigin")} small />}
      </div>
      {events.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">{t("board.noEvents")}</div>
      ) : (
        <div className="space-y-2 px-4 py-3">
          {events.slice(0, 20).map((event, i) => {
            const evt = event as Record<string, unknown>;
            const timeVal = (evt.createdAt ?? evt.created_at) as string | number | undefined;
            const text = evt.text ?? evt.description;
            const timeStr = typeof timeVal === "string" || typeof timeVal === "number" ? new Date(timeVal).toLocaleString() : "";
            const key = evt.id !== undefined ? `${block.id}-${String(evt.id)}` : `${block.id}-timeline-${i}`;
            return (
              <div key={key} data-testid={`${block.id}-event`} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  {timeStr && <span className="text-xs text-muted-foreground">{timeStr}</span>}
                  <span className="ml-2">{String(text ?? JSON.stringify(event))}</span>
                </div>
                {typeof evt.href === "string" && <OriginLink href={evt.href} label={t("board.openOrigin")} small />}
              </div>
            );
          })}
        </div>
      )}
      {block.links && block.links.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
          {block.links.map((l) => (
            <OriginLink key={l.href} href={l.href} label={l.label} small />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockCard({ block, onChanged }: { block: Block; onChanged: () => void }) {
  const { t } = useTranslation();
  if (block.error) {
    return (
      <div
        data-testid={`block-${block.id}-error`}
        className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          <span>
            {block.title}: {block.error}
          </span>
        </div>
        {block.href && <OriginLink href={block.href} label={t("board.openOrigin")} small />}
      </div>
    );
  }

  if (block.type === "metrics") {
    return <MetricsBlock block={block as MetricsBlockProps["block"]} />;
  }
  if (block.type === "list") {
    return <ListBlock block={block as ListBlockProps["block"]} onChanged={onChanged} />;
  }
  if (block.type === "timeline") {
    return <TimelineBlock block={block as TimelineBlockProps["block"]} />;
  }

  return <div className="text-xs text-muted-foreground">{block.title}</div>;
}
