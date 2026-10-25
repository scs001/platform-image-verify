// FleetsPage.tsx — agent fleet management surface (spec: agent-fleet-core).
//
// Fleet list + org-tree of post cards + the composer (编队器) + lifecycle
// actions (restaff/pause/resume/archive/dissolve). All state is server-owned:
// reads hit /api/fleets, every write re-reads the detail (the response's
// derived statuses are computed server-side and never cached here). Post
// status badges (on_duty/missing/vacant/passive/paused) carry their evidence
// in the title attribute — "why is this post missing" is one hover away.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useCronStore } from "@platform/core";
import { useFleetStore } from "@/store/fleet-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// ── shapes (mirror server/routes/fleets.js memberView) ─────────────────────

interface KpiSlot {
  key: string;
  label: string;
  unit?: string;
  showDelta?: boolean;
  target?: number;
}

interface Cadence {
  cron: string;
  tz: string | null;
  promptTemplate: string;
  enabled: boolean;
}

interface LatestSlot {
  key: string;
  label: string;
  unit: string | null;
  value: string | number;
  note: string | null;
  trend: { direction: "up" | "down" | "flat" | "changed"; deltaValue: number | null } | null;
}

interface LatestReport {
  id: string;
  at: number;
  summary: string;
  source: "self" | "derived";
  sessionId: string | null;
  slots: LatestSlot[];
  undeclaredKeys: string[];
  blockers: string[];
}

interface ReportEntry {
  id: string;
  at: number;
  summary: string;
  metrics: Record<string, { value: string | number; delta?: string }>;
  blockers: string[];
  resources: { name: string; kind: string; url?: string }[];
  source: "self" | "derived";
  sessionId: string | null;
}

interface MemberView {
  id: string;
  fleetId: string;
  title: string;
  parentId: string | null;
  target: { kind: "persona" | "cluster" | "a2a"; id: string; label: string };
  kpiSlots: KpiSlot[];
  cadence: Cadence | null;
  // Post model (add-fleet-post-model): declared values plus the advisory
  // effective model (what the next turn would run on) and, when a declared
  // hop already fell out of the roster, the notice naming it.
  model: string | null;
  fallbackModel: string | null;
  effectiveModel: string | null;
  modelNotice: string | null;
  status: "on_duty" | "paused" | "missing" | "vacant" | "passive";
  statusReason: string;
  evidence: {
    lastRunAt: string | null;
    nextRunAt: string | null;
    staleWindowMs: number | null;
    latestReportAt: number | null;
    hitWindow: string | null;
  };
  latestReport: LatestReport | null;
  reportTimeline: ReportEntry[];
  // Turn outcome (add-fleet-turn-events): a second dimension next to the
  // presence status — the last finished turn's facts, never merged into it.
  lastTurn: {
    status: "ok" | "failed" | "interrupted";
    errorKind: string | null;
    error: string | null;
    endedAt: number;
    sessionId: string | null;
  } | null;
  consecutiveFailures: number;
}

interface FleetRow {
  id: string;
  name: string;
  state: "active" | "paused" | "archived";
  memberCount?: number;
  statusCounts?: Record<string, number>;
  openDecisions?: number;
}

interface FleetDetail {
  fleet: FleetRow & { ownerEmail?: string; createdAt?: number; sourceTemplate?: { packId: string; version: string | null } | null };
  members: MemberView[];
  statusCounts: Record<string, number>;
  openDecisions?: number;
  // Cockpit aggregate (agent-fleet-templates): the rest of the one-round-trip.
  decisions?: DecisionItem[];
  stream?: { memberId: string; title: string; status: MemberView["status"]; latestReport: LatestReport | null }[];
  health?: { onDuty: number; paused: number; missing: number; vacant: number; passive: number; failing?: number; total: number };
  // Orchestration read view (agent-fleet-orchestration): mode/constraints +
  // the read-time edge set (supervisor's implicit edges are marked).
  orchestration?: {
    mode: string | null;
    constraints: { maxChainDepth?: number; spanMax?: number; budgetPerEdgeMin?: number } | null;
    edges: Array<{
      kind: string;
      from?: string;
      to?: string;
      targets?: string[];
      aggregate?: { kind: string; judge?: string };
      rounds?: number;
      cron?: string;
      implicit?: boolean;
    }>;
    implicitDispatch?: string | null;
  } | null;
  // Edge traffic (agent-fleet-runs): hops in the last 24h grouped by
  // (from, to, kind) — the canvas weighs edges by it.
  edgeTraffic?: { from: string; to: string; kind: string; turns: number; ok: number; failed: number }[];
  template?: { packId: string; instantiatedVersion: string | null; latestVersion: string; updateAvailable: boolean } | null;
}

// The live canvas rides its own lazy chunk (@xyflow/react is canvas-only).
const FleetCanvas = lazy(() => import("@/components/fleet/FleetCanvas"));
// The run timeline (face 2) rides its own chunk too (trace join + waterfall).
const RunTimeline = lazy(() => import("@/components/fleet/RunTimeline"));
// The inspector drawer (face 3) — member tabs + edge inspector.
const MemberInspector = lazy(() => import("@/components/fleet/InspectorDrawer").then((m) => ({ default: m.MemberInspector })));
const EdgeInspector = lazy(() => import("@/components/fleet/InspectorDrawer").then((m) => ({ default: m.EdgeInspector })));

interface DecisionItem {
  id: string;
  fleetId: string;
  memberId: string;
  memberTitle: string | null;
  memberDeleted: boolean;
  pendingDelivery: boolean;
  question: string;
  options: { value: string; label: string }[];
  severity: "low" | "normal" | "high";
  suggestedDeadline: string | null;
  recommendation: string | null;
  state: "open" | "approved" | "rejected" | "expired" | "delivered";
  resolution: { kind: string; choice: string | null; note: string | null; by: string | null; at: number | null } | null;
  sourceSessionId: string | null;
  submittedAt: number;
  resolvedAt: number | null;
  deliveredAt: number | null;
}

interface CatalogTarget {
  id: string;
  name: string;
  kind: "persona" | "cluster" | "a2a";
}

const STATUS_STYLES: Record<MemberView["status"], string> = {
  on_duty: "bg-success/15 text-success",
  paused: "bg-muted text-muted-foreground",
  missing: "bg-warning/15 text-warning",
  vacant: "bg-destructive/15 text-destructive",
  passive: "bg-muted text-muted-foreground",
};

const STATE_STYLES: Record<FleetRow["state"], string> = {
  active: "bg-success/15 text-success",
  paused: "bg-warning/15 text-warning",
  archived: "bg-muted text-muted-foreground",
};

// Orchestration edge badges (agent-fleet-orchestration): six kinds, one tone
// each — read-only semantics, no interaction.
const EDGE_STYLES: Record<string, string> = {
  trigger: "bg-muted text-muted-foreground",
  report: "bg-success/15 text-success",
  dispatch: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  handoff: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  fanout: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  event: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
};

function memberById(members: MemberView[], id?: string): MemberView | undefined {
  return id ? members.find((m) => m.id === id) : undefined;
}

function fmtTime(v: string | null, locale: string): string {
  if (!v) return "—";
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Human-readable cadence for a card line (nobody reads raw cron comfortably).
function cadenceText(t: (k: string, opts?: Record<string, unknown>) => string, cadence: Cadence): string {
  const m = cadence.cron.match(/^(\d+) (\d+) \* \* \*$/);
  if (m) return t("fleets.cadence.daily", { hour: m[2], minute: m[1] });
  const h = cadence.cron.match(/^(\d+) \* \* \* \*$/);
  if (h) return t("fleets.cadence.hourly", { minute: h[1] });
  return cadence.cron;
}

export function FleetsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [fleets, setFleets] = useState<FleetRow[]>([]);
  const [detail, setDetail] = useState<FleetDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [composerFor, setComposerFor] = useState<string | null>(null); // fleet id
  const [swapFor, setSwapFor] = useState<MemberView | null>(null);
  const [drawerFor, setDrawerFor] = useState<MemberView | null>(null);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  // Inspector drawer (v2 face 3): the one place for a post's detail + actions.
  const [inspectorFor, setInspectorFor] = useState<MemberView | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"overview" | "config" | "turns" | "reports" | "decisions">("overview");
  const [edgeInspectorFor, setEdgeInspectorFor] = useState<{ kind: string; from?: string; to?: string; targets?: string[]; aggregate?: { kind: string; judge?: string }; cron?: string; rounds?: number } | null>(null);
  // Design mode (v2 face 4): draft edges ride the architect dry-run lane —
  // nothing lands before an explicit confirm on a passing draft.
  const [design, setDesign] = useState(false);
  const [newEdgeKind, setNewEdgeKind] = useState("handoff");
  const [draftEdges, setDraftEdges] = useState<{ kind: string; from: string; to: string }[]>([]);
  const [removedEdgeKeys, setRemovedEdgeKeys] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState<{ ok: boolean; errors?: { error: string }[]; warnings?: { warning: string }[]; diff?: unknown[] } | null>(null);
  const [applying, setApplying] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const navigate = useNavigate();

  const loadList = useCallback(async () => {
    try {
      const r = await fetch("/api/fleets");
      if (!r.ok) throw new Error(`list ${r.status}`);
      const body = await r.json();
      setFleets(body.fleets ?? []);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  // The cockpit aggregate (agent-fleet-templates): one round-trip carrying
  // the tree + slots + statuses + decisions + daily stream + health + template
  // notice — the field contracts are the previous knives' read faces verbatim.
  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/fleets/${encodeURIComponent(id)}/cockpit`);
      if (!r.ok) throw new Error(`cockpit ${r.status}`);
      setDetail(await r.json());
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  // Deep link /:fleetId selects the fleet (the cockpit is THE fleet page, D6).
  const { fleetId: routeFleetId } = useParams();
  useEffect(() => {
    if (routeFleetId && routeFleetId !== selectedId) setSelectedId(routeFleetId);
  }, [routeFleetId, selectedId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // Live refresh over the EXISTING WS lane: the cron store updates on every
  // cron_status/cron_completed broadcast (a fleet fire re-broadcasts its task)
  // — watching it refreshes the cockpit without any new polling loop.
  const cronJobsVersion = useCronStore((st) => st.jobs.map((j) => `${j.id}:${j.state ?? ""}:${j.paused ? 1 : 0}`).join("|"));
  // cronJobsVersion is the intentional refresh TRIGGER (any task broadcast
  // re-reads the cockpit), not a value this effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional external refresh signal
  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [cronJobsVersion, selectedId, loadDetail]);

  // Fleet run events (agent-fleet-runs): every fleet_turn_* bumps the live
  // store's version. The refetch is THROTTLED (≥2s) — a busy fleet fires many
  // turns a minute and the canvas already lit the node from the event itself;
  // this re-read only reconciles the durable facts (status, KPIs, health).
  const fleetEventsVersion = useFleetStore((st) => st.version);
  const lastFleetFetchRef = useRef(0);
  useEffect(() => {
    if (!selectedId || fleetEventsVersion === 0) return;
    const wait = 2000 - (Date.now() - lastFleetFetchRef.current);
    if (wait <= 0) {
      lastFleetFetchRef.current = Date.now();
      void loadDetail(selectedId);
      return;
    }
    const timer = setTimeout(() => {
      lastFleetFetchRef.current = Date.now();
      void loadDetail(selectedId);
    }, wait);
    return () => clearTimeout(timer);
  }, [fleetEventsVersion, selectedId, loadDetail]);

  // In-flight turns of THIS fleet, for the canvas pulse/edge animation.
  // While a replay cursor is held, the timeline's synthesized replayTurns
  // take over instead (回放 = 换时钟, D7).
  const liveTurnsAll = useFleetStore((st) => st.liveTurns);
  const replayAt = useFleetStore((st) => st.replayAt);
  const replayTurns = useFleetStore((st) => st.replayTurns);
  const liveTurns = useMemo(() => {
    if (replayAt != null) return replayTurns.filter((lt) => lt.fleetId === detail?.fleet.id);
    return detail ? Object.values(liveTurnsAll).filter((lt) => lt.fleetId === detail.fleet.id) : [];
  }, [liveTurnsAll, replayAt, replayTurns, detail]);
  const memberTitles = useMemo(
    () => new Map((detail?.members ?? []).map((m) => [m.id, m.title])),
    [detail],
  );

  // ── design mode (v2 face 4): draft → dry-run → confirm → apply ────────────

  const hasDraftOps = draftEdges.length > 0 || removedEdgeKeys.length > 0;

  // The terminal orchestration a confirmation would land: the declared section
  // with the draft's removals applied and additions appended (first edge on an
  // undeclared fleet starts a pipeline section).
  const terminalOrchestration = useMemo(() => {
    if (!detail || !hasDraftOps) return null;
    const raw = (detail.fleet as { orchestration?: { mode?: string; constraints?: Record<string, number>; edges?: { kind: string; from?: string; to?: string; targets?: string[]; aggregate?: { kind: string; judge?: string }; cron?: string; rounds?: number }[] } | null }).orchestration ?? null;
    const kept = (raw?.edges ?? []).filter((e) => {
      if (e.kind === "fanout") return !(e.targets ?? []).every((t) => removedEdgeKeys.includes(`${e.from}→${t}:fanout`));
      return !removedEdgeKeys.includes(`${e.from ?? ""}→${e.to ?? ""}:${e.kind}`);
    });
    return {
      mode: raw?.mode ?? "pipeline",
      constraints: raw?.constraints,
      edges: [...kept, ...draftEdges],
    };
  }, [detail, draftEdges, removedEdgeKeys, hasDraftOps]);

  // Dry-run whenever the draft changes (the same validator the architect NL
  // lane rides — two doors, one judgment).
  useEffect(() => {
    if (!selectedId || !design || !hasDraftOps || !terminalOrchestration) {
      setDryRun(null);
      return;
    }
    let alive = true;
    fetch(`/api/fleets/${encodeURIComponent(selectedId)}/orchestration/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fleet: { orchestration: terminalOrchestration } }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (alive) setDryRun(r.ok ? body : { ok: false, errors: [{ error: body.error ?? `draft ${r.status}` }] });
      })
      .catch((e) => alive && setDryRun({ ok: false, errors: [{ error: String(e?.message ?? e) }] }));
    return () => {
      alive = false;
    };
  }, [selectedId, design, hasDraftOps, terminalOrchestration]);

  const addDraftEdge = (from: string, to: string) => {
    setDraftEdges((prev) =>
      prev.some((e) => e.from === from && e.to === to && e.kind === newEdgeKind) ? prev : [...prev, { kind: newEdgeKind, from, to }],
    );
  };
  const removeDraftEdge = (from: string, to: string, kind: string) =>
    setDraftEdges((prev) => prev.filter((e) => !(e.from === from && e.to === to && e.kind === kind)));

  const confirmDesign = async () => {
    if (!selectedId || !terminalOrchestration || !dryRun?.ok) return;
    setApplying(true);
    setDesignError(null);
    try {
      const r = await fetch(`/api/fleets/${encodeURIComponent(selectedId)}/orchestration/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fleet: { orchestration: terminalOrchestration } }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.ok === false) {
        setDesignError(body.errors?.map((e: { error: string }) => e.error).join("; ") ?? body.error ?? `apply ${r.status}`);
        return;
      }
      setDraftEdges([]);
      setRemovedEdgeKeys([]);
      setDesign(false);
      await refresh();
    } finally {
      setApplying(false);
    }
  };

  const exitDesign = () => {
    setDesign(false);
    setDraftEdges([]);
    setRemovedEdgeKeys([]);
    setDryRun(null);
    setDesignError(null);
  };

  const inspectorDecision = async (
    item: { id: string },
    op: "approve" | "reject",
    choice?: string,
  ) => {
    if (!selectedId) return;
    const r = await fetch(`/api/fleets/${encodeURIComponent(selectedId)}/decisions/${encodeURIComponent(item.id)}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(choice !== undefined ? { body: JSON.stringify({ choice }) } : {}),
    });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `${op} ${r.status}`);
    await refresh();
  };

  const openInspector = (member: MemberView, tab: typeof inspectorTab = "overview") => {
    setInspectorTab(tab);
    setInspectorFor(member);
  };

  // Autofollow the first fleet when the list arrives and nothing is selected.
  useEffect(() => {
    const first = fleets[0];
    if (!selectedId && first) setSelectedId(first.id);
  }, [fleets, selectedId]);

  const refresh = useCallback(async () => {
    await loadList();
    if (selectedId) await loadDetail(selectedId);
  }, [loadList, loadDetail, selectedId]);

  // ── fleet-level ops ───────────────────────────────────────────────────────

  const patchFleet = async (id: string, body: Record<string, unknown>) => {
    const r = await fetch(`/api/fleets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `patch ${r.status}`);
    await refresh();
  };

  const dissolveFleet = async (id: string) => {
    if (!window.confirm(t("fleets.ops.confirmDissolve"))) return;
    const r = await fetch(`/api/fleets/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `delete ${r.status}`);
    setSelectedId(null);
    setDetail(null);
    await loadList();
  };

  const memberAction = async (path: string, method: "POST" | "DELETE" | "PATCH", body?: Record<string, unknown>) => {
    const r = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `${method} ${r.status}`);
    await refresh();
    return r.ok;
  };

  // Org tree: members as a forest, children under parents, stable order.
  const tree = useMemo(() => {
    if (!detail) return [] as { member: MemberView; depth: number }[];
    const byParent = new Map<string | null, MemberView[]>();
    for (const m of detail.members) {
      const list = byParent.get(m.parentId) ?? [];
      list.push(m);
      byParent.set(m.parentId, list);
    }
    const out: { member: MemberView; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const m of byParent.get(parent) ?? []) {
        out.push({ member: m, depth });
        walk(m.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [detail]);

  const selected = fleets.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="flex h-full flex-col" data-testid="fleets-page">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold">{t("fleets.title")}</h1>
        <Button variant="outline" size="sm" data-testid="fleet-create" onClick={() => setCreateOpen(true)}>
          {t("fleets.create")}
        </Button>
      </div>
      {error ? (
        <p className="px-4 py-2 text-sm text-destructive" data-testid="fleets-error">
          {error}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {/* fleet list */}
        <div className="w-64 shrink-0 overflow-y-auto border-r border-border p-3" data-testid="fleet-list">
          {fleets.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">{t("fleets.empty")}</p>
          ) : (
            fleets.map((f) => (
              <button
                key={f.id}
                type="button"
                data-testid={`fleet-card-${f.id}`}
                onClick={() => setSelectedId(f.id)}
                className={`mb-2 w-full rounded-md border p-3 text-left ${
                  f.id === selectedId ? "border-primary bg-primary/5" : "border-border hover:bg-muted"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLES[f.state]}`}>
                    {t(`fleets.state.${f.state}`)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {t("fleets.membersCount", { count: f.memberCount ?? 0 })}
                </span>
              </button>
            ))
          )}
        </div>

        {/* detail */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4" data-testid="fleet-detail">
          {!detail || !selected ? (
            <p className="text-sm text-muted-foreground">{t("fleets.detail.empty")}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">{detail.fleet.name}</h2>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLES[detail.fleet.state]}`}>
                    {t(`fleets.state.${detail.fleet.state}`)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={detail.openDecisions ? "default" : "outline"}
                    size="sm"
                    data-testid="decisions-open"
                    onClick={() => setDecisionsOpen(true)}
                  >
                    {detail.openDecisions
                      ? t("fleets.decisions.waitingBadge", { count: detail.openDecisions })
                      : t("fleets.decisions.queueEmpty")}
                  </Button>
                  {detail.fleet.state === "active" ? (
                    <Button variant="outline" size="sm" onClick={() => patchFleet(selected.id, { state: "paused" })}>
                      {t("fleets.ops.pause")}
                    </Button>
                  ) : detail.fleet.state === "paused" ? (
                    <Button variant="outline" size="sm" onClick={() => patchFleet(selected.id, { state: "active" })}>
                      {t("fleets.ops.resume")}
                    </Button>
                  ) : null}
                  {detail.fleet.state !== "archived" ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="member-create"
                        onClick={() => setComposerFor(selected.id)}
                      >
                        {t("fleets.addMember")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (window.confirm(t("fleets.ops.confirmArchive"))) void patchFleet(selected.id, { state: "archived" });
                        }}
                      >
                        {t("fleets.ops.archive")}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => dissolveFleet(selected.id)}>
                        {t("fleets.ops.dissolve")}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Template birth banner: all-paused fleet from a template awaits
                  the owner's explicit start (install never auto-runs, D3). */}
              {detail.fleet.state === "paused" && detail.fleet.sourceTemplate ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/10 p-3" data-testid="fleet-await-start">
                  <span className="text-sm">{t("fleets.tpl.awaitStart")}</span>
                  <Button size="sm" data-testid="fleet-start" onClick={() => void memberAction(`/api/fleets/${selected.id}/start`, "POST")}>
                    {t("fleets.tpl.start")}
                  </Button>
                </div>
              ) : null}
              {detail.template?.updateAvailable ? (
                <p className="mt-2 text-xs text-warning" data-testid="fleet-template-newer">
                  {t("fleets.tpl.newer", { v: detail.template.latestVersion })}
                </p>
              ) : null}

              {/* Decision banner: the queue's top items inline (severity first),
                  one click from 刀3's operations in the drawer. */}
              {detail.decisions && detail.decisions.length > 0 ? (
                <button
                  type="button"
                  className="mt-3 flex w-full flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-left"
                  data-testid="fleet-decision-banner"
                  onClick={() => {
                    // 直达批复 (v2): the banner opens the top item's post on the
                    // inspector's 审批 tab; the fleet-wide queue drawer stays one
                    // click deeper for the multi-post view.
                    const top = detail.decisions?.[0];
                    const member = top ? detail.members.find((m) => m.id === top.memberId) : null;
                    if (member) openInspector(member, "decisions");
                    else setDecisionsOpen(true);
                  }}
                >
                  <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
                    {t("fleets.decisions.waitingBadge", { count: detail.openDecisions ?? detail.decisions.length })}
                  </span>
                  {detail.decisions.slice(0, 2).map((d) => (
                    <span key={d.id} className="truncate text-xs text-muted-foreground">
                      [{d.severity}] {d.question}
                    </span>
                  ))}
                </button>
              ) : null}

              {/* Health chips. */}
              {detail.health ? (
                <div className="mt-3 flex flex-wrap gap-2 text-xs" data-testid="fleet-health">
                  <span title={t("fleets.hints.on_duty")} className="rounded-full bg-success/15 px-2 py-0.5 text-success">{t("fleets.health.onDuty")}: {detail.health.onDuty}</span>
                  <span title={t("fleets.hints.paused")} className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{t("fleets.health.paused")}: {detail.health.paused}</span>
                  <span title={t("fleets.hints.missing")} className="rounded-full bg-warning/15 px-2 py-0.5 text-warning">{t("fleets.health.missing")}: {detail.health.missing}</span>
                  <span title={t("fleets.hints.vacant")} className="rounded-full bg-destructive/15 px-2 py-0.5 text-destructive">{t("fleets.health.vacant")}: {detail.health.vacant}</span>
                  <span title={t("fleets.hints.passive")} className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{t("fleets.health.passive")}: {detail.health.passive}</span>
                  {detail.health.failing ? (
                    <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-destructive" data-testid="fleet-health-failing">
                      {t("fleets.health.failing")}: {detail.health.failing}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {/* Terminology card (vocabulary policy): old term → current
                  term, bridging users who learned the original words. */}
              <details className="mt-3">
                <summary className="cursor-pointer select-none text-xs text-muted-foreground">
                  {t("fleets.terms.title")} · {t("fleets.terms.intro")}
                </summary>
                <div className="mt-2 grid grid-cols-[auto_auto_auto] items-center gap-x-3 gap-y-1 text-xs">
                  {(t("fleets.terms.rows", { returnObjects: true }) as Array<[string, string]>).map(([from, to]) => (
                    <span key={`${from}-${to}`} className="contents">
                      <span className="text-muted-foreground line-through decoration-muted">{from}</span>
                      <span className="text-muted-foreground">→</span>
                      <span>{to}</span>
                    </span>
                  ))}
                </div>
              </details>

              {/* Orchestration panel (agent-fleet-orchestration): the declared
                  edges as a read-only list — the owner SEES the shape they
                  declared. Undeclared fleets render nothing. */}
              {detail.orchestration && detail.orchestration.edges.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-border bg-card p-3 text-xs" data-testid="fleet-orchestration">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t("fleets.orch.title")}</span>
                    {detail.orchestration.mode ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {t(`fleets.orch.mode.${detail.orchestration.mode}`)}
                      </span>
                    ) : null}
                    {detail.orchestration.constraints?.maxChainDepth ? (
                      <span className="text-muted-foreground">
                        {t("fleets.orch.chainDepth")}: {detail.orchestration.constraints.maxChainDepth}
                      </span>
                    ) : null}
                    {detail.orchestration.constraints?.budgetPerEdgeMin ? (
                      <span className="text-muted-foreground">
                        {t("fleets.orch.budget")}: {detail.orchestration.constraints.budgetPerEdgeMin}min
                      </span>
                    ) : null}
                  </div>
                  {(() => {
                    const implicitDispatch = detail.orchestration!.edges.filter((e) => e.kind === "dispatch" && e.implicit);
                    const visible = detail.orchestration!.edges.filter((e) => !(e.kind === "dispatch" && e.implicit));
                    return (
                      <>
                      {implicitDispatch.length > 0 ? (
                        <div className="flex items-center gap-2">
                          <span className="rounded-full px-2 py-0.5 bg-blue-500/15 text-blue-600 dark:text-blue-400">{t("fleets.orch.edge.dispatch")}</span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {t("fleets.orch.implicitAll", { pairs: implicitDispatch.length })}
                          </span>
                        </div>
                      ) : null}
                      {/* Design mode (v2 face 4): draft edges ride the architect
                          dry-run lane — toggle on, drag a connection (kind
                          picked below), the draft lands only on explicit
                          confirm of a passing dry-run; exit discards. */}
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs" data-testid="design-panel">
                        {design ? (
                          <>
                            <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-blue-600 dark:text-blue-400">{t("fleets.design.on")}</span>
                            <select
                              aria-label={t("fleets.design.edgeKind")}
                              className="rounded-md border border-border bg-card px-2 py-1"
                              value={newEdgeKind}
                              onChange={(e) => setNewEdgeKind(e.target.value)}
                              data-testid="design-kind"
                            >
                              {["handoff", "dispatch", "report"].map((k) => (
                                <option key={k} value={k}>
                                  {t(`fleets.orch.edge.${k}`)}
                                </option>
                              ))}
                            </select>
                            {removedEdgeKeys.length > 0 ? (
                              <span className="text-muted-foreground">
                                {t("fleets.design.removed", { n: removedEdgeKeys.length })}
                              </span>
                            ) : null}
                            {dryRun && !dryRun.ok ? (
                              <span className="text-destructive" data-testid="design-errors">
                                {(dryRun.errors ?? []).map((e) => e.error).join("; ")}
                              </span>
                            ) : null}
                            {designError ? <span className="text-destructive">{designError}</span> : null}
                            <Button
                              size="sm"
                              className="ml-auto"
                              disabled={!hasDraftOps || !dryRun?.ok || applying}
                              onClick={() => void confirmDesign()}
                              data-testid="design-confirm"
                            >
                              {t("fleets.design.confirm")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={exitDesign} data-testid="design-exit">
                              {t("fleets.design.exit")}
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-auto"
                            onClick={() => setDesign(true)}
                            data-testid="design-toggle"
                          >
                            {t("fleets.design.enter")}
                          </Button>
                        )}
                      </div>
                      {/* The live canvas (agent-fleet-cockpit v2): posts as
                          cards, declared edges as kind-colored curves, cron /
                          signal sources as dashed virtual nodes; in-flight
                          turns pulse their node and animate the igniting
                          edge; edge weight rides the 24h traffic. */}
                      <Suspense
                        fallback={
                          <p className="py-8 text-center text-xs text-muted-foreground" data-testid="fleet-canvas-loading">
                            {t("fleets.canvas.loading")}
                          </p>
                        }
                      >
                        <FleetCanvas
                          fleetId={detail.fleet.id}
                          members={detail.members.map((m) => ({
                            id: m.id,
                            title: m.title,
                            kind: m.target.kind,
                            status: m.status,
                            statusReason: m.statusReason,
                            slots: (m.latestReport?.slots ?? []).map((s) => ({
                              key: s.key,
                              label: s.label,
                              value: s.value,
                              unit: s.unit,
                              trend: s.trend ?? null,
                            })),
                            lastRunAt: m.evidence.lastRunAt,
                            nextRunAt: m.evidence.nextRunAt,
                            cadenceEnabled: m.cadence?.enabled ?? false,
                            effectiveModel: m.target.kind === "persona" ? m.effectiveModel : null,
                            modelNotice: m.modelNotice,
                            lastTurnFailed: m.lastTurn ? m.lastTurn.status !== "ok" : false,
                            consecutiveFailures: m.consecutiveFailures,
                          }))}
                          edges={detail.orchestration!.edges.filter((e) => !(e.kind === "dispatch" && e.implicit))}
                          traffic={detail.edgeTraffic ?? []}
                          liveTurns={liveTurns}
                          designMode={design}
                          draftEdges={draftEdges}
                          removedEdgeKeys={removedEdgeKeys}
                          onConnectEdge={addDraftEdge}
                          onDraftEdgeRemove={removeDraftEdge}
                          onEdgeSelect={(e) => setEdgeInspectorFor(e)}
                          onNodeSelect={(id) => {
                            const m = detail.members.find((x) => x.id === id);
                            if (m) openInspector(m);
                          }}
                        />
                      </Suspense>
                      {visible.map((e) => {
                    const name = (id?: string) => memberById(detail.members, id)?.title ?? id ?? "?";
                    const badge = EDGE_STYLES[e.kind] ?? "bg-muted text-muted-foreground";
                    let desc = "";
                    if (e.kind === "trigger") desc = `${e.cron ?? t("fleets.orch.cron")} → ${name(e.to)}`;
                    else if (e.kind === "report") desc = `${name(e.from)} ↑ ${t("fleets.orch.phrase.report")}`;
                    else if (e.kind === "dispatch") desc = `${name(e.from)} → ${name(e.to)} · ${t("fleets.orch.phrase.dispatch")}`;
                    else if (e.kind === "handoff") desc = `${name(e.from)} → ${name(e.to)} · ${t("fleets.orch.phrase.handoff")}`;
                    else if (e.kind === "fanout")
                      desc = `${name(e.from)} ⇒ ${(e.targets ?? []).map(name).join(", ")} · ${
                        e.aggregate?.kind === "judge"
                          ? `${t("fleets.orch.phrase.judge")}: ${name(e.aggregate.judge)}`
                          : `${t("fleets.orch.phrase.aggregate")}: ${e.aggregate?.kind ?? "all"}`
                      }`;
                    else if (e.kind === "event") desc = `${e.from ?? "?"} → ${name(e.to)} · ${t("fleets.orch.phrase.event")}`;
                    return (
                      <div key={`${e.kind}-${e.from ?? "*"}-${e.to}`} className="flex items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 ${badge}`}>{t(`fleets.orch.edge.${e.kind}`)}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{desc}</span>
                        {e.implicit ? (
                          <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                            {t("fleets.orch.implicit")}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                      </>
                    );
                  })()}
                </div>
              ) : null}

              {/* Run timeline (agent-fleet-cockpit v2 face 2): the execution
                  instance ledger — run list, waterfall replay, cursor-driven
                  canvas playback. Present for every fleet (empty state is the
                  honest "nothing has run yet"). */}
              <Suspense
                fallback={
                  <p className="py-4 text-center text-xs text-muted-foreground" data-testid="fleet-runs-loading">
                    {t("fleets.runs.loading")}
                  </p>
                }
              >
                <RunTimeline fleetId={detail.fleet.id} memberTitles={memberTitles} />
              </Suspense>

              <details className="mt-4" open>
                <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
                  {t("fleets.tree.structure")}
                </summary>
              <div className="mt-2 flex flex-col gap-2" data-testid="fleets-tree">
                {tree.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("fleets.tree.empty")}</p>
                ) : (
                  tree.map(({ member, depth }) => (
                    <div
                      key={member.id}
                      data-testid={`member-card-${member.id}`}
                      className="rounded-md border border-border bg-card p-3"
                      style={{ marginLeft: depth * 20 }}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[member.status]}`}
                          data-testid={`member-status-${member.id}`}
                          title={`${member.statusReason} · ${t("fleets.evidence.lastRun")}: ${fmtTime(member.evidence.lastRunAt, locale)} · ${t("fleets.evidence.staleWindow")}: ${Math.round((member.evidence.staleWindowMs ?? 0) / 3_600_000)}h`}
                        >
                          {t(`fleets.status.${member.status}`)}
                        </span>
                        <span className="text-sm font-medium">{member.title}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {t(`fleets.kind.${member.target.kind}`)}
                        </span>
                        <span className="text-sm text-muted-foreground" data-testid={`member-target-${member.id}`}>
                          {member.target.label}
                        </span>
                        {member.target.kind === "persona" && member.effectiveModel ? (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              member.modelNotice
                                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                : "bg-muted text-muted-foreground"
                            }`}
                            data-testid={`member-model-${member.id}`}
                            title={member.modelNotice ?? `${t("fleets.member.model")}: ${member.effectiveModel}`}
                          >
                            {member.modelNotice ? `${t("fleets.member.modelFallback")} · ` : ""}
                            {member.effectiveModel}
                          </span>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {member.cadence ? cadenceText(t, member.cadence) : <span title={t("fleets.hints.passive")}>{t("fleets.member.passive")}</span>}
                        </span>
                        {/* Turn outcome (add-fleet-turn-events): failure facts
                            ride alongside the presence badge — never replace
                            it. Interrupted reads warning-tone, failed reads
                            destructive; the reason sits in the title. */}
                        {member.lastTurn && member.lastTurn.status !== "ok" ? (
                          <>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                member.lastTurn.status === "interrupted"
                                  ? "bg-warning/15 text-warning"
                                  : "bg-destructive/15 text-destructive"
                              }`}
                              data-testid={`member-turn-${member.id}`}
                              title={member.lastTurn.error ?? undefined}
                            >
                              {member.lastTurn.status === "interrupted"
                                ? t("fleets.turn.interrupted")
                                : t("fleets.turn.failed")}
                              {member.lastTurn.errorKind ? ` · ${member.lastTurn.errorKind}` : ""}
                            </span>
                            {member.lastTurn.sessionId ? (
                              <button
                                type="button"
                                className="rounded-sm border border-border px-1.5 py-px text-xs hover:bg-muted"
                                onClick={() => navigate(`/chat/${encodeURIComponent(member.lastTurn!.sessionId!)}`)}
                              >
                                {t("fleets.report.openSession")}
                              </button>
                            ) : null}
                          </>
                        ) : null}
                        {(member.consecutiveFailures ?? 0) >= 3 ? (
                          <span
                            className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive"
                            data-testid={`member-consecutive-${member.id}`}
                          >
                            {t("fleets.turn.consecutive")} ×{member.consecutiveFailures}
                          </span>
                        ) : null}
                        {member.status === "passive" && !member.lastTurn ? (
                          <span className="text-xs text-muted-foreground" data-testid={`member-never-run-${member.id}`}>
                            {t("fleets.turn.neverRun")}
                          </span>
                        ) : null}
                        {member.latestReport?.source === "derived" ? (
                          <span
                            className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                            data-testid={`member-derived-badge-${member.id}`}
                          >
                            {t("fleets.report.derivedBadge")}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="ml-auto rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
                          data-testid={`member-report-drawer-${member.id}`}
                          onClick={() => setDrawerFor(member)}
                        >
                          {t("fleets.report.drawerOpen")}
                        </button>
                      </div>
                      {member.latestReport && member.latestReport.slots.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2" data-testid={`member-kpi-${member.id}`}>
                          {member.latestReport.slots.map((slot) => (
                            <span
                              key={slot.key}
                              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                              data-testid={`kpi-slot-${member.id}-${slot.key}`}
                              title={slot.note ? `${t("fleets.report.note")}: ${slot.note}` : undefined}
                            >
                              <span className="text-muted-foreground">{slot.label}</span>
                              <span className="font-medium">{String(slot.value)}{slot.unit || ""}</span>
                              {slot.trend ? (
                                <span
                                  className={
                                    slot.trend.direction === "up"
                                      ? "text-success"
                                      : slot.trend.direction === "down"
                                        ? "text-destructive"
                                        : "text-muted-foreground"
                                  }
                                >
                                  {slot.trend.direction === "up" ? "↑" : slot.trend.direction === "down" ? "↓" : slot.trend.direction === "changed" ? "±" : "→"}
                                  {slot.trend.deltaValue != null && slot.trend.direction !== "flat"
                                    ? `${slot.trend.deltaValue > 0 ? "+" : ""}${slot.trend.deltaValue}`
                                    : ""}
                                </span>
                              ) : null}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {member.latestReport ? (
                        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground" data-testid={`member-summary-${member.id}`}>
                          {member.latestReport.summary}
                        </p>
                      ) : null}
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          {detail.fleet.state !== "archived" ? (
                            <Button variant="outline" size="sm" data-testid={`member-inspect-${member.id}`} onClick={() => openInspector(member)}>
                              {t("fleets.inspector.open")}
                            </Button>
                          ) : null}
                        </div>
                    </div>
                  ))
                )}
              </div>
              </details>

              {/* Daily stream (報数史 IS the daily report — grill ruling): each
                  post's latest, missing posts first, a2a honestly badged. */}
              {detail.stream && detail.stream.length > 0 ? (
                <div className="mt-5" data-testid="fleet-stream">
                  <h3 className="text-sm font-semibold" title={t("fleets.hints.stream")}>{t("fleets.stream.title")}</h3>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {detail.stream.map((row) => (
                      <div key={row.memberId} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs" data-testid={`stream-${row.memberId}`}>
                        <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[row.status]}`}>{t(`fleets.status.${row.status}`)}</span>
                        <span className="font-medium">{row.title}</span>
                        {row.latestReport?.source === "derived" ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{t("fleets.report.derivedBadge")}</span>
                        ) : null}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {row.latestReport ? row.latestReport.summary : t("fleets.stream.noReport")}
                        </span>
                        {row.latestReport?.sessionId ? (
                          <button
                            type="button"
                            className="rounded-sm border border-border px-1.5 py-px hover:bg-muted"
                            onClick={() => navigate(`/chat/${encodeURIComponent(row.latestReport!.sessionId!)}`)}
                          >
                            {t("fleets.report.openSession")}
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {createOpen ? (
        <CreateFleetDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async (id) => {
            setCreateOpen(false);
            await loadList();
            setSelectedId(id);
          }}
        />
      ) : null}
      {composerFor ? (
        <MemberComposerDialog
          fleetId={composerFor}
          members={detail?.members ?? []}
          onClose={() => setComposerFor(null)}
          onDone={async () => {
            setComposerFor(null);
            await refresh();
          }}
        />
      ) : null}
      {swapFor ? (
        <SwapDialog
          member={swapFor}
          onClose={() => setSwapFor(null)}
          onDone={async () => {
            setSwapFor(null);
            await refresh();
          }}
        />
      ) : null}
      {drawerFor ? (
        <ReportDrawer
          member={drawerFor}
          onClose={() => setDrawerFor(null)}
          onRefresh={refresh}
        />
      ) : null}
      {decisionsOpen && selected ? (
        <DecisionsDrawer
          fleetId={selected.id}
          onClose={() => setDecisionsOpen(false)}
          onDecided={refresh}
        />
      ) : null}
      {inspectorFor && selected ? (
        <Suspense fallback={null}>
          <MemberInspector
            member={inspectorFor}
            initialTab={inspectorTab}
            onClose={() => setInspectorFor(null)}
            onSwap={() => setSwapFor(inspectorFor)}
            onAction={async (path, method, body) => {
              await memberAction(path, method, body);
            }}
            onDecision={(item, op, choice) => inspectorDecision(item, op, choice)}
            navigate={(to) => navigate(to)}
          />
        </Suspense>
      ) : null}
      {edgeInspectorFor ? (
        <Suspense fallback={null}>
          <EdgeInspector
            edge={edgeInspectorFor}
            memberTitles={memberTitles}
            constraints={detail?.orchestration?.constraints ?? null}
            traffic={detail?.edgeTraffic ?? []}
            onClose={() => setEdgeInspectorFor(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

// ── decisions drawer ─────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<DecisionItem["severity"], string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-muted text-foreground",
  high: "bg-destructive/15 text-destructive",
};

function DecisionsDrawer({
  fleetId,
  onClose,
  onDecided,
}: {
  fleetId: string;
  onClose: () => void;
  onDecided: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const [items, setItems] = useState<DecisionItem[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-item draft: the chosen option value + note (approve/amend/reject).
  const [drafts, setDrafts] = useState<Record<string, { choice: string; note: string }>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/fleets/${encodeURIComponent(fleetId)}/decisions?state=${showAll ? "all" : "open"}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `list ${r.status}`);
      setItems(body.decisions ?? []);
      setOpenCount(body.openCount ?? 0);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [fleetId, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  const draftFor = (item: DecisionItem) =>
    drafts[item.id] ?? { choice: item.recommendation ?? item.options[0]?.value ?? "", note: "" };

  const act = async (item: DecisionItem, op: string, extra: Record<string, unknown> = {}) => {
    setBusyId(item.id);
    setError(null);
    try {
      const r = await fetch(
        `/api/fleets/${encodeURIComponent(fleetId)}/decisions/${encodeURIComponent(item.id)}/${op}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(extra),
        },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `${op} ${r.status}`);
      await load();
      await onDecided();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            <span title={t("fleets.hints.queue")}>{t("fleets.decisions.drawerTitle")}</span>
            {openCount > 0 ? ` · ${t("fleets.decisions.waitingBadge", { count: openCount })}` : ""}
          </DialogTitle>
        </DialogHeader>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="decisions-show-all" />
          {t("fleets.decisions.showAll")}
        </label>
        {error ? <p className="text-sm text-destructive" data-testid="decisions-error">{error}</p> : null}
        <div className="flex flex-col gap-3" data-testid="decisions-list">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("fleets.decisions.empty")}</p>
          ) : (
            items.map((item) => {
              const draft = draftFor(item);
              return (
                <div
                  key={item.id}
                  data-testid={`decision-${item.id}`}
                  className="rounded-md border border-border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${SEVERITY_STYLES[item.severity]}`}>
                      {t(`fleets.decisions.severity.${item.severity}`)}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      {t(`fleets.decisions.state.${item.state}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {item.memberTitle ?? t("fleets.decisions.memberGone")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(item.submittedAt).toLocaleString(locale)}
                    </span>
                    {item.sourceSessionId ? (
                      <button
                        type="button"
                        className="rounded-sm border border-border px-1.5 py-px text-xs hover:bg-muted"
                        onClick={() => navigate(`/chat/${encodeURIComponent(item.sourceSessionId!)}`)}
                      >
                        {t("fleets.report.openSession")}
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-2 text-sm font-medium" data-testid={`decision-question-${item.id}`}>{item.question}</p>
                  {item.suggestedDeadline ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("fleets.decisions.suggested")}: {item.suggestedDeadline}
                    </p>
                  ) : null}
                  {item.recommendation ? (
                    <p className="text-xs text-muted-foreground">
                      {t("fleets.decisions.recommendation")}: {item.options.find((o) => o.value === item.recommendation)?.label ?? item.recommendation}
                    </p>
                  ) : null}
                  {item.state === "open" ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <select
                        className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        data-testid={`decision-choice-${item.id}`}
                        value={draft.choice}
                        onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: { ...draftFor(item), choice: e.target.value } }))}
                      >
                        {item.options.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <Input
                        placeholder={t("fleets.decisions.notePlaceholder")}
                        value={draft.note}
                        onChange={(e) => setDrafts((d) => ({ ...d, [item.id]: { ...draftFor(item), note: e.target.value } }))}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={busyId === item.id} data-testid={`decision-approve-${item.id}`} onClick={() => void act(item, "approve", { choice: draft.choice, note: draft.note || undefined })}>
                          {t("fleets.decisions.approve")}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void act(item, "reject", { note: draft.note || undefined })}>
                          {t("fleets.decisions.reject")}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void act(item, "amend", { choice: draft.choice, note: draft.note || undefined })}>
                          {t("fleets.decisions.amend")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {item.resolution ? (
                        <span className="text-xs text-muted-foreground" data-testid={`decision-resolution-${item.id}`}>
                          {(() => {
                            const r = item.resolution;
                            return r.kind === "reject"
                              ? t("fleets.decisions.rejectedAs", { note: r.note ?? "" })
                              : `${t("fleets.decisions.choicePrefix")} ${item.options.find((o) => o.value === r.choice)?.label ?? r.choice ?? "—"}${r.note ? ` · ${r.note}` : ""}`;
                          })()}
                        </span>
                      ) : null}
                      {item.state === "expired" ? (
                        <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void act(item, "reopen")}>
                          {t("fleets.decisions.reopen")}
                        </Button>
                      ) : null}
                      {item.state === "approved" && !item.deliveredAt ? (
                        <>
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                            {item.memberDeleted ? t("fleets.decisions.awaitMember") : t("fleets.decisions.awaitDelivery")}
                          </span>
                          {!item.memberDeleted ? (
                            <Button size="sm" variant="outline" disabled={busyId === item.id} data-testid={`decision-execute-${item.id}`} onClick={() => void act(item, "execute-now")}>
                              {t("fleets.decisions.executeNow")}
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                      {item.state === "delivered" ? (
                        <span className="text-xs text-success">{t("fleets.decisions.delivered")}</span>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── report drawer ────────────────────────────────────────────────────────────

function ReportDrawer({
  member,
  onClose,
  onRefresh,
}: {
  member: MemberView;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const navigate = useNavigate();
  const [rows, setRows] = useState<ReportEntry[]>(member.reportTimeline ?? []);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      try {
        const q = new URLSearchParams();
        if (before != null) q.set("before", String(before));
        q.set("limit", "20");
        const r = await fetch(
          `/api/fleets/${encodeURIComponent(member.fleetId)}/members/${encodeURIComponent(member.id)}/reports?${q}`,
        );
        if (!r.ok) return;
        const body = await r.json();
        setRows((prev) => (before == null ? body.reports : [...prev, ...body.reports]));
        setNextBefore(body.nextBefore ?? null);
      } finally {
        setLoading(false);
      }
    },
    [member.fleetId, member.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("fleets.report.drawerTitle")} — {member.title}
          </DialogTitle>
        </DialogHeader>
        {member.latestReport ? (
          <div className="rounded-md border border-border p-3" data-testid="report-drawer-latest">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{new Date(member.latestReport.at).toLocaleString(locale)}</span>
              <span className="rounded-full bg-muted px-2 py-0.5">
                {member.latestReport.source === "derived" ? t("fleets.report.derivedBadge") : t("fleets.report.selfBadge")}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {member.latestReport.slots.map((s) => (
                <span key={s.key} className="rounded-md bg-muted px-2 py-1 text-xs">
                  {s.label}: <span className="font-medium">{String(s.value)}{s.unit || ""}</span>
                </span>
              ))}
            </div>
            <p className="mt-2 text-sm">{member.latestReport.summary}</p>
            {member.latestReport.blockers.length > 0 ? (
              <p className="mt-1 text-xs text-destructive">
                {t("fleets.report.blockers")}: {member.latestReport.blockers.join("；")}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("fleets.report.noReports")}</p>
        )}
        <div className="flex flex-col gap-2" data-testid="report-timeline">
          {rows.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-2 text-xs" data-testid={`report-row-${r.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{new Date(r.at).toLocaleString(locale)}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5">{r.source === "derived" ? t("fleets.report.derivedBadge") : t("fleets.report.selfBadge")}</span>
                {r.sessionId ? (
                  <button
                    type="button"
                    className="rounded-sm border border-border px-1.5 py-px hover:bg-muted"
                    onClick={() => navigate(`/chat/${encodeURIComponent(r.sessionId!)}`)}
                  >
                    {t("fleets.report.openSession")}
                  </button>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3">
                {Object.entries(r.metrics).map(([k, m]) => (
                  <span key={k}>
                    {k}: <span className="font-medium">{String(m.value)}</span>
                  </span>
                ))}
              </div>
              <p className="mt-1 line-clamp-2">{r.summary}</p>
            </div>
          ))}
        </div>
        {nextBefore != null ? (
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(nextBefore)}>
            {t("fleets.report.loadMore")}
          </Button>
        ) : null}
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => void onRefresh()}>
            {t("fleets.report.refresh")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── dialogs ─────────────────────────────────────────────────────────────────

function CreateFleetDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/fleets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `create ${r.status}`);
      onCreated(body.fleet.id);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("fleets.create")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Label htmlFor="fleet-name">{t("fleets.nameLabel")}</Label>
          <Input
            id="fleet-name"
            data-testid="fleet-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("fleets.namePlaceholder")}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button data-testid="fleet-create-submit" disabled={busy || !name.trim()} onClick={() => void submit()}>
              {t("fleets.create")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Target universe for the pickers: catalog chat personas + a2a entries, plus
// the cell's dynamic clusters.
function useTargets() {
  const [targets, setTargets] = useState<CatalogTarget[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [catR, clustersR] = await Promise.all([
          fetch("/api/catalog").then((r) => r.json()).catch(() => null),
          fetch("/api/clusters/mine").then((r) => r.json()).catch(() => null),
        ]);
        if (!alive) return;
        const out: CatalogTarget[] = [];
        for (const a of catR?.agents ?? []) {
          if (a?.mode === "chat") out.push({ id: a.id, name: a.name ?? a.id, kind: "persona" });
          else if (a?.mode === "a2a") out.push({ id: a.id, name: a.name ?? a.id, kind: "a2a" });
        }
        for (const c of clustersR?.clusters ?? []) {
          out.push({ id: c.clusterId, name: c.name, kind: "cluster" });
        }
        setTargets(out);
      } catch {
        /* an unreachable catalog leaves the picker empty; creation refuses */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return targets;
}

interface CadenceDraft {
  mode: "none" | "hourly" | "daily" | "custom";
  time: string;
  cron: string;
  tz: string;
  promptTemplate: string;
}

function buildCadence(d: CadenceDraft): Cadence | null {
  if (d.mode === "none") return null;
  let cron = d.cron.trim();
  if (d.mode === "hourly") cron = "0 * * * *";
  if (d.mode === "daily") {
    const [h, m] = (d.time || "09:00").split(":");
    cron = `${Number(m) || 0} ${Number(h) || 9} * * *`;
  }
  if (!cron) return null;
  return { cron, tz: d.tz.trim() || null, promptTemplate: d.promptTemplate, enabled: true };
}

function MemberComposerDialog({
  fleetId,
  members,
  onClose,
  onDone,
}: {
  fleetId: string;
  members: MemberView[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const targets = useTargets();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<CatalogTarget["kind"]>("persona");
  const [targetId, setTargetId] = useState("");
  const [parentId, setParentId] = useState("");
  const [cadence, setCadence] = useState<CadenceDraft>({ mode: "none", time: "09:00", cron: "", tz: "", promptTemplate: "" });
  const [denseConfirm, setDenseConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kindTargets = targets.filter((x) => x.kind === kind);

  const submit = async (confirmed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/fleets/${encodeURIComponent(fleetId)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          targetKind: kind,
          targetId,
          parentId: parentId || null,
          cadence: buildCadence(cadence),
          ...(confirmed ? { confirmed: true } : {}),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (body.code === "cadence_confirmation_required") {
          setDenseConfirm(true);
          return;
        }
        throw new Error(body.error ?? `create ${r.status}`);
      }
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("fleets.addMember")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="member-title">{t("fleets.member.titleLabel")}</Label>
            <Input id="member-title" data-testid="member-title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="member-kind">{t("fleets.member.kindLabel")}</Label>
              <select
                id="member-kind"
                data-testid="member-kind-select"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as CatalogTarget["kind"]);
                  setTargetId("");
                }}
              >
                <option value="persona">{t("fleets.kind.persona")}</option>
                <option value="cluster">{t("fleets.kind.cluster")}</option>
                <option value="a2a">{t("fleets.kind.a2a")}</option>
              </select>
            </div>
            <div>
              <Label htmlFor="member-target">{t("fleets.member.target")}</Label>
              <select
                id="member-target"
                data-testid="member-target-select"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">{t("fleets.member.targetPlaceholder")}</option>
                {kindTargets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Label htmlFor="member-parent">{t("fleets.member.parent")}</Label>
            <select
              id="member-parent"
              data-testid="member-parent-select"
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">{t("fleets.member.noParent")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-md border border-border p-3">
            <Label>{t("fleets.member.cadence")}</Label>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <select
                data-testid="member-cadence-mode"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={cadence.mode}
                onChange={(e) => setCadence((c) => ({ ...c, mode: e.target.value as CadenceDraft["mode"] }))}
              >
                <option value="none">{t("fleets.member.passive")}</option>
                <option value="hourly">{t("fleets.cadence.hourlyMode")}</option>
                <option value="daily">{t("fleets.cadence.dailyMode")}</option>
                <option value="custom">{t("fleets.cadence.customMode")}</option>
              </select>
              {cadence.mode === "daily" ? (
                <Input
                  type="time"
                  data-testid="member-cadence-time"
                  value={cadence.time}
                  onChange={(e) => setCadence((c) => ({ ...c, time: e.target.value }))}
                />
              ) : cadence.mode === "custom" ? (
                <Input
                  data-testid="member-cadence-cron"
                  placeholder="0 9 * * *"
                  value={cadence.cron}
                  onChange={(e) => setCadence((c) => ({ ...c, cron: e.target.value }))}
                />
              ) : null}
            </div>
            {cadence.mode !== "none" ? (
              <div className="mt-2 flex flex-col gap-2">
                <Input
                  data-testid="member-cadence-tz"
                  placeholder={t("fleets.cadence.tzPlaceholder")}
                  value={cadence.tz}
                  onChange={(e) => setCadence((c) => ({ ...c, tz: e.target.value }))}
                />
                <Textarea
                  data-testid="member-cadence-prompt"
                  rows={3}
                  placeholder={t("fleets.cadence.promptPlaceholder")}
                  value={cadence.promptTemplate}
                  onChange={(e) => setCadence((c) => ({ ...c, promptTemplate: e.target.value }))}
                />
              </div>
            ) : null}
          </div>
          {denseConfirm ? (
            <div className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm" data-testid="dense-confirm">
              {t("fleets.dense.confirm")}
              <div className="mt-2 flex justify-end">
                <Button size="sm" data-testid="dense-confirm-submit" onClick={() => void submit(true)}>
                  {t("fleets.dense.accept")}
                </Button>
              </div>
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              data-testid="member-create-submit"
              disabled={busy || !title.trim() || !targetId}
              onClick={() => void submit(denseConfirm)}
            >
              {t("fleets.addMember")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SwapDialog({ member, onClose, onDone }: { member: MemberView; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const targets = useTargets();
  const [kind, setKind] = useState<CatalogTarget["kind"]>(member.target.kind);
  const [targetId, setTargetId] = useState("");
  const [freshSession, setFreshSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kindTargets = targets.filter((x) => x.kind === kind);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/fleets/${encodeURIComponent(member.fleetId)}/members/${member.id}/swap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetKind: kind, targetId, freshSession }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `swap ${r.status}`);
      onDone();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("fleets.swap")} — {member.title}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="swap-kind">{t("fleets.member.kindLabel")}</Label>
              <select
                id="swap-kind"
                data-testid="swap-kind-select"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as CatalogTarget["kind"]);
                  setTargetId("");
                }}
              >
                <option value="persona">{t("fleets.kind.persona")}</option>
                <option value="cluster">{t("fleets.kind.cluster")}</option>
                <option value="a2a">{t("fleets.kind.a2a")}</option>
              </select>
            </div>
            <div>
              <Label htmlFor="swap-target">{t("fleets.member.target")}</Label>
              <select
                id="swap-target"
                data-testid="swap-target-select"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">{t("fleets.member.targetPlaceholder")}</option>
                {kindTargets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="swap-fresh-session"
              checked={freshSession}
              onChange={(e) => setFreshSession(e.target.checked)}
            />
            {t("fleets.swapLine.freshSession")}
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button data-testid="swap-submit" disabled={busy || !targetId} onClick={() => void submit()}>
              {t("fleets.swap")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
