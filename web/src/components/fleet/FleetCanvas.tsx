// Fleet canvas (agent-fleet-cockpit v2 face 1) — the cockpit's primary view.
//
// Posts as cards, declared orchestration edges as kind-colored curves, cron
// and external signal sources as virtual nodes; zoom/pan/minimap; in-flight
// turns (the live store) pulse their node and animate the edge that ignited
// them; edge weight rides the cockpit's 24h edgeTraffic. Read-only for now —
// design mode (face 4) reuses this canvas with an edit layer on top.
//
// Route-level lazy chunk: @xyflow/react rides this file's import graph only.
// Layout seeds come from the pure fleet-layout layerer (same algorithm as the
// v1 graph); positions recompute ONLY when the member/edge signature changes,
// so a live event flips data and never shuffles the board.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  KIND_COLORS,
  NODE_COLORS,
  computeGraph,
  type GraphEdge,
  type GraphMember,
} from "@/lib/fleet-layout";
import type { LiveTurn } from "@/store/fleet-store";

// ── input shapes (MemberView projections; kept local so the page owns less) ──

export interface CanvasSlot {
  key: string;
  label: string;
  value: string | number;
  unit: string | null;
  trend: { direction: "up" | "down" | "flat" | "changed"; deltaValue: number | null } | null;
}

export interface CanvasPost {
  id: string;
  title: string;
  kind: string;
  status: string; // presence state: on_duty | paused | missing | vacant | passive
  statusReason: string;
  slots: CanvasSlot[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  cadenceEnabled: boolean;
  effectiveModel: string | null;
  modelNotice: string | null;
  lastTurnFailed: boolean;
  consecutiveFailures: number;
}

export interface CanvasTraffic {
  from: string;
  to: string;
  kind: string;
  turns: number;
}

type PostData = {
  post: CanvasPost;
  live: boolean;
} & Record<string, unknown>;

type SourceData = {
  label: string;
  kind: string;
  live: boolean;
} & Record<string, unknown>;

const STATUS_RING: Record<string, string> = {
  on_duty: "#22c55e",
  paused: "#94a3b8",
  missing: "#f59e0b",
  vacant: "#ef4444",
  passive: "#94a3b8",
};

function trendGlyph(t: CanvasSlot["trend"]): string {
  if (!t) return "";
  return t.direction === "up" ? "↑" : t.direction === "down" ? "↓" : t.direction === "changed" ? "±" : "→";
}

// Same verdict as the tree card's slot chip: up reads success, down reads
// destructive, everything else stays muted (the card's exact coloring — no
// new on-target semantics invented on the canvas).
function trendClass(t: CanvasSlot["trend"]): string {
  return t?.direction === "up" ? "text-success" : t?.direction === "down" ? "text-destructive" : "text-muted-foreground";
}

function fmtClock(v: string | null, locale: string): string {
  if (!v) return "—";
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Edges anchor on these; they are invisible and non-interactive (the canvas
// is read-only — no manual connections in v2 face 1).
const HIDDEN_HANDLE = { style: { opacity: 0, pointerEvents: "none", width: 8, height: 8 } } as const;

function PostNodeView({ data, id }: NodeProps<Node<PostData>>) {
  const { t, i18n } = useTranslation();
  const post = data.post;
  const ring = STATUS_RING[post.status] ?? "#94a3b8";
  return (
    <div
      data-testid={`canvas-node-${id}`}
      className={`w-[220px] rounded-lg border bg-card p-2 text-left shadow-sm transition-shadow ${
        data.live ? "border-blue-500/60 shadow-[0_0_0_3px_rgba(59,130,246,0.25)]" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="relative flex h-2.5 w-2.5 shrink-0" title={post.statusReason}>
          {data.live ? (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: "#3b82f6" }} />
          ) : null}
          <span
            className="relative inline-flex h-2.5 w-2.5 rounded-full"
            style={{ background: ring }}
            data-testid={`canvas-status-${id}`}
          />
        </span>
        <span className="truncate text-xs font-medium" title={post.title}>
          {post.title}
        </span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{t(`fleets.kind.${post.kind}`)}</span>
      </div>
      {post.slots.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {post.slots.slice(0, 4).map((s) => (
            <span
              key={s.key}
              className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-px text-[10px]"
              title={s.unit ? `${s.label} (${s.unit})` : s.label}
            >
              <span className="text-muted-foreground">{s.label}</span>
              <span className="font-medium">{String(s.value)}</span>
              {s.trend ? (
                <span className={trendClass(s.trend)}>
                  {trendGlyph(s.trend)}
                  {s.trend.deltaValue != null && s.trend.direction !== "flat" ? `${s.trend.deltaValue > 0 ? "+" : ""}${s.trend.deltaValue}` : ""}
                </span>
              ) : null}
            </span>
          ))}
          {post.slots.length > 4 ? <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">+{post.slots.length - 4}</span> : null}
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {post.lastTurnFailed ? (
          <span className="rounded-full bg-destructive/15 px-1.5 py-px text-destructive">
            {t("fleets.turn.failed")}
            {post.consecutiveFailures >= 3 ? ` ×${post.consecutiveFailures}` : ""}
          </span>
        ) : null}
        {post.effectiveModel ? (
          <span
            className={`truncate rounded-full px-1.5 py-px ${post.modelNotice ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted"}`}
            title={post.modelNotice ?? undefined}
          >
            {post.effectiveModel}
          </span>
        ) : null}
        <span className="ml-auto whitespace-nowrap" title={`${t("fleets.evidence.lastRun")} / ${t("fleets.evidence.nextRun")}`}>
          {fmtClock(post.lastRunAt, i18n.language)} · {fmtClock(post.nextRunAt, i18n.language)}
        </span>
      </div>
      <Handle type="target" position={Position.Left} isConnectable={false} {...HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} {...HIDDEN_HANDLE} />
    </div>
  );
}

function SourceNodeView({ data, id }: NodeProps<Node<SourceData>>) {
  return (
    <div
      data-testid={`canvas-node-${id}`}
      className="flex w-[150px] items-center gap-1.5 rounded-lg border border-dashed border-border bg-muted/40 px-2 py-1.5"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_COLORS[data.kind] ?? "#64748b" }} />
      <span className="truncate text-[11px] text-muted-foreground" title={data.label}>
        {data.label}
      </span>
      {data.live ? <span className="ml-auto h-1.5 w-1.5 animate-ping rounded-full bg-blue-500" /> : null}
      <Handle type="target" position={Position.Left} isConnectable={false} {...HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} {...HIDDEN_HANDLE} />
    </div>
  );
}

const nodeTypes = { post: PostNodeView, source: SourceNodeView };

function trafficKeyOf(t: CanvasTraffic): string {
  return `${t.from}→${t.to}:${t.kind}`;
}

export function FleetCanvas({
  members,
  edges,
  traffic,
  liveTurns,
}: {
  members: CanvasPost[];
  edges: GraphEdge[];
  traffic: CanvasTraffic[];
  liveTurns: LiveTurn[];
}) {
  const { t } = useTranslation();

  // Layout signature: only a member/edge change re-lays-out the board (spec:
  // 实时更新不重排). Live turns and traffic flip data in place below.
  const signature = useMemo(
    () => `${members.map((m) => `${m.id}:${m.title}:${m.kind}`).join("|")}#${edges.map((e) => `${e.kind}:${e.from ?? "*"}:${e.to ?? ""}:${(e.targets ?? []).join(",")}`).join("|")}`,
    [members, edges],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature IS the memo key by design — live turns and traffic flip data in place, a member/edge change (and only that) re-lays-out the board (spec: 实时更新不重排)
  const laid = useMemo(() => {
    const graphMembers: GraphMember[] = members.map((m) => ({ id: m.id, title: m.title, targetKind: m.kind }));
    return computeGraph(graphMembers, edges);
  }, [signature]);

  const liveByMember = useMemo(() => {
    const map = new Map<string, LiveTurn>();
    for (const lt of liveTurns) map.set(lt.memberId, lt);
    return map;
  }, [liveTurns]);

  // An edge is in flight when a live turn was ignited along it (parent post →
  // post, by kind). Root turns (no chain) light their node only.
  const liveEdgeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const lt of liveTurns) {
      if (lt.parentMemberId && lt.edgeKind) keys.add(`${lt.parentMemberId}→${lt.memberId}:${lt.edgeKind}`);
    }
    return keys;
  }, [liveTurns]);

  const trafficByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const tr of traffic) map.set(trafficKeyOf(tr), tr.turns);
    return map;
  }, [traffic]);

  const nodes: Node[] = useMemo(
    () =>
      laid.nodes.map((n) => {
        const isPost = members.some((m) => m.id === n.id);
        const live = liveByMember.has(n.id);
        return {
          id: n.id,
          type: isPost ? "post" : "source",
          position: { x: n.x, y: n.y },
          data: isPost
            ? ({ post: members.find((m) => m.id === n.id)!, live } satisfies PostData as PostData)
            : ({ label: n.label, kind: n.kind, live } satisfies SourceData as SourceData),
        };
      }),
    [laid, members, liveByMember],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      laid.links.map((l) => {
        const key = `${l.from}→${l.to}:${l.kind}`;
        const color = KIND_COLORS[l.kind] ?? "#94a3b8";
        const turns = trafficByKey.get(key) ?? 0;
        const live = liveEdgeKeys.has(key);
        return {
          id: key,
          source: l.from,
          target: l.to,
          animated: live,
          style: {
            stroke: color,
            strokeWidth: 1.5 + Math.min(2.5, Math.sqrt(turns) * 0.5),
          },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        };
      }),
    [laid, liveEdgeKeys, trafficByKey],
  );

  const legendKinds = useMemo(() => [...new Set(laid.links.map((l) => l.kind))], [laid]);

  return (
    <div className="mt-1" data-testid="fleet-canvas">
      <div className="mb-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        {legendKinds.map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLORS[k] ?? "#94a3b8" }} />
            {t(`fleets.orch.edge.${k}`)}
          </span>
        ))}
      </div>
      <div className="h-[380px] overflow-hidden rounded-md border border-border">
        <ReactFlow
          nodes={nodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          maxZoom={1.75}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
          colorMode="system"
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => (n.type === "post" ? (STATUS_RING[(n.data as PostData).post?.status] ?? "#64748b") : "#64748b")} />
        </ReactFlow>
      </div>
    </div>
  );
}

export default FleetCanvas;
