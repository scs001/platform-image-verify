// AgentStudioPage — the visual agent builder (add-agent-studio).
//
// Three panes: roster (left) · canvas (center) · preview/inspect (right).
// The working document is EPHEMERAL CLIENT STATE (design D1): persisting
// means emitting — a cell-local preset or a pack draft — through the
// existing endpoints and gates. Compose-time validation rides the EXISTING
// publish-gate dry-run `POST /api/packs/validate` (design D2, amended
// 2026-10-31: reuse, zero new server code) — the errors shown are the ones
// emit will produce, never a client-side rewording. The right pane renders
// through the shared AgentSpecSheet (add-agent-spec-sheet): surfaces supply
// data, the bucket layout lives in one place.
//
// v1 scope (design D8): single-agent documents; the team tab renders a
// document's fleet block read-only (FleetGraph, no edge affordances); AI
// drafting lands with the builder tool-face HTTP bridge (task 4.x).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Plus, TriangleAlert } from "lucide-react";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import * as presetsApi from "@/lib/presets-api";
import * as packsApi from "@/lib/packs-api";
import type { PackManifestAgent, PackManifestMcp, PackManifestSkill, PackSummary } from "@/lib/packs-api";
import { AgentSpecSheet } from "@/components/packs/AgentSpecSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FleetGraph, type GraphEdge, type GraphMember } from "@/components/FleetGraph";
import { cn } from "@/lib/utils";
import { BlueprintTeamMode } from "@/components/studio/BlueprintTeamMode";
import { AgentBucketsEditor } from "@/components/studio/AgentBucketsEditor";

// The working document: a pack manifest in the making (client state only).
interface StudioDoc {
  name: string;
  description: string;
  tags: string[];
  agents: PackManifestAgent[];
  skills: PackManifestSkill[];
  mcpServers: PackManifestMcp[];
  fleet?: Record<string, unknown>;
}

const emptyDoc = (): StudioDoc => ({
  name: "",
  description: "",
  tags: [],
  agents: [],
  skills: [],
  mcpServers: [],
});

function newAgent(n: number): PackManifestAgent {
  return { id: `agent-${n}`, name: "", persona: "" };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function AgentStudioPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // fold-blueprint-into-studio: the retired /blueprints route lands here with
  // from=blueprint — team tab (the blueprint working surface) selected.
  const fromBlueprint = searchParams.get("from") === "blueprint";
  const { skills, marketCatalog, load } = useExtensionsStore();

  const [doc, setDoc] = useState<StudioDoc>(emptyDoc);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"agent" | "team">(fromBlueprint ? "team" : "agent");
  const [verdict, setVerdict] = useState<{ valid: boolean; errors: { error: string; errors?: { error: string; entry?: string }[] }[] } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [emitBusy, setEmitBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const seq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = doc.agents.find((a) => a.id === selectedId) ?? null;

  const patchDoc = useCallback((patch: Partial<StudioDoc>) => setDoc((d) => ({ ...d, ...patch })), []);
  const patchAgent = useCallback(
    (id: string, patch: Partial<PackManifestAgent>) =>
      setDoc((d) => ({ ...d, agents: d.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
    [],
  );

  // ── Live validation: the publish-gate dry-run, debounced ──────────────────
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setVerifying(true);
      try {
        const r = await fetch("/api/packs/validate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ manifest: doc }),
        });
        setVerdict(await r.json());
      } catch {
        setVerdict(null);
      } finally {
        setVerifying(false);
      }
    }, 600);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [doc]);

  const flatErrors = useMemo(() => {
    if (!verdict || verdict.valid) return [] as { error: string; entry?: string }[];
    return verdict.errors.flatMap((e) => (e.errors && e.errors.length ? e.errors : [{ error: e.error }]));
  }, [verdict]);
  const docValid = verdict?.valid === true;

  // ── Emit: preset (per selected agent) / pack draft (whole document) ───────
  // Both re-validate at emit time (defense in depth) and never mutate the
  // working document (spec: emit SHALL NOT mutate the working document).
  const emitPreset = async () => {
    if (!selected || !docValid) return;
    setEmitBusy("preset");
    setNotice(null);
    try {
      const pre = await fetch("/api/packs/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest: doc }),
      }).then((r) => r.json());
      if (!pre.valid) throw new Error(pre.errors?.[0]?.error ?? "invalid");
      await presetsApi.createCustomPreset({
        name: selected.name || selected.id,
        persona: selected.persona,
        skills: doc.skills.map((s) => s.name),
        mcpServers: doc.mcpServers.map((m) => m.registryName),
        mcpTools: Object.fromEntries(
          doc.mcpServers.filter((m) => m.allowTools?.length).map((m) => [m.registryName, m.allowTools!]),
        ),
      });
      setNotice({ kind: "ok", text: t("studio.emit.presetOk", { name: selected.name || selected.id }) });
    } catch (err) {
      setNotice({ kind: "err", text: t("studio.emit.failed", { message: (err as Error).message }) });
    } finally {
      setEmitBusy(null);
    }
  };

  const emitDraft = async () => {
    if (!docValid) return;
    setEmitBusy("draft");
    setNotice(null);
    try {
      const pre = await fetch("/api/packs/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest: doc }),
      }).then((r) => r.json());
      if (!pre.valid) throw new Error(pre.errors?.[0]?.error ?? "invalid");
      await packsApi.createPackDraft({
        name: doc.name,
        description: doc.description,
        tags: doc.tags,
        entries: { skills: doc.skills, mcpServers: doc.mcpServers, agents: doc.agents },
      });
      setNotice({ kind: "ok", text: t("studio.emit.draftOk") });
      // The draft now lives in 我的创作 — take the user there (same IA the
      // preset-conversion handoff uses).
      navigate("/agents?tab=market");
    } catch (err) {
      setNotice({ kind: "err", text: t("studio.emit.failed", { message: (err as Error).message }) });
    } finally {
      setEmitBusy(null);
    }
  };

  // ── Buckets: skills / mcp editors ─────────────────────────────────────────
  const localSkills = useMemo(
    () => skills.filter((s) => s.source === "database" && s.enabled).sort((a, b) => a.name.localeCompare(b.name)),
    [skills],
  );
  const catalogServers = useMemo(
    () => marketCatalog?.mcpServers ?? [],
    [marketCatalog],
  );

  // Team tab: the document's fleet block, rendered read-only (v1 — no edge
  // affordances; the graph reflects the document exactly as it stands).
  const fleetMembers = useMemo<GraphMember[]>(() => {
    const fleet = doc.fleet as { members?: GraphMember[] } | undefined;
    return Array.isArray(fleet?.members) ? fleet!.members : [];
  }, [doc.fleet]);
  const fleetEdges = useMemo<GraphEdge[]>(() => {
    const fleet = doc.fleet as { orchestration?: { edges?: GraphEdge[] } };
    return Array.isArray(fleet?.orchestration?.edges) ? fleet!.orchestration.edges : [];
  }, [doc.fleet]);

  const totalTools = (registryName: string) =>
    marketCatalog?.mcpServers?.find((s) => s.name === registryName)?.toolList?.length ?? null;

  return (
    <div className="flex h-full flex-col bg-background" data-testid="agent-studio">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-medium">{t("studio.title")}</h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="studio-new-agent"
            onClick={() => {
              seq.current += 1;
              const a = newAgent(doc.agents.length + seq.current);
              patchDoc({ agents: [...doc.agents, a] });
              setSelectedId(a.id);
              setTab("agent");
            }}
          >
            <Plus className="h-3.5 w-3.5" /> {t("studio.roster.new")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── Roster ── */}
        <aside className="w-52 shrink-0 overflow-y-auto border-r border-border p-2" data-testid="studio-roster">
          <div className="space-y-1">
            {doc.agents.map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid={`studio-roster-agent-${a.id}`}
                onClick={() => {
                  setSelectedId(a.id);
                  setTab("agent");
                }}
                className={cn(
                  "w-full truncate rounded-md px-2 py-1.5 text-left text-xs",
                  selectedId === a.id && tab === "agent" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                {a.name || a.id}
              </button>
            ))}
            {doc.agents.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">{t("studio.roster.empty")}</p>}
          </div>
          <div className="mt-3 border-t border-border pt-2">
            <button
              type="button"
              data-testid="studio-tab-team"
              onClick={() => setTab("team")}
              className={cn(
                "w-full rounded-md px-2 py-1.5 text-left text-xs",
                tab === "team" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {t("studio.team.tab")}
            </button>
          </div>
        </aside>

        {/* ── Canvas ── */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4" data-testid="studio-canvas">
          {tab === "team" ? (
            <div className="flex h-full min-h-0 flex-col" data-testid="studio-team-view">
              {/* Working-document fleet graph (read-only, v1): collapsed by
                  default — the blueprint working surface is the fold's focus. */}
              <details className="mx-auto w-full max-w-3xl px-3 pt-3" data-testid="studio-doc-graph">
                <summary className="cursor-pointer text-xs text-muted-foreground">{t("studio.team.tab")}</summary>
                <div className="mt-2">
                  <FleetGraph
                    members={fleetMembers}
                    edges={fleetEdges}
                    kindLabels={{}}
                    emptyLabel={t("studio.team.empty")}
                  />
                  <p className="mt-2 text-[11px] text-muted-foreground">{t("studio.team.readOnlyHint")}</p>
                </div>
              </details>
              <div className="min-h-0 flex-1">
                <BlueprintTeamMode autoFocusPool={fromBlueprint} />
              </div>
            </div>
          ) : selected ? (
            <div className="mx-auto max-w-2xl space-y-3">
              <Field label={t("studio.agent.id")}>
                <Input value={selected.id} disabled className="font-mono text-xs" data-testid="studio-agent-id" />
              </Field>
              <Field label={t("studio.agent.name")}>
                <Input
                  value={selected.name}
                  onChange={(e) => patchAgent(selected.id, { name: e.target.value })}
                  data-testid="studio-agent-name"
                />
              </Field>

              {/* Three buckets via the SHARED editor (fold D1: one editor,
                  two hosts — the blueprint team mode renders the same one). */}
              <AgentBucketsEditor
                value={doc}
                localSkills={localSkills}
                catalogServers={catalogServers}
                onChange={(next: { agents: typeof doc.agents; skills?: typeof doc.skills; mcpServers: typeof doc.mcpServers }) => setDoc((d) => ({ ...d, ...next }))}
                testIdPrefix="studio-bucket"
              />
            </div>
          ) : (
            <p className="p-8 text-center text-sm text-muted-foreground" data-testid="studio-empty">
              {t("studio.canvas.empty")}
            </p>
          )}
        </main>

        {/* ── Preview / validate / emit ── */}
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-border p-3" data-testid="studio-inspect">
          <AgentSpecSheet
            variant="full"
            testIdPrefix="studio-spec"
            roles={doc.agents.map((a) => ({ id: a.id, name: a.name, persona: a.persona, serving: a.serving != null }))}
            skills={doc.skills}
            mcp={doc.mcpServers.map((m) => ({ ...m, totalTools: totalTools(m.registryName) }))}
          />

          <div className="mt-4" data-testid="studio-verdict">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              {verifying ? (
                <span className="text-muted-foreground">{t("studio.validate.running")}</span>
              ) : docValid ? (
                <span className="text-emerald-600" data-testid="studio-verdict-ok">{t("studio.validate.ok")}</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-destructive" data-testid="studio-verdict-bad">
                  <TriangleAlert className="h-3.5 w-3.5" /> {t("studio.validate.bad", { n: flatErrors.length })}
                </span>
              )}
            </div>
            <ul className="mt-1 space-y-1">
              {flatErrors.map((e, i) => (
                <li
                  /* biome-ignore lint/suspicious/noArrayIndexKey: error rows are a flat list of plain strings, never reordered */
                  key={i}
                  className="whitespace-pre-line rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs"
                  data-testid="studio-verdict-error"
                >
                  {e.entry ? <span className="mr-1 font-mono text-[11px] text-destructive">{e.entry}</span> : null}
                  {e.error}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 space-y-2">
            <Button
              size="sm"
              className="w-full"
              disabled={!docValid || !selected || emitBusy !== null}
              onClick={emitPreset}
              data-testid="studio-emit-preset"
            >
              {emitBusy === "preset" ? t("studio.emit.busy") : t("studio.emit.preset")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!docValid || doc.agents.length === 0 || emitBusy !== null}
              onClick={emitDraft}
              data-testid="studio-emit-draft"
            >
              {emitBusy === "draft" ? t("studio.emit.busy") : t("studio.emit.draft")}
            </Button>
            {notice && (
              <p className={cn("text-xs", notice.kind === "ok" ? "text-emerald-600" : "text-destructive")} data-testid="studio-notice">
                {notice.text}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// Keep PackSummary referenced for the draft emit return typing used by
// PacksPage's handoff (the studio lands users on the market's 我的 view).
export type { PackSummary };
