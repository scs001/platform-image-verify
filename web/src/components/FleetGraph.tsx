// Fleet orchestration graph (agent-fleet-cockpit, add-cockpit-edge-graph).
//
// The v2 "edge graph first" face: posts as node chips, declared orchestration
// edges as kind-colored directed curves, layered left→right (sources first,
// depth grows along edges; declared cycles drawn as back-curves that do not
// participate in layering). Implicit supervisor grants are NOT drawn — the
// aggregate banner in FleetsPage carries them (vocabulary/UX decision, §十五).
// Zero dependencies: a pure layout function + plain SVG.

export interface GraphMember {
  id: string;
  title: string;
  targetKind: string;
}

export interface GraphEdge {
  kind: string;
  from?: string; // undefined for trigger edges (external cron source)
  to?: string;
  targets?: string[];
  aggregate?: { kind: string; judge?: string };
  cron?: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: string; // persona | cluster | a2a | tool | cron | event
  x: number;
  y: number;
}

export interface GraphLink {
  from: string;
  to: string;
  kind: string;
  label?: string;
}

const NODE_W = 120;
const NODE_H = 40;
const LAYER_X = 210;
const ROW_Y = 78;
const PAD = 24;

// Expand declared edges into (nodes, links). Virtual source nodes: cron:<expr>
// for trigger edges, the event source name for event edges. Fanout expands to
// one link per target (judge rides the label, not a fake link).
function expand(members: GraphMember[], edges: GraphEdge[]) {
  const nodes = new Map<string, GraphNode>();
  for (const m of members) nodes.set(m.id, { id: m.id, label: m.title, kind: m.targetKind, x: 0, y: 0 });
  const links: GraphLink[] = [];
  for (const e of edges) {
    if (e.kind === "trigger" && e.to) {
      const srcId = `cron:${e.cron ?? "定时"}`;
      if (!nodes.has(srcId)) nodes.set(srcId, { id: srcId, label: e.cron ?? "定时", kind: "cron", x: 0, y: 0 });
      links.push({ from: srcId, to: e.to, kind: "trigger" });
    } else if (e.kind === "event" && e.to) {
      const srcId = e.from ?? "event:?";
      if (!nodes.has(srcId)) nodes.set(srcId, { id: srcId, label: e.from ?? "事件源", kind: "event", x: 0, y: 0 });
      links.push({ from: srcId, to: e.to, kind: "event" });
    } else if (e.kind === "fanout" && e.from) {
      const judge = e.aggregate?.kind === "judge" && e.aggregate.judge ? ` · 裁决:${e.aggregate.judge}` : "";
      for (const t of e.targets ?? []) {
        links.push({ from: e.from, to: t, kind: "fanout", label: `扇出${judge}` });
      }
    } else if (e.from && e.to) {
      links.push({ from: e.from, to: e.to, kind: e.kind });
    }
  }
  return { nodes, links };
}

// Longest-path layering over the DAG of links; links into an already-layered
// ancestor (declared cycles) are back-edges — they draw, but never re-layer.
function layer(nodes: Map<string, GraphNode>, links: GraphLink[]) {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const l of links) {
    if (!incoming.has(l.to)) incoming.set(l.to, []);
    incoming.get(l.to)!.push(l.from);
  }
  const memo = new Map<string, number>();
  const back = new Set<string>(); // "from→to" keys ignored during layering
  const depthOf = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) { back.add(id); return -1; } // cycle guard: treat as unreachable
    seen.add(id);
    let d = 0;
    for (const p of incoming.get(id) ?? []) {
      const pd = depthOf(p, seen);
      if (pd >= 0 && !back.has(p + "→" + id) && !(back.has(p) && pd === -1)) d = Math.max(d, pd + 1);
    }
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const id of nodes.keys()) depthOf(id, new Set());
  for (const [id, d] of memo) depth.set(id, d);
  return { depth, back };
}

export function computeGraph(members: GraphMember[], edges: GraphEdge[]) {
  const { nodes, links } = expand(members, edges);
  const { depth } = layer(nodes, links);
  // Position: x by layer, y stable by title within a layer.
  const byLayer = new Map<number, string[]>();
  for (const id of nodes.keys()) {
    const d = depth.get(id) ?? 0;
    if (!byLayer.has(d)) byLayer.set(d, []);
    byLayer.get(d)!.push(id);
  }
  for (const [d, ids] of byLayer) {
    ids.sort((a, b) => (nodes.get(a)!.label.localeCompare(nodes.get(b)!.label)));
    ids.forEach((id, i) => {
      const n = nodes.get(id)!;
      n.x = PAD + d * LAYER_X;
      n.y = PAD + i * ROW_Y;
    });
  }
  const maxLayer = Math.max(0, ...byLayer.keys());
  const maxRows = Math.max(1, ...[...byLayer.values()].map((v) => v.length));
  const size = {
    width: PAD * 2 + maxLayer * LAYER_X + NODE_W,
    height: PAD * 2 + (maxRows - 1) * ROW_Y + NODE_H,
  };
  return { nodes: [...nodes.values()], links, size };
}

// Kind colors — mirrored from the badge palette in FleetsPage (single source
// would be nicer; these are SVG fills, the badges are tailwind classes).
export const KIND_COLORS: Record<string, string> = {
  trigger: "#6b7280",
  report: "#22c55e",
  dispatch: "#3b82f6",
  handoff: "#f59e0b",
  fanout: "#a855f7",
  event: "#06b6d4",
};
export const NODE_COLORS: Record<string, string> = {
  persona: "#334155",
  cluster: "#0ea5e9",
  a2a: "#8b5cf6",
  tool: "#64748b",
  cron: "#6b7280",
  event: "#06b6d4",
};

export function FleetGraph({
  members,
  edges,
  kindLabels,
  emptyLabel,
}: {
  members: GraphMember[];
  edges: GraphEdge[];
  kindLabels: Record<string, string>;
  emptyLabel: string;
}) {
  const drawn = edges.filter((e) => !(e.kind === "dispatch" && (e as GraphEdge & { implicit?: boolean }).implicit));
  if (!drawn.length) return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  const { nodes, links, size } = computeGraph(members, drawn);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kinds = [...new Set(links.map((l) => l.kind))];

  return (
    <div className="mt-1 overflow-x-auto" data-testid="fleet-graph">
      <div className="mb-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        {kinds.map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLORS[k] ?? "#94a3b8" }} />
            {kindLabels[k] ?? k}
          </span>
        ))}
      </div>
      <svg width={size.width} height={size.height} role="img" style={{ minWidth: "100%" }}>
        <defs>
          {Object.entries(KIND_COLORS).map(([k, c]) => (
            <marker key={k} id={`fg-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill={c} />
            </marker>
          ))}
        </defs>
        {links.map((l) => {
          const a = byId.get(l.from);
          const b = byId.get(l.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          const color = KIND_COLORS[l.kind] ?? "#94a3b8";
          const back = b.x <= a.x;
          const d = back
            ? `M${x1},${y1} C${x1 + 60},${y1} ${x2 + NODE_W + 60},${y2} ${x2 + NODE_W},${y2 + 6}`
            : `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
          return (
            <path
              key={`${l.from}-${l.to}-${l.kind}`}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={1.6}
              markerEnd={`url(#fg-arrow-${l.kind in KIND_COLORS ? l.kind : "trigger"})`}
            >
              <title>{`${l.label ?? kindLabels[l.kind] ?? l.kind}: ${a.label} → ${b.label}`}</title>
            </path>
          );
        })}
        {nodes.map((n) => {
          const c = NODE_COLORS[n.kind] ?? "#475569";
          const label = n.label.length > 8 ? n.label.slice(0, 7) + "…" : n.label;
          return (
            <g key={n.id}>
              <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={8} fill="var(--color-card, #fff)" stroke={c} strokeWidth={1.5} />
              <circle cx={n.x + 12} cy={n.y + NODE_H / 2} r={3.5} fill={c} />
              <text x={n.x + 22} y={n.y + NODE_H / 2 + 4} fontSize={11} fill="currentColor">
                {label}
              </text>
              <title>{`${n.label} (${n.kind})`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
