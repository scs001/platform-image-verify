// ── Boards page (add-line-boards-and-action-gate, task 11) ───────────────────
//
// /boards/:line — renders a line board with blocks (metrics/list/timeline).
// Supports tabbed views via hash (#overview, #my-packs, etc.).
// Each block loads independently; errors are per-block.
// Provides an "打开原站" link to the product's origin URL.

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ExternalLink, Loader2, AlertCircle } from "lucide-react";

interface BlockAction {
  id: string;
  label: string;
  args?: unknown;
}

interface Block {
  id: string;
  type: "metrics" | "list" | "timeline";
  title: string;
  data?: unknown;
  error?: string;
  actions?: BlockAction[];
}

interface BoardData {
  line: string;
  title: string;
  originUrl: string;
  blocks: Block[];
}

const TABS: Record<string, string[]> = {
  facet: ["overview", "my-packs", "publish-history"],
  wanxing: ["fleet-summary", "missions", "deployments"],
};

export function BoardsPage() {
  const { line } = useParams<{ line: string }>();
  const [data, setData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Current tab from hash or default to first available
  const [currentTab, setCurrentTab] = useState(() => {
    if (!line || !TABS[line]) return "";
    const hash = window.location.hash.slice(1);
    return TABS[line].includes(hash) ? hash : TABS[line][0];
  });

  // Sync tab from hash on mount and when navigating
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (line && TABS[line] && TABS[line].includes(hash)) {
        setCurrentTab(hash);
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    handleHashChange(); // initial sync
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [line]);

  // Refetch on tab change
  useEffect(() => {
    setRefreshTick((n) => n + 1);
  }, [currentTab]);

  useEffect(() => {
    if (!line) return;

    setLoading(true);
    setError(null);

    fetch(`/api/boards/${line}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json();
      })
      .then((json) => {
        if (json.error || json.message) {
          setError(json.message || json.error || "该线尚未接入");
          setData(null);
        } else {
          setData(json);
        }
      })
      .catch((err) => {
        setError(err.message || "网络错误");
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [line, refreshTick]);

  // Board refresh: a `board_changed` WS event (broadcast by the action gate
  // after an approved action executes) refetches this line's blocks.
  useEffect(() => {
    if (!line) return;
    const onBoardChanged = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { line?: string } | undefined;
      if (!detail?.line || detail.line === line) setRefreshTick((n) => n + 1);
    };
    window.addEventListener("board_changed", onBoardChanged as EventListener);
    return () => window.removeEventListener("board_changed", onBoardChanged as EventListener);
  }, [line]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          该线尚未接入，请稍后再试。
        </div>
        {data && (
          <a
            href={data.originUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            打开原站
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{data.title}</h1>
          <p className="text-sm text-muted-foreground">壹座 · {data.line} 看板</p>
        </div>
        <a
          href={data.originUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          打开原站
        </a>
      </div>

      {/* Tabs */}
      {line && TABS[line] && TABS[line].length > 1 && (
        <div className="flex items-center gap-2 border-b border-border">
          {TABS[line].map((tab) => (
            <button
              key={tab}
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
            // Simple filter: block.id contains tab name or is global
            if (!currentTab) return true;
            return block.id.includes(currentTab) || block.id === "metrics" || block.id === "recent_events";
          })
          .map((block) => (
            <BlockCard key={block.id} block={block} />
          ))}
      </div>
    </div>
  );
}

// Placeholder for i18n until v17 (use react-i18next in production)
function t(key: string, _params?: Record<string, string>): string {
  const translations: Record<string, string> = {
    "board.tab.overview": "概览",
    "board.tab.my-packs": "我的包",
    "board.tab.publish-history": "发布记录",
    "board.tab.fleet-summary": "舰队概况",
    "board.tab.missions": "任务",
    "board.tab.deployments": "部署",
  };
  return translations[key] || key;
}

interface MetricsBlockProps {
  block: {
    id: string;
    type: "metrics";
    title: string;
    data?: Record<string, number>;
  };
}

function MetricsBlock({ block }: MetricsBlockProps) {
  const data = block.data ?? {};

  return (
    <div data-testid={`block-${block.id}`} className="rounded-md border border-border bg-background px-4 py-3">
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{block.title}</h3>
      <div className="grid grid-cols-2 gap-4">
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="text-center">
            <div className="text-lg font-semibold">{value}</div>
            <div className="text-xs text-muted-foreground">{key}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ListBlockProps {
  block: {
    id: string;
    type: "list";
    title: string;
    data?: unknown[];
    actions?: BlockAction[];
  };
}

function ListBlock({ block }: ListBlockProps) {
  const rows = Array.isArray(block.data) ? block.data : [];
  const [proposing, setProposing] = useState<string | null>(null);
  const [proposedId, setProposedId] = useState<string | null>(null);

  const handlePropose = async (action: BlockAction) => {
    setProposing(action.id);
    try {
      const res = await fetch("/api/actions/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: action.id, args: action.args }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        alert(json.error || "提议失败");
      } else {
        setProposedId(json.proposalId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "网络错误";
      alert(message);
    } finally {
      setProposing(null);
    }
  };

  return (
    <div data-testid={`block-${block.id}`} className="rounded-md border border-border bg-background">
      <div className="border-b border-border px-4 py-2 text-sm font-medium">{block.title}</div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">空列表</div>
      ) : (
        <div className="divide-y divide-border">
          {rows.slice(0, 10).map((row, i) => (
            <div key={i} className="px-4 py-2 text-sm">
              {typeof row === "object" && row !== null ? JSON.stringify(row) : String(row)}
            </div>
          ))}
        </div>
      )}
      {/* Actions */}
      {block.actions && block.actions.length > 0 && (
        <div className="mt-2 flex items-center gap-2 px-4 pb-3">
          {block.actions.map((action) => (
            <button
              key={action.id}
              onClick={() => handlePropose(action)}
              disabled={proposing === action.id || !!proposedId}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {proposing === action.id ? "提议中..." : proposedId ? "已提议" : action.label}
            </button>
          ))}
          {proposedId && (
            <span className="text-xs text-muted-foreground">Proposal ID: {proposedId.slice(0, 8)}…</span>
          )}
        </div>
      )}
    </div>
  );
}

interface TimelineBlockProps {
  block: {
    id: string;
    type: "timeline";
    title: string;
    data?: unknown[];
  };
}

function TimelineBlock({ block }: TimelineBlockProps) {
  const events = Array.isArray(block.data) ? block.data : [];

  return (
    <div data-testid={`block-${block.id}`} className="rounded-md border border-border bg-background">
      <div className="border-b border-border px-4 py-2 text-sm font-medium">{block.title}</div>
      {events.length === 0 ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">暂无事件</div>
      ) : (
        <div className="space-y-2 px-4 py-3">
          {events.slice(0, 10).map((event, i) => {
            const evt = event as Record<string, unknown>;
            const timeVal: string | number = (evt.createdAt ?? evt.created_at) as string | number;
            const text = evt.text ?? evt.description;
            const timeStr = typeof timeVal === "string" || typeof timeVal === "number"
              ? new Date(timeVal).toLocaleString()
              : new Date().toLocaleString();
            return (
              <div key={i} className="text-sm">
                <span className="text-xs text-muted-foreground">{timeStr}</span>
                <span className="ml-2">{String(text ?? event)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BlockCard({ block }: { block: Block }) {
  if (block.error) {
    return (
      <div
        data-testid={`block-${block.id}-error`}
        className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          <span>{block.title}: {block.error}</span>
        </div>
      </div>
    );
  }

  // Use type guard to narrow
  if (block.type === "metrics") {
    return <MetricsBlock block={block as MetricsBlockProps["block"]} />;
  }
  if (block.type === "list") {
    return <ListBlock block={block as ListBlockProps["block"]} />;
  }
  if (block.type === "timeline") {
    return <TimelineBlock block={block as TimelineBlockProps["block"]} />;
  }

  return <div className="text-xs text-muted-foreground">{block.title}</div>;
}
