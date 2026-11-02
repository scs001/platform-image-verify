// AgentStudioPage — the unified authoring workspace (add-agent-builder-workspace).
//
// Three panes: document library (left) · canvas (center) · context inspector
// (right). Every document is a PERSISTED blueprint record (design D1: the
// ephemeral working document is retired — autosave rides the existing
// optimistic-lock PUT; the draft pool is the workspace's own storage and
// lands no market/cast/cluster artifact before approval, the
// fleet-blueprint-studio doctrine verbatim). The inspector ALWAYS describes
// the document open on the canvas (design D4 — the production-screenshot
// mismatch, center editing the blueprint while the right pane validated an
// empty ephemeral doc, is structurally impossible here). The lifecycle is one
// ribbon projecting the server's real state machine (design D3), and the
// retired team-mode tab / second editor host are gone: one editor, one truth.
//
// Batch 1 scope: team-shaped documents (kind arrives with batch 2); the
// skills bucket is not editable here yet (assembleManifest carries none — a
// bucket that silently drops at cast would be a false green).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Blocks, PanelLeft, PanelRight, Plus, Sparkles } from "lucide-react";
import { useChatStore } from "@platform/core";
import { useAuthStore } from "@/hooks/useAuth";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import * as bp from "@/lib/blueprint-api";
import type { Blueprint, BlueprintContent, BlueprintSummary, TrialReport, ValidationVerdict } from "@/lib/blueprint-api";
import * as presetsApi from "@/lib/presets-api";
import * as packsApi from "@/lib/packs-api";
import type { PackManifest, PackManifestAgent, PackManifestMcp, PackManifestSkill } from "@/lib/packs-api";
import { AgentSpecSheet } from "@/components/packs/AgentSpecSheet";
import { AgentBucketsEditor } from "@/components/studio/AgentBucketsEditor";
import { DocumentLibrary, DOC_STATUS_TONE } from "@/components/studio/DocumentLibrary";
import { LifecycleRibbon } from "@/components/studio/LifecycleRibbon";
import { ValidationPanel } from "@/components/studio/ValidationPanel";
import { AiDraftOverlay, type DraftField } from "@/components/studio/AiDraftOverlay";
import { FleetGraph, type GraphEdge, type GraphMember } from "@/components/FleetGraph";
import { teamRibbon } from "@/lib/workspace-lifecycle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "@/components/ui/status-pill";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { showToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

function SectionCard({ title, children, testid, anchor }: { title: string; children: React.ReactNode; testid: string; anchor?: string }) {
  return (
    <div className="rounded-md border border-border p-3" data-testid={testid} {...(anchor ? { "data-anchor": anchor } : {})}>
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const trialOf = (b: Blueprint | null): TrialReport | null => {
  const r = b?.trialReport as { ranAt?: number; signoff?: { by?: string; reportRanAt?: number } } | null | undefined;
  return r && typeof r.ranAt === "number" ? (r as unknown as TrialReport) : null;
};

export function AgentStudioPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { marketCatalog, load, skills: localSkillsAll } = useExtensionsStore();
  const modelRoster = useChatStore((s) => s.models);
  const userEmail = useAuthStore((s) => s.email);

  // ── library + open document ───────────────────────────────────────────────
  const [docs, setDocs] = useState<BlueprintSummary[]>([]);
  const [doc, setDoc] = useState<Blueprint | null>(null);
  const [content, setContent] = useState<BlueprintContent | null>(null);
  const [track, setTrack] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // ── save / validation / action state ──────────────────────────────────────
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "conflict">("clean");
  const [conflict, setConflict] = useState<{ serverVersion: number } | null>(null);
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const [verdict, setVerdict] = useState<ValidationVerdict | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [trialRunning, setTrialRunning] = useState(false);

  // ── AI drafting (overlay) ─────────────────────────────────────────────────
  const [aiOpen, setAiOpen] = useState(false);
  const [ai, setAi] = useState<{ prompt: string; busy: boolean; draft: Record<string, unknown> | null; error: string | null }>({
    prompt: "", busy: false, draft: null, error: null,
  });

  // ── canvas support data (collections for dataSources, judge default) ─────
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [judgeDefault, setJudgeDefault] = useState<bp.JudgeDefaultProbe | null>(null);

  // ── pane visibility (narrow-screen collapse, spec 窄屏降级) ──────────────
  const [showLibrary, setShowLibrary] = useState(true);
  const [showInspector, setShowInspector] = useState(true);

  const docRef = useRef<Blueprint | null>(null);
  const contentRef = useRef<BlueprintContent | null>(null);
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const dirtyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusNameRef = useRef(false);
  docRef.current = doc;
  contentRef.current = content;

  const refreshDocs = useCallback(async () => {
    try {
      const { blueprints } = await bp.listBlueprints();
      setDocs(blueprints ?? []);
    } catch {
      /* the library keeps its last good list; a failed refresh is not fatal */
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshDocs();
    bp.getJudgeDefault().then(setJudgeDefault).catch(() => {});
    fetch("/api/collections")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`collections ${r.status}`))))
      .then((body) => setCollections(Array.isArray(body?.collections) ? body.collections : []))
      .catch(() => setCollections([]));
  }, [load, refreshDocs]);

  const runValidate = useCallback(async (id: string) => {
    setVerifying(true);
    try {
      setVerdict(await bp.validateBlueprint(id));
    } catch {
      setVerdict(null);
    } finally {
      setVerifying(false);
    }
  }, []);

  const applyBlueprint = useCallback((b: Blueprint) => {
    setDoc(b);
    setContent(b.content);
    setJsonText(JSON.stringify(b.content, null, 2));
    setTrack("form");
    setJsonError(null);
  }, []);

  const openDoc = useCallback(
    async (id: string) => {
      setBusy("open");
      try {
        const { blueprint } = await bp.getBlueprint(id);
        applyBlueprint(blueprint);
        dirtyRef.current = false;
        setSaveState("clean");
        setConflict(null);
        setSelectedAgentId((blueprint.content.agents as { id?: string }[] | undefined)?.[0]?.id ?? null);
        void runValidate(blueprint.id);
      } catch (err) {
        showToast({ severity: "error", title: t("studio.workspace.openFailed"), description: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [applyBlueprint, runValidate, t],
  );

  // ── autosave: debounce → optimistic PUT → validate the SAVED content ─────
  // (the dual-track discipline rides this: JSON edits land through the same
  // PUT, and validation always speaks of what the server holds — never of an
  // unsaved local guess.)
  const saveNow = useCallback(async () => {
    const d = docRef.current;
    const c = contentRef.current;
    if (!d || !c) return;
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }
    savingRef.current = true;
    setSaveState("saving");
    try {
      const { blueprint } = await bp.updateBlueprint(d.id, d.version, c);
      applyBlueprint(blueprint);
      dirtyRef.current = false;
      setSaveState("clean");
      setConflict(null);
      await runValidate(blueprint.id);
      void refreshDocs();
    } catch (err) {
      if (err instanceof bp.BlueprintApiError && err.status === 409) {
        // Server holds a newer version — the user decides, nothing silent.
        setSaveState("conflict");
        setConflict({ serverVersion: Number(err.body?.currentVersion ?? 0) });
        dirtyRef.current = true;
      } else {
        setSaveState("dirty");
        dirtyRef.current = true;
        showToast({ severity: "error", title: t("studio.workspace.saveFailed"), description: (err as Error).message });
      }
    } finally {
      savingRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void saveNow();
      }
    }
  }, [applyBlueprint, runValidate, refreshDocs, t]);

  useEffect(() => {
    if (!doc || !content || !dirtyRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void saveNow(), 1500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content, doc, saveNow]);

  const patchContent = useCallback((p: Partial<BlueprintContent>) => {
    dirtyRef.current = true;
    setSaveState("dirty");
    setContent((c0) => (c0 ? { ...c0, ...p } : c0));
  }, []);

  const createDoc = useCallback(async (kind: "agent" | "team" = "team"): Promise<string | null> => {
    setBusy("create");
    try {
      const seed = kind === "agent"
        ? bp.agentSkeletonContent(t("studio.blueprint.untitledAgent"))
        : bp.skeletonContent(t("studio.blueprint.untitled"));
      const { blueprint } = await bp.createBlueprint(seed);
      await refreshDocs();
      focusNameRef.current = true;
      await openDoc(blueprint.id);
      return blueprint.id;
    } catch (err) {
      showToast({ severity: "error", title: t("studio.workspace.createFailed"), description: (err as Error).message });
      return null;
    } finally {
      setBusy(null);
    }
  }, [openDoc, refreshDocs, t]);

  // Focus the scene name right after a fresh document opens (one click to edit).
  useEffect(() => {
    if (doc && focusNameRef.current) {
      focusNameRef.current = false;
      document.querySelector<HTMLInputElement>('[data-anchor="boundary.name"]')?.focus();
    }
  }, [doc]);

  // ── deep links: ?doc= / ?fork= / ?new= / legacy ?from=blueprint ──────────
  const docParam = searchParams.get("doc");
  const forkParam = searchParams.get("fork");
  const newParam = searchParams.get("new");
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed once per param value
  useEffect(() => {
    void (async () => {
      if (docParam) {
        await openDoc(docParam);
        return;
      }
      if (forkParam) {
        try {
          const r = await fetch(`/api/packs/${encodeURIComponent(forkParam)}`);
          if (!r.ok) throw new Error(t("studio.fork.unavailable", { status: r.status }));
          const detail = await r.json();
          const m = detail.manifest ?? {};
          const parentLicense = (m.provenance as { license?: string } | undefined)?.license;
          const seeded: BlueprintContent = {
            boundary: { name: m.name ?? "", oneLine: m.description ?? "", outOfScope: "" },
            tags: m.tags ?? [],
            dataSources: [],
            fleet: m.fleet ?? { name: m.name ?? "", members: [] },
            agents: m.agents ?? [],
            mcpServers: m.mcpServers ?? [],
            monitoring: {},
            acceptance: [],
            board: {},
            provenance: { forkOf: { packId: detail.id, version: detail.version }, ...(parentLicense ? { license: parentLicense } : {}) },
          };
          const { blueprint } = await bp.createBlueprint(seeded);
          await refreshDocs();
          await openDoc(blueprint.id);
          // Replace the seeding URL: a reload must not mint a second draft.
          navigate(`/studio?doc=${encodeURIComponent(blueprint.id)}`, { replace: true });
          showToast({ severity: "success", title: t("studio.fork.seeded", { name: detail.name ?? detail.id }) });
        } catch (err) {
          // Unreadable seed: honest toast, land on the library — never a blank editor.
          showToast({ severity: "error", title: t("studio.workspace.forkMiss"), description: (err as Error).message });
        }
        return;
      }
      if (newParam) {
        // 4.4: ?new=agent 直铸岗位文档；?new=1 / ?new=team 铸场景文档。
        const id = await createDoc(newParam === "agent" ? "agent" : "team");
        if (id) navigate(`/studio?doc=${encodeURIComponent(id)}`, { replace: true });
      }
    })();
  }, [docParam, forkParam, newParam]);

  // ── lifecycle actions (ribbon) ────────────────────────────────────────────
  const act = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      try {
        await fn();
      } catch (err) {
        showToast({ severity: "error", title: t("studio.workspace.actionFailed", { action: label }), description: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const onRibbonAction = useCallback(
    (a: "approve" | "cast" | "trial" | "sign" | "unsign" | "reseal") => {
      if (!doc) return;
      if (a === "approve") {
        void act("approve", async () => {
          const { blueprint } = await bp.approveBlueprint(doc.id, doc.version);
          applyBlueprint(blueprint);
          await runValidate(blueprint.id);
          void refreshDocs();
          showToast({ severity: "success", title: t("studio.workspace.approved") });
        });
      } else if (a === "cast" || a === "reseal") {
        void act(a, async () => {
          const { blueprint, cast } = await bp.castBlueprint(doc.id);
          applyBlueprint(blueprint);
          void refreshDocs();
          showToast({ severity: "success", title: t("studio.workspace.castOk", { packId: cast.packId ?? blueprint.castPackId ?? "?", version: cast.version ?? blueprint.castPackVersion ?? "?" }) });
        });
      } else if (a === "trial") {
        setTrialRunning(true);
        void act("trial", async () => {
          try {
            const { report, blueprint } = await bp.runTrial(doc.id);
            applyBlueprint(blueprint);
            void refreshDocs();
            showToast({
              severity: report.green ? "success" : "error",
              title: report.green ? t("studio.workspace.trialGreen") : t("studio.workspace.trialRed"),
            });
          } finally {
            setTrialRunning(false);
          }
        }).catch(() => setTrialRunning(false));
      } else if (a === "sign") {
        void act("sign", async () => {
          const { blueprint } = await bp.signTrialReport(doc.id);
          applyBlueprint(blueprint);
          void refreshDocs();
          showToast({ severity: "success", title: t("studio.workspace.signed") });
        });
      } else if (a === "unsign") {
        void act("unsign", async () => {
          const { blueprint } = await bp.unsignTrialReport(doc.id);
          applyBlueprint(blueprint);
        });
      }
    },
    [doc, act, applyBlueprint, runValidate, refreshDocs, t],
  );

  // ── emit ports (never mutate the document; re-validate at emit) ──────────
  const selectedAgent = useMemo(
    () => ((content?.agents ?? []) as PackManifestAgent[]).find((a) => a.id === selectedAgentId) ?? null,
    [content?.agents, selectedAgentId],
  );
  // 4.1/4.4: kind 从持久正文读（缺省 team——存量文档零感知）。
  const docKind: "agent" | "team" = content?.kind === "agent" ? "agent" : "team";
  const docValid = verdict?.ok === true;

  const emitPreset = async () => {
    if (!doc || !selectedAgent || !docValid) return;
    setBusy("emit-preset");
    try {
      const mcp = (content?.mcpServers ?? []) as PackManifestMcp[];
      // 4.3: 技能桶从持久文档读（不再恒空丢桶）；岗位只挂文档声明的技能名。
      const skillNames = ((content?.skills ?? []) as PackManifestSkill[]).map((s) => s.name).filter(Boolean);
      await presetsApi.createCustomPreset({
        name: selectedAgent.name || selectedAgent.id,
        persona: selectedAgent.persona,
        skills: skillNames,
        mcpServers: mcp.map((m) => m.registryName),
        mcpTools: Object.fromEntries(mcp.filter((m) => m.allowTools?.length).map((m) => [m.registryName, m.allowTools!])),
      });
      showToast({ severity: "success", title: t("studio.emit.presetOk", { name: selectedAgent.name || selectedAgent.id }) });
    } catch (err) {
      showToast({ severity: "error", title: t("studio.emit.failed", { message: (err as Error).message }) });
    } finally {
      setBusy(null);
    }
  };

  const emitDraft = async () => {
    if (!doc || !docValid) return;
    setBusy("emit-draft");
    try {
      const c = content;
      // The open content shape carries the fork lineage we seeded at ?fork=
      // time; the packs API validates the provenance record itself.
      const prov = (c?.provenance as { forkOf?: { packId: string; version: number }; license?: string } | undefined)?.forkOf
        ? (c?.provenance as PackManifest["provenance"])
        : undefined;
      // 4.3: 名字/一句话两 kind 各自的落点（agent 在顶层，team 在 boundary）。
      const isAgent = (c?.kind ?? "team") === "agent";
      await packsApi.createPackDraft({
        name: (isAgent ? c?.name : c?.boundary?.name) ?? doc.name,
        description: (isAgent ? c?.description : c?.boundary?.oneLine) ?? doc.oneLine,
        tags: (c?.tags as string[] | undefined) ?? [],
        entries: {
          skills: ((c?.skills ?? []) as PackManifestSkill[]),
          mcpServers: (c?.mcpServers ?? []) as PackManifestMcp[],
          agents: (c?.agents ?? []) as PackManifestAgent[],
          ...(prov ? { provenance: prov } : {}),
        },
      });
      showToast({ severity: "success", title: t("studio.emit.draftOk") });
      navigate("/agents?tab=market");
    } catch (err) {
      showToast({ severity: "error", title: t("studio.emit.failed", { message: (err as Error).message }) });
    } finally {
      setBusy(null);
    }
  };

  // ── AI drafting ───────────────────────────────────────────────────────────
  const runAiDraft = async () => {
    setAi((s) => ({ ...s, busy: true, error: null, draft: null }));
    try {
      const r = await fetch("/api/studio/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "agent-doc", prompt: ai.prompt }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `draft failed (${r.status})`);
      setAi((s) => ({ ...s, busy: false, draft: d.draft }));
    } catch (err) {
      setAi((s) => ({ ...s, busy: false, error: (err as Error).message }));
    }
  };

  const adoptAi = (picked: Set<DraftField["key"]>, draft: Record<string, unknown>) => {
    if (!content) return;
    const next: BlueprintContent = { ...content };
    const b0 = { ...(content.boundary ?? {}) };
    if (picked.has("name") && typeof draft.name === "string" && draft.name.trim()) b0.name = draft.name;
    if (picked.has("description") && typeof draft.description === "string" && draft.description) b0.oneLine = draft.description;
    next.boundary = b0;
    const agents = [...((content.agents ?? []) as PackManifestAgent[])];
    if (picked.has("persona") && typeof draft.persona === "string") {
      const idx = Math.max(0, agents.findIndex((a) => a.id === selectedAgentId));
      if (agents[idx]) agents[idx] = { ...agents[idx], persona: draft.persona };
      else agents.push({ id: "agent-1", name: "", persona: draft.persona });
      next.agents = agents;
    }
    if (picked.has("mcpServers") && Array.isArray(draft.mcpServers) && draft.mcpServers.length) {
      const incoming = (draft.mcpServers as PackManifestMcp[]).filter((m) => m && typeof m.registryName === "string");
      const merged = [...((content.mcpServers ?? []) as PackManifestMcp[])];
      for (const m of incoming) if (!merged.some((x) => x.registryName === m.registryName)) merged.push({ registryName: m.registryName, ...(m.allowTools?.length ? { allowTools: m.allowTools } : {}) });
      next.mcpServers = merged;
    }
    patchContent(next);
    setAiOpen(false);
    setAi({ prompt: "", busy: false, draft: null, error: null });
  };

  // ── ribbon projection ─────────────────────────────────────────────────────
  const ribbonView = useMemo(() => {
    if (!doc) return null;
    const report = trialOf(doc);
    return teamRibbon(
      {
        status: doc.status,
        approvedBy: doc.approvedBy,
        castPackId: doc.castPackId,
        castPackVersion: doc.castPackVersion,
        trialRanAt: report?.ranAt ?? null,
        signedBy: report?.signoff?.by ?? null,
        signedMatches: report?.signoff?.reportRanAt != null && report?.signoff?.reportRanAt === report?.ranAt,
      },
      { verdictOk: docValid, userEmail, saving: saveState === "saving" || busy !== null },
    );
  }, [doc, docValid, userEmail, saveState, busy]);

  const totalTools = (registryName: string) => marketCatalog?.mcpServers?.find((s) => s.name === registryName)?.toolList?.length ?? null;

  const fleetMembers = useMemo<GraphMember[]>(() => {
    const fleet = content?.fleet as { members?: GraphMember[] } | undefined;
    return Array.isArray(fleet?.members) ? fleet!.members : [];
  }, [content?.fleet]);
  const fleetEdges = useMemo<GraphEdge[]>(() => {
    const fleet = content?.fleet as { orchestration?: { edges?: GraphEdge[] } } | undefined;
    return Array.isArray(fleet?.orchestration?.edges) ? fleet!.orchestration.edges : [];
  }, [content?.fleet]);

  const saveStateLabel =
    saveState === "clean" ? t("studio.workspace.saved", { version: doc?.version ?? 0 })
    : saveState === "dirty" ? t("studio.workspace.dirty")
    : saveState === "saving" ? t("studio.workspace.saving")
    : t("studio.workspace.conflictShort");

  return (
    <div className="relative flex h-full flex-col bg-background" data-testid="agent-studio">
      {/* ── Header: document identity + save state ── */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Link to="/agents?tab=build" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="ws-back">
          <ArrowLeft className="h-3.5 w-3.5" /> {t("studio.workspace.back")}
        </Link>
        <h2 className="text-sm font-medium">{t("studio.workspace.title")}</h2>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted lg:hidden" aria-label={t("studio.workspace.toggleLibrary")} data-testid="ws-toggle-library" onClick={() => setShowLibrary((v) => !v)}>
          <PanelLeft className="h-4 w-4" />
        </button>
        {doc && (
          <>
            <div className="mx-2 flex min-w-0 flex-1 items-center gap-2">
              <Input
                value={docKind === "agent" ? (content?.name ?? "") : (content?.boundary?.name ?? "")}
                onChange={(e) =>
                  docKind === "agent"
                    ? patchContent({ name: e.target.value })
                    : patchContent({ boundary: { ...content?.boundary, name: e.target.value } })
                }
                className="h-7 max-w-64 border-transparent bg-transparent px-1 text-sm font-medium hover:border-border focus-visible:border-border"
                placeholder={docKind === "agent" ? t("studio.blueprint.untitledAgent") : t("studio.blueprint.untitled")}
                data-testid="ws-doc-name"
                data-anchor="boundary.name"
              />
              <StatusPill status={DOC_STATUS_TONE[doc.status]} label={t(`studio.blueprint.status.${doc.status}`)} data-testid="ws-doc-status" />
              <span className="shrink-0 rounded-full border border-border px-1.5 py-0 text-[10px] text-muted-foreground" data-testid="ws-doc-kind">
                {t(`studio.workspace.kind.${docKind}`)}
              </span>
              {doc.castPackId && (
                <span className="truncate text-[11px] text-muted-foreground" data-testid="ws-cast-ref">
                  {t("studio.blueprint.castRef", { packId: doc.castPackId, version: doc.castPackVersion ?? "?" })}
                </span>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground" data-testid="ws-save-state">{saveStateLabel}</span>
          </>
        )}
        {!doc && <div className="flex-1" />}
        <Button size="sm" variant="outline" onClick={() => void createDoc("agent")} disabled={busy !== null} data-testid="ws-new-agent-entry">
          <Plus className="h-3.5 w-3.5" /> {t("studio.workspace.library.newAgent")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAiOpen((v) => !v)} data-testid="ws-ai-toggle">
          <Sparkles className="h-3.5 w-3.5" /> {t("studio.aiDraft.title")}
        </Button>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted xl:hidden" aria-label={t("studio.workspace.toggleInspector")} data-testid="ws-toggle-inspector" onClick={() => setShowInspector((v) => !v)}>
          <PanelRight className="h-4 w-4" />
        </button>
      </div>

      {/* ── Conflict banner (409): the user decides, nothing silent ── */}
      {conflict && doc && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-xs" data-testid="ws-conflict-banner">
          <span className="min-w-0 flex-1 text-destructive">{t("studio.workspace.conflict", { server: conflict.serverVersion, local: doc.version })}</span>
          <Button size="sm" variant="outline" onClick={() => void openDoc(doc.id)} data-testid="ws-conflict-reload">
            {t("studio.workspace.conflictReload")}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setOverwriteOpen(true)} data-testid="ws-conflict-overwrite">
            {t("studio.workspace.conflictOverwrite")}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={overwriteOpen}
        onOpenChange={setOverwriteOpen}
        variant="danger"
        title={t("studio.workspace.conflictOverwrite")}
        description={t("studio.workspace.conflictOverwriteConfirm")}
        confirmLabel={t("studio.workspace.conflictOverwrite")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          void (async () => {
            if (!doc || !content) return;
            try {
              const { blueprint } = await bp.getBlueprint(doc.id);
              await bp.updateBlueprint(doc.id, blueprint.version, content);
              await openDoc(doc.id);
              showToast({ severity: "success", title: t("studio.workspace.overwriteDone") });
            } catch (err) {
              showToast({ severity: "error", title: t("studio.workspace.saveFailed"), description: (err as Error).message });
            }
          })();
        }}
      />

      <div className="flex min-h-0 flex-1">
        {showLibrary && <DocumentLibrary docs={docs} activeId={doc?.id ?? null} onOpen={(id) => void openDoc(id)} onNew={(kind) => void createDoc(kind)} busy={busy !== null} />}

        {/* ── Canvas ── */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4" data-testid="ws-canvas">
          {!doc || !content ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center" data-testid="ws-canvas-empty">
              <Blocks className="h-8 w-8 text-muted-foreground" />
              <p className="max-w-md text-sm text-muted-foreground">{t("studio.workspace.canvas.empty")}</p>
              <Button size="sm" onClick={() => void createDoc("agent")} disabled={busy !== null} data-testid="ws-canvas-new">
                <Plus className="h-3.5 w-3.5" /> {t("studio.blueprint.new")}
              </Button>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-3">
              {/* form | json dual track — both land through the same PUT+chain */}
              <div className="flex gap-2 text-xs">
                {(["form", "json"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      if (k === "json") setJsonText(JSON.stringify(content, null, 2));
                      setTrack(k);
                    }}
                    className={cn("rounded-t-md px-3 py-1", track === k ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}
                    data-testid={`ws-track-${k}`}
                  >
                    {t(`studio.blueprint.track.${k}`)}
                  </button>
                ))}
              </div>

              {track === "form" ? (
                <>
                  <SectionCard title={t("studio.workspace.section.envelope")} testid="ws-envelope">
                    <div className="space-y-2">
                      <div data-anchor="boundary.oneLine">
                        <Field label={docKind === "agent" ? t("studio.workspace.agent.description") : t("studio.blueprint.boundary.oneLine")}>
                          <Input
                            value={docKind === "agent" ? (content.description ?? "") : (content.boundary?.oneLine ?? "")}
                            onChange={(e) =>
                              docKind === "agent"
                                ? patchContent({ description: e.target.value })
                                : patchContent({ boundary: { ...content.boundary, oneLine: e.target.value } })
                            }
                            data-testid="ws-field-oneline"
                          />
                        </Field>
                      </div>
                      {docKind === "team" && (
                        <div data-anchor="boundary.outOfScope">
                          <Field label={t("studio.blueprint.boundary.outOfScope")}>
                            <Textarea rows={2} value={content.boundary?.outOfScope ?? ""} onChange={(e) => patchContent({ boundary: { ...content.boundary, outOfScope: e.target.value } })} data-testid="ws-field-oos" />
                          </Field>
                        </div>
                      )}
                      <div data-anchor="tags">
                        <Field label={t("studio.doc.tags")}>
                          <Input
                            value={((content.tags as string[] | undefined) ?? []).join(", ")}
                            onChange={(e) => patchContent({ tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                            data-testid="ws-field-tags"
                          />
                        </Field>
                      </div>
                    </div>
                  </SectionCard>

                  <AgentBucketsEditor
                    value={{
                      agents: (content.agents ?? []) as PackManifestAgent[],
                      skills: (content.skills ?? []) as PackManifestSkill[],
                      mcpServers: (content.mcpServers ?? []) as PackManifestMcp[],
                    }}
                    showSkills
                    localSkills={localSkillsAll.filter((s) => s.source === "database" && s.enabled)}
                    catalogServers={marketCatalog?.mcpServers ?? []}
                    onChange={({ agents, skills, mcpServers }) => patchContent({ agents, skills, mcpServers })}
                    testIdPrefix="ws-bucket"
                    selectedAgentId={selectedAgentId}
                    onSelectAgent={setSelectedAgentId}
                  />

                  {docKind === "team" && (
                    <>
                      <SectionCard title={t("studio.team.tab")} testid="ws-graph" anchor="fleet">
                        <FleetGraph members={fleetMembers} edges={fleetEdges} kindLabels={{}} emptyLabel={t("studio.team.empty")} />
                        <p className="mt-2 text-[11px] text-muted-foreground">{t("studio.team.readOnlyHint")}</p>
                      </SectionCard>

                      <SectionCard title={t("studio.blueprint.judge")} testid="ws-judge" anchor="judgeModel">
                        <select
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                          value={content.judgeModel ?? ""}
                          onChange={(e) => patchContent({ judgeModel: e.target.value || undefined })}
                          data-testid="ws-field-judge"
                        >
                          <option value="">
                            {judgeDefault?.resolved
                              ? t("studio.blueprint.judgeFollows", { model: judgeDefault.resolved.model })
                              : t("studio.blueprint.judgeFollowDefault")}
                          </option>
                          {(modelRoster ?? []).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name || m.id}
                            </option>
                          ))}
                        </select>
                      </SectionCard>
                    </>
                  )}

                  {docKind === "team" && (
                    <SectionCard title={t("studio.blueprint.sources")} testid="ws-sources" anchor="dataSources">
                    <div className="space-y-1">
                      {(content.dataSources ?? []).map((s, i) => (
                        /* biome-ignore lint/suspicious/noArrayIndexKey: positional rows of an ordered ref list */
                        <div key={i} className="flex items-center gap-2">
                          <select
                            className="max-w-44 rounded-md border border-border bg-background px-2 py-1 text-xs"
                            value={s.ref.startsWith("library:") ? s.ref : ""}
                            onChange={(e) => {
                              if (!e.target.value) return;
                              const sources = [...(content.dataSources ?? [])];
                              sources[i] = { ref: e.target.value };
                              patchContent({ dataSources: sources });
                            }}
                            data-testid={`ws-source-${i}`}
                          >
                            <option value="">{s.ref || t("studio.blueprint.pickCollection")}</option>
                            {collections.map((c) => (
                              <option key={c.id} value={`library:${c.id}`}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t("studio.remove")}
                            onClick={() => patchContent({ dataSources: (content.dataSources ?? []).filter((_, j) => j !== i) })}
                          >
                            ×
                          </Button>
                        </div>
                      ))}
                      <select
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                        value=""
                        onChange={(e) => {
                          if (!e.target.value) return;
                          patchContent({ dataSources: [...(content.dataSources ?? []), { ref: e.target.value }] });
                        }}
                        data-testid="ws-source-add"
                      >
                        <option value="">{t("studio.blueprint.pickCollection")}</option>
                        {collections.map((c) => (
                          <option key={c.id} value={`library:${c.id}`}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    </SectionCard>
                  )}

                  <p className="text-[11px] text-muted-foreground">{t("studio.blueprint.jsonHint")}</p>
                </>
              ) : (
                <div>
                  <Textarea
                    rows={24}
                    value={jsonText}
                    onChange={(e) => setJsonText(e.target.value)}
                    className="font-mono text-xs"
                    data-testid="ws-json"
                  />
                  {jsonError && <p className="mt-1 text-xs text-destructive">{jsonError}</p>}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    data-testid="ws-json-apply"
                    onClick={() => {
                      try {
                        const parsed = JSON.parse(jsonText) as BlueprintContent;
                        setJsonError(null);
                        setTrack("form");
                        patchContent(parsed);
                      } catch (err) {
                        setJsonError((err as Error).message);
                      }
                    }}
                  >
                    {t("studio.blueprint.jsonApply")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </main>

        {/* ── Inspector: ribbon / spec sheet / validation / emit ── */}
        {showInspector && (
          <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-3" data-testid="ws-inspector">
            {doc && docKind === "team" && ribbonView && <LifecycleRibbon view={ribbonView} onAction={onRibbonAction} busy={busy !== null} trialRunning={trialRunning} />}
            {doc && docKind === "agent" && (
              // 4.4: agent 文档没有团队档位——始终草稿 + 两发射口常驻（服务端
              // approve/cast 409 同源），此处只如实说明，不画假进度。
              <div className="rounded-md border border-border p-3" data-testid="ws-agent-draft-card">
                <div className="flex items-center gap-2">
                  <StatusPill status={DOC_STATUS_TONE[doc.status]} label={t(`studio.blueprint.status.${doc.status}`)} />
                  <span className="text-[10px] text-muted-foreground">{t("studio.workspace.kind.agent")}</span>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">{t("studio.workspace.agent.hint")}</p>
              </div>
            )}
            {doc && (
              <>
                <AgentSpecSheet
                  variant="full"
                  testIdPrefix="ws-spec"
                  lineage={((content?.provenance as { forkOf?: { packId: string; version: number } } | undefined)?.forkOf) ?? null}
                  roles={((content?.agents ?? []) as PackManifestAgent[]).map((a) => ({ id: a.id, name: a.name, persona: a.persona, serving: a.serving != null }))}
                  skills={null}
                  mcp={((content?.mcpServers ?? []) as PackManifestMcp[]).map((m) => ({ ...m, totalTools: totalTools(m.registryName) }))}
                />
                <ValidationPanel verdict={verdict} verifying={verifying} />
                <div className="space-y-2 border-t border-border pt-3" data-testid="ws-emit">
                  <p className="text-xs font-medium text-muted-foreground">{t("studio.workspace.emit.section")}</p>
                  <Tooltip content={docValid ? "" : t("studio.workspace.emit.needGreen")}>
                    <span className="block">
                      <Button size="sm" className="w-full" disabled={!docValid || !selectedAgent || busy !== null} onClick={() => void emitPreset()} data-testid="ws-emit-preset">
                        {busy === "emit-preset" ? t("studio.emit.busy") : t("studio.emit.preset")}
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip content={docValid ? "" : t("studio.workspace.emit.needGreen")}>
                    <span className="block">
                      <Button size="sm" variant="outline" className="w-full" disabled={!docValid || !(content?.agents?.length) || busy !== null} onClick={() => void emitDraft()} data-testid="ws-emit-draft">
                        {busy === "emit-draft" ? t("studio.emit.busy") : t("studio.emit.draft")}
                      </Button>
                    </span>
                  </Tooltip>
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      {/* ── AI drafting overlay (right-docked; the canvas never squeezes) ── */}
      {aiOpen && (
        <AiDraftOverlay
          prompt={ai.prompt}
          onPrompt={(v) => setAi((s) => ({ ...s, prompt: v }))}
          busy={ai.busy}
          error={ai.error}
          draft={ai.draft}
          onRun={() => void runAiDraft()}
          onClose={() => {
            setAiOpen(false);
            setAi({ prompt: "", busy: false, draft: null, error: null });
          }}
          onAdopt={adoptAi}
        />
      )}
    </div>
  );
}
