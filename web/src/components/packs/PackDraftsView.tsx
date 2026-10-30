// PackDraftsView — the creator side (add-pack-marketplace): draft list plus
// the pack editor. Skill entries edit inline (custom-skill conventions); MCP
// entries are PICKED from the cell's registry-sourced market catalog (no
// free-form URL/command field anywhere — the v1 content boundary); agent
// entries are persona-only. Publish pushes the manifest to the gateway and
// stays editable for the next version; the first publish also records the
// pack id on the draft so later publishes append versions.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDraft, PackManifest, PackManifestAgent, PackManifestBot, PackManifestSkill } from "@/lib/packs-api";
import { takeBridgeHandoff } from "@/lib/pack-draft-bridge";
import type { BridgeReport } from "@/lib/pack-draft-bridge";
import { RhythmEditor } from "./RhythmEditor";
import type { RhythmEntry } from "./RhythmEditor";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { seedSkillPackage } from "@platform/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "./Badge";
import { Switch } from "@/components/ui/switch";
import { Upload } from "lucide-react";

const emptyEntries = { skills: [], mcpServers: [], agents: [] };

// Client-side stable keys for editable list entries (skills/agents may share
// a name or be blank while editing; the key never leaves the editor).
let uid = 0;
const nextKey = () => `e${++uid}`;
const withKeys = <T,>(items: T[]) => items.map((v) => ({ key: nextKey(), value: v }));

export function PackDraftsView({ onPublished }: { onPublished?: () => void }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<PackDraft[]>([]);
  const [editing, setEditing] = useState<PackDraft | null>(null);
  const [bridgeReport, setBridgeReport] = useState<BridgeReport | null>(null);
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setDrafts((await api.listPackDrafts()).drafts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A preset-conversion handoff (add-preset-to-pack-bridge): open the converted
  // draft directly and surface the migratability report once. The handoff is
  // consumed here — a later plain visit shows no banner.
  useEffect(() => {
    const handoff = takeBridgeHandoff();
    if (handoff) {
      setBridgeReport(handoff.report);
      setOpenDraftId(handoff.draftId);
    }
  }, []);
  // The open lands when the list refresh delivers the converted draft.
  useEffect(() => {
    if (!openDraftId || editing) return;
    const found = drafts.find((d) => d.id === openDraftId);
    if (found) {
      setEditing(found);
      setOpenDraftId(null);
    }
  }, [drafts, openDraftId, editing]);

  const createDraft = async () => {
    try {
      const { draft } = await api.createPackDraft({ name: t("packs.drafts.defaultName"), entries: emptyEntries });
      await refresh();
      setEditing(draft);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (editing) {
    return (
      <PackDraftEditor
        draft={editing}
        bridgeReport={bridgeReport}
        onClose={() => {
          setEditing(null);
          setBridgeReport(null);
          void refresh();
        }}
        onPublished={(d) => {
          setEditing(d);
          onPublished?.();
        }}
        onImported={(d) => {
          // A bundle came back as a NEW draft: open it for editing and
          // refresh the list behind the dialog.
          void refresh();
          setEditing(d);
        }}
      />
    );
  }

  return (
    <section data-testid="pack-drafts-section">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground">{t("packs.drafts.title")}</h2>
        <Button size="sm" onClick={() => void createDraft()} data-testid="pack-draft-create">
          {t("packs.drafts.create")}
        </Button>
      </div>
      {error && <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md mb-4">{error}</div>}
      {loading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
      {!loading && drafts.length === 0 && (
        <div>
          <p className="text-sm text-muted-foreground">{t("packs.drafts.empty")}</p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="pack-drafts-builder-pointer">
            {t("packs.draftsBuilderPointer")}
          </p>
        </div>
      )}
      <div className="grid gap-3">
        {drafts.map((d) => (
          <button
            key={d.id}
            onClick={() => setEditing(d)}
            data-testid={`pack-draft-item-${d.id}`}
            className="text-left border border-border rounded-lg p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{d.name}</span>
              {d.publishedPackId ? (
                <Badge>{t("packs.drafts.published")}</Badge>
              ) : (
                <Badge>{t("packs.drafts.draft")}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("packs.drafts.partCounts", {
                skills: d.entries.skills?.length ?? 0,
                mcp: d.entries.mcpServers?.length ?? 0,
                agents: d.entries.agents?.length ?? 0,
              })}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}

// The ONE draft → manifest compiler (add-offline-pack-authoring).
//
// Publish and export must carry the SAME manifest — the export path used to
// assemble its own (and silently dropped bots/guide), which broke the very
// "single assembly source" rule this change set out to honour. Both callers
// now go through here.
export function compileDraftManifest(
  draft: PackDraft,
  visibility: "public" | "private",
): PackManifest {
  const entries = draft.entries as PackDraft["entries"] & {
    guide?: { steps: { title: string; body: string }[] };
    bots?: PackManifestBot[];
  };
  // The guide travels ONLY when all three steps are complete — the server
  // validator rejects a malformed one outright.
  const [s0, s1, s2] = entries.guide?.steps ?? [];
  const completeGuide =
    s0 && s1 && s2 && s0.title && s1.title && s2.title && s0.body && s1.body && s2.body
      ? { guide: { steps: [s0, s1, s2] as [{ title: string; body: string }, { title: string; body: string }, { title: string; body: string }] } }
      : {};
  return {
    name: draft.name,
    description: draft.description,
    visibility,
    tags: draft.tags,
    ...completeGuide,
    skills: entries.skills ?? [],
    mcpServers: entries.mcpServers ?? [],
    agents: entries.agents ?? [],
    ...(Array.isArray(entries.bots) && entries.bots.length > 0 ? { bots: entries.bots } : {}),
  };
}

function PackDraftEditor({
  draft,
  bridgeReport,
  onClose,
  onPublished,
  onImported,
}: {
  draft: PackDraft;
  bridgeReport?: BridgeReport | null;
  onClose: () => void;
  onPublished: (updated: PackDraft) => void;
  onImported?: (draft: PackDraft) => void;
}) {
  const { t } = useTranslation();
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  // Usage guide draft (add-pack-tutorials-and-wizard): three authored steps
  // riding the entries JSON; publish lifts a COMPLETE guide into the manifest.
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideSteps, setGuideSteps] = useState<{ title: string; body: string }[]>(() => {
    const g = (draft.entries as { guide?: { steps?: { title: string; body: string }[] } }).guide;
    return [0, 1, 2].map((i) => ({ title: g?.steps?.[i]?.title ?? "", body: g?.steps?.[i]?.body ?? "" }));
  });
  // Visibility (add-agent-platform-ops): pack-level exposure, author-picked
  // at publish; remembered across editing sessions.
  const [visibility, setVisibility] = useState<"public" | "private">(
    (draft as { visibility?: "public" | "private" }).visibility === "private" ? "private" : "public",
  );
  const [tags, setTags] = useState(draft.tags.join(", "));
  const [skills, setSkills] = useState(() => withKeys(draft.entries.skills ?? []));
  const [mcpPicked, setMcpPicked] = useState<string[]>((draft.entries.mcpServers ?? []).map((m) => m.registryName));
  // Tool allowlists (add-mcp-tool-scoping): server name → selected tool leaf
  // names; a server absent from the map (or an empty array cleared by the
  // author) publishes WITHOUT an allowlist = the full tool surface.
  const [mcpTools, setMcpTools] = useState<Record<string, string[]>>(() => {
    const init: Record<string, string[]> = {};
    for (const m of draft.entries.mcpServers ?? []) {
      if (m.registryName && Array.isArray(m.allowTools) && m.allowTools.length > 0) init[m.registryName] = [...m.allowTools];
    }
    return init;
  });
  // Full-surface markers (pack-tool-declaration-gate D5): server → reason.
  // Only meaningful while that reference selects no tools — the two are
  // mutually exclusive, so a tool selection wins on save.
  const [fullSurfaceReasons, setFullSurfaceReasons] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const m of draft.entries.mcpServers ?? []) {
      if (m.registryName && m.fullSurface === true) init[m.registryName] = m.fullSurfaceReason ?? "";
    }
    return init;
  });
  const [toolsOpenFor, setToolsOpenFor] = useState<string | null>(null);
  const [agents, setAgents] = useState(() => withKeys(draft.entries.agents ?? []));
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<string | null>(null);

  useEffect(() => {
    refreshMarketCatalog();
  }, [refreshMarketCatalog]);

  // The picker lists registry-sourced market entries only (spec:
  // pack-authoring — no free-form endpoint or command entry exists).
  const registryMcp = (marketCatalog?.mcpServers ?? []).filter((s) => s.origin === "registry");

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { draft: updated } = await api.updatePackDraft(draft.id, {
        name,
        description,
        tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
        entries: {
          skills: skills.map((e) => e.value),
          mcpServers: mcpPicked.map((registryName) => {
            const tools = mcpTools[registryName] ?? [];
            if (tools.length > 0) return { registryName, allowTools: tools };
            if (registryName in fullSurfaceReasons) {
              return { registryName, fullSurface: true, fullSurfaceReason: fullSurfaceReasons[registryName] ?? "" };
            }
            return { registryName };
          }),
          agents: agents.map((e) => e.value),
          // Guide rides the entries JSON. SAVE keeps steps as authored (even
          // partial — authors lose nothing across sessions); PUBLISH lifts a
          // guide only when all three steps are complete (see publish()).
          ...((steps: { title: string; body: string }[]) =>
            steps.some((st) => st.title || st.body)
              ? { guide: { steps } as { steps: { title: string; body: string }[] } }
              : {})(
            guideSteps.map((st) => ({ title: st.title.trim(), body: st.body.trim() })),
          ),
        },
      });
      Object.assign(draft, updated);
      return updated;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setError(null);
    setPublishResult(null);
    // Publish-time face check (pack-tool-declaration-gate D5): every reference
    // needs an allowlist or a reasoned full-surface marker. Drafts still save
    // without one; publishing names the servers that have not decided yet.
    const missingFace = mcpPicked.filter((registryName) => {
      if ((mcpTools[registryName] ?? []).length > 0) return false;
      if (!(registryName in fullSurfaceReasons)) return true;
      return (fullSurfaceReasons[registryName] ?? "").trim().length === 0;
    });
    if (missingFace.length > 0) {
      setError(t("packs.editor.toolsFaceRequired", { servers: missingFace.join(", ") }));
      return;
    }
    setPublishing(true);
    try {
      const updated = await save();
      if (!updated) return;
      // ONE compiler for publish and export (see compileDraftManifest).
      const manifest = compileDraftManifest(updated, visibility);
      const r = await api.publishPack({ packId: draft.publishedPackId, manifest });
      if (!draft.publishedPackId) {
        const { draft: marked } = await api.markDraftPublished(draft.id, r.id);
        Object.assign(draft, marked);
      }
      setPublishResult(t("packs.editor.publishOk", { version: r.version }));
      onPublished({ ...draft, ...updated, publishedPackId: draft.publishedPackId ?? r.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <section data-testid="pack-editor" className="space-y-4">
      {/* Conversion report (add-preset-to-pack-bridge): what came over from the
          preset and what the author must replace — shown once, never stored. */}
      {bridgeReport && (bridgeReport.pendingSkills.length > 0 || bridgeReport.pendingServers.length > 0) && (
        <div
          data-testid="pack-bridge-report"
          className="border border-amber-500/40 bg-amber-500/5 rounded-md p-3 space-y-1"
        >
          <p className="text-xs font-medium text-foreground">
            {t("packs.bridge.title", {
              skills: bridgeReport.inlinedSkills.length,
              servers: bridgeReport.mcpServers.length,
            })}
          </p>
          {bridgeReport.pendingSkills.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4">
              {bridgeReport.pendingSkills.map((s) => (
                <li key={`sk-${s.name}`} data-testid={`pack-bridge-pending-skill-${s.name}`}>
                  {s.name} — {s.pack ? t("packs.bridge.reason.pack", { pack: s.pack }) : t("packs.bridge.reason.unavailable")}
                </li>
              ))}
            </ul>
          )}
          {bridgeReport.pendingServers.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4">
              {bridgeReport.pendingServers.map((s) => (
                <li key={`mc-${s.name}`} data-testid={`pack-bridge-pending-server-${s.name}`}>
                  {s.name} — {t(`packs.bridge.reason.${s.reason}`)}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t("packs.bridge.replaceHint")}</p>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">{t("packs.editor.title")}</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving}>
            {t("packs.editor.save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || publishing}
            data-testid="pack-draft-export"
            onClick={async () => {
              // Offline authoring (add-offline-pack-authoring): the SAME
              // manifest the publish path would carry, validated server-side,
              // returned as a `.yizpack` download. Export is NOT publish —
              // nothing is minted, frozen, or gated.
              setExporting(true);
              setError(null);
              try {
                // save() returns the persisted draft — no second fetch needed.
                const updated = await save();
                if (!updated) return; // save() already surfaced the error
                // Same compiler as publish — bots/guide included, no second
                // assembly path to drift from.
                const manifest = compileDraftManifest(updated, visibility);
                // An already-published draft exports under its pack id; the
                // SERVER resolves the version from this machine's installed
                // snapshot (a bundle that dropped back to 1 would install as a
                // silent downgrade elsewhere).
                const r = await api.exportPackDraft(draft.id, {
                  manifest,
                  ...(draft.publishedPackId ? { packId: draft.publishedPackId } : {}),
                });
                const bin = atob(r.bundle);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
                const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
                const a = document.createElement("a");
                a.href = url;
                a.download = r.fileName;
                // Attach before clicking: headless Chromium does not reliably
                // start a download from a detached anchor.
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                setExportResult(t("packs.editor.exportOk", { file: r.fileName }));
              } catch (err) {
                setExportResult((err as Error).message);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? t("packs.editor.exporting") : t("packs.editor.export")}
          </Button>
          <label className="cursor-pointer">
            <input
              type="file"
              accept=".yizpack,application/zip"
              className="hidden"
              data-testid="pack-draft-import-input"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setImporting(true);
                setError(null);
                try {
                  const buf = new Uint8Array(await file.arrayBuffer());
                  const bin = Array.from(buf, (b) => String.fromCharCode(b)).join("");
                  const r = await api.importPackDraftBundle({ bundle: btoa(bin) });
                  setImportResult(t("packs.editor.importOk", { name: r.draft.name }));
                  onImported?.(r.draft);
                } catch (err) {
                  setImportResult((err as Error).message);
                } finally {
                  setImporting(false);
                }
              }}
            />
            <span
              role="button"
              tabIndex={0}
              className="inline-flex h-8 items-center rounded-md border border-input bg-transparent px-3 text-sm font-medium hover:bg-muted"
              data-testid="pack-draft-import"
            >
              {importing ? t("packs.editor.importing") : t("packs.editor.import")}
            </span>
          </label>
          <Button size="sm" onClick={() => void publish()} disabled={publishing} data-testid="pack-draft-publish">
            {t("packs.editor.publish")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </div>

      {error && <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md" data-testid="pack-editor-error" role="alert">{error}</div>}
      {publishResult && (
        <div className="bg-primary/10 text-primary px-4 py-3 rounded-md" data-testid="pack-publish-ok">
          {publishResult}
        </div>
      )}
      {exportResult && (
        <div className="bg-muted px-4 py-3 rounded-md text-sm" data-testid="pack-export-result">
          {exportResult}
        </div>
      )}
      {importResult && (
        <div className="bg-muted px-4 py-3 rounded-md text-sm" data-testid="pack-import-result">
          {importResult}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="pack-name">{t("packs.editor.name")}</Label>
          <Input id="pack-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pack-tags">{t("packs.editor.tags")}</Label>
          <Input
            id="pack-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={t("packs.editor.tagsPlaceholder")}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="pack-desc">{t("packs.editor.description")}</Label>
        <Textarea id="pack-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />

        {/* Usage guide (add-pack-tutorials-and-wizard): three authored steps,
            carried into the published manifest verbatim. */}
        <div>
          <button
            type="button"
            onClick={() => setGuideOpen((v) => !v)}
            aria-expanded={guideOpen}
            data-testid="pack-guide-editor-toggle"
            className="text-sm font-medium text-foreground hover:underline"
          >
            {t("packs.editor.guide.title")} {guideOpen ? "▾" : "▸"}
          </button>
          {guideOpen && (
            <div className="mt-2 space-y-3" data-testid="pack-guide-editor">
              <p className="text-xs text-muted-foreground">{t("packs.editor.guide.hint")}</p>
              {guideSteps.map((st, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: three fixed positional slots — the index is the step number
                <div key={`step-${i + 1}`} className="space-y-1 rounded-md border border-border p-2">
                  <Input
                    value={st.title}
                    maxLength={60}
                    onChange={(e) =>
                      setGuideSteps((gs) => gs.map((g, j) => (j === i ? { ...g, title: e.target.value } : g)))
                    }
                    placeholder={t("packs.editor.guide.stepTitle", { n: i + 1 })}
                    data-testid={`pack-guide-title-${i}`}
                  />
                  <Textarea
                    value={st.body}
                    maxLength={500}
                    rows={2}
                    onChange={(e) =>
                      setGuideSteps((gs) => gs.map((g, j) => (j === i ? { ...g, body: e.target.value } : g)))
                    }
                    placeholder={t("packs.editor.guide.stepBody", { n: i + 1 })}
                    data-testid={`pack-guide-body-${i}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    {st.title.length}/60 · {st.body.length}/500
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2">
          <Label htmlFor="pack-visibility">{t("packs.editor.visibility")}</Label>
          <select
            id="pack-visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value === "private" ? "private" : "public")}
            className="border border-border rounded px-1.5 py-1 text-xs bg-background"
            data-testid="pack-visibility"
          >
            <option value="public">{t("packs.editor.visibilityPublic")}</option>
            <option value="private">{t("packs.editor.visibilityPrivate")}</option>
          </select>
        </div>
      </div>

      {/* Skills */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground">{t("packs.editor.skills")}</h3>
          <div className="flex items-center gap-2">
            {/* Direct zip upload (add-packaged-skills 4.4): a skill entry may be
                seeded from a local package through the same server-side parse
                the settings surface uses — files ride the entry verbatim. */}
            <SkillPackageSeedButton
              onSeed={(seed) => setSkills([...skills, { key: nextKey(), value: seed }])}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSkills([...skills, { key: nextKey(), value: { name: "", description: "", content: "" } }])}
              data-testid="pack-skill-add"
            >
              {t("packs.editor.addSkill")}
            </Button>
          </div>
        </div>
        <div className="space-y-3">
          {skills.map((entry, i) => (
            <div key={entry.key} className="border border-border rounded-md p-3 space-y-2" data-testid={`pack-skill-entry-${i}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <Input
                  value={entry.value.name}
                  onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, name: e.target.value } } : x)))}
                  placeholder={t("packs.editor.skillName")}
                />
                <Input
                  value={entry.value.description}
                  onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, description: e.target.value } } : x)))}
                  placeholder={t("packs.editor.skillDescription")}
                />
              </div>
              {entry.value.files && Object.keys(entry.value.files).length > 0 && (
                <p className="text-xs text-muted-foreground" data-testid={`pack-skill-files-${i}`}>
                  {t("packs.editor.skillFiles", {
                    count: Object.keys(entry.value.files).length,
                    paths: Object.keys(entry.value.files).slice(0, 4).join("、"),
                  })}
                  {Object.keys(entry.value.files).length > 4 ? " …" : ""}
                </p>
              )}
              <Textarea
                value={entry.value.content}
                onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, value: { ...x.value, content: e.target.value } } : x)))}
                rows={6}
                placeholder={t("packs.editor.skillContent")}
                className="font-mono text-xs"
              />
              <Button size="sm" variant="ghost" onClick={() => setSkills(skills.filter((_, j) => j !== i))}>
                {t("packs.editor.remove")}
              </Button>
            </div>
          ))}
        </div>
      </section>

      {/* MCP picker */}
      <section>
        <h3 className="font-medium text-foreground mb-2">{t("packs.editor.mcp")}</h3>
        <p className="text-xs text-muted-foreground mb-2">{t("packs.editor.mcpHint")}</p>
        {registryMcp.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("packs.editor.mcpEmpty")}</p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="pack-mcp-picker">
            {registryMcp.map((s) => {
              const on = mcpPicked.includes(s.name);
              return (
                <button
                  key={s.name}
                  onClick={() =>
                    setMcpPicked(on ? mcpPicked.filter((n) => n !== s.name) : [...mcpPicked, s.name])
                  }
                  className={`border rounded-full px-3 py-1 text-xs transition-colors ${
                    on ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"
                  }`}
                  data-testid={`pack-mcp-option-${s.name}`}
                >
                  {s.displayName || s.name}
                </button>
              );
            })}
          </div>
        )}
        {/* Tool allowlists per picked reference (add-mcp-tool-scoping): names
            come from the catalog's tool-surface snapshot — picker-only, no
            free-form entry; an empty selection = the full tool surface. */}
        {mcpPicked.length > 0 && (
          <div className="space-y-2 mt-3" data-testid="pack-mcp-tools">
            {mcpPicked.map((name) => {
              const entry = registryMcp.find((s) => s.name === name);
              const toolList = entry?.toolList ?? [];
              const selected = mcpTools[name] ?? [];
              const open = toolsOpenFor === name;
              return (
                <div key={`tools-${name}`} className="border border-border rounded-md p-2" data-testid={`pack-mcp-tools-row-${name}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">{entry?.displayName || name}</span>
                    <span className="text-xs text-muted-foreground" data-testid={`pack-mcp-tools-count-${name}`}>
                      {selected.length > 0
                        ? t("packs.editor.toolsN", { n: selected.length })
                        : t("packs.editor.toolsAll")}
                    </span>
                    {toolList.length > 0 && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 px-2 text-xs"
                          onClick={() => setToolsOpenFor(open ? null : name)}
                          data-testid={`pack-mcp-tools-toggle-${name}`}
                        >
                          {open ? t("packs.editor.toolsCollapse") : t("packs.editor.toolsEdit")}
                        </Button>
                        {selected.length > 0 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs"
                            onClick={() =>
                              setMcpTools((prev) => {
                                const next = { ...prev };
                                delete next[name];
                                return next;
                              })
                            }
                            data-testid={`pack-mcp-tools-clear-${name}`}
                          >
                            {t("packs.editor.toolsClear")}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                  {selected.length === 0 && (
                    <div className="mt-2 space-y-1" data-testid={`pack-mcp-full-surface-${name}`}>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                          checked={name in fullSurfaceReasons}
                          onCheckedChange={(on) =>
                            setFullSurfaceReasons((prev) => {
                              const next = { ...prev };
                              if (on) next[name] = prev[name] ?? "";
                              else delete next[name];
                              return next;
                            })
                          }
                          data-testid={`pack-mcp-full-toggle-${name}`}
                        />
                        {t("packs.editor.toolsMarkFull")}
                      </label>
                      {name in fullSurfaceReasons && (
                        <Input
                          value={fullSurfaceReasons[name] ?? ""}
                          onChange={(e) => setFullSurfaceReasons((prev) => ({ ...prev, [name]: e.target.value }))}
                          aria-label={t("packs.editor.toolsFullReason")}
                          placeholder={t("packs.editor.toolsFullReasonPlaceholder")}
                          data-testid={`pack-mcp-full-reason-${name}`}
                        />
                      )}
                    </div>
                  )}
                  {open && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {toolList.map((tool) => {
                        const on = selected.includes(tool);
                        return (
                          <button
                            key={tool}
                            onClick={() =>
                              setMcpTools((prev) => ({
                                ...prev,
                                [name]: on ? (prev[name] ?? []).filter((t2) => t2 !== tool) : [...(prev[name] ?? []), tool],
                              }))
                            }
                            className={`border rounded-full px-2 py-0.5 text-[10px] font-mono transition-colors ${
                              on ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"
                            }`}
                            data-testid={`pack-mcp-tool-${name}-${tool}`}
                          >
                            {tool}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {toolList.length === 0 && (
                    <p className="text-xs text-muted-foreground mt-1">{t("packs.editor.toolsNoSnapshot")}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Agents (persona-only) */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground">{t("packs.editor.agents")}</h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAgents([...agents, { key: nextKey(), value: { id: "", name: "", persona: "" } }])}
            data-testid="pack-agent-add"
          >
            {t("packs.editor.addAgent")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2">{t("packs.editor.agentHint")}</p>
        <div className="space-y-3">
          {agents.map((entry, i) => (
            <div key={entry.key} className="border border-border rounded-md p-3 space-y-2" data-testid={`pack-agent-entry-${i}`}>
              <div className="grid gap-2 md:grid-cols-2">
                <Input
                  value={entry.value.id}
                  onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, id: e.target.value } } : x)))}
                  placeholder={t("packs.editor.agentId")}
                />
                <Input
                  value={entry.value.name}
                  onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, name: e.target.value } } : x)))}
                  placeholder={t("packs.editor.agentName")}
                />
              </div>
              <Textarea
                value={entry.value.persona}
                onChange={(e) => setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, persona: e.target.value } } : x)))}
                rows={3}
                placeholder={t("packs.editor.agentPersona")}
              />
              {/* Persona cost readout (D6): guidance, not a cap — a persona
                  bills every turn, so its size is a per-turn cost decision. */}
              <p className="text-xs text-muted-foreground" data-testid={`pack-agent-cost-${i}`}>
                {t("packs.editor.personaCost", {
                  chars: entry.value.persona.length,
                  tokens: Math.ceil(entry.value.persona.length / 3),
                })}
              </p>
              {/* Serving contract (add-a2a-agent-serving): declaring the role
                  deployable as an Agent Service. The contract carries no
                  configuration (model/credentials are deployment concerns);
                  absent card fields derive from name/description/tags at
                  deploy time. */}
              <label className="flex items-start gap-2 text-xs" data-testid={`pack-agent-serving-toggle-${i}`}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={!!entry.value.serving}
                  onChange={(e) =>
                    setAgents(
                      agents.map((x, j) =>
                        j === i
                          ? {
                              ...x,
                              value: {
                                ...x.value,
                                ...(e.target.checked
                                  ? { serving: { protocol: "a2a" } }
                                  : { serving: undefined }),
                              },
                            }
                          : x,
                      ),
                    )
                  }
                />
                <span>
                  {t("packs.editor.agentServing")}
                  <span className="block text-muted-foreground">{t("packs.editor.agentServingHint")}</span>
                </span>
              </label>
              {entry.value.serving && (
                <div className="border border-border rounded-md p-2 space-y-1.5" data-testid={`pack-agent-rhythm-${i}`}>
                  <p className="text-xs font-medium">{t("packs.rhythm.title")}</p>
                  <RhythmEditor
                    value={(entry.value.serving.rhythm ?? []) as RhythmEntry[]}
                    onChange={(rhythm) =>
                      setAgents(
                        agents.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                value: {
                                  ...x.value,
                                  serving: { ...x.value.serving!, rhythm: rhythm.length > 0 ? rhythm : undefined },
                                },
                              }
                            : x,
                        ),
                      )
                    }
                    testIdPrefix={`pack-agent-rhythm-editor-${i}`}
                  />
                </div>
              )}
              <AgentResourcesPicker
                index={i}
                value={entry.value}
                ownSkillNames={skills.map((s) => s.value.name.trim()).filter(Boolean)}
                ownMcpNames={mcpPicked}
                onChange={(resources) =>
                  setAgents(agents.map((x, j) => (j === i ? { ...x, value: { ...x.value, resources } } : x)))
                }
              />
              <Button size="sm" variant="ghost" onClick={() => setAgents(agents.filter((_, j) => j !== i))}>
                {t("packs.editor.remove")}
              </Button>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

// Direct zip upload seed button (add-packaged-skills 4.4): the editor's skill
// entry may be seeded from a local package through the same server-side parse
// the settings surface uses — the whole tree (files/frontmatter) rides the
// draft entry verbatim into the published manifest.
function SkillPackageSeedButton({ onSeed }: { onSeed: (seed: PackManifestSkill) => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (f: File | null) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      const seed = await seedSkillPackage(f);
      onSeed({
        name: seed.name,
        description: seed.description ?? "",
        content: seed.content,
        ...(seed.files ? { files: seed.files } : {}),
        ...(seed.frontmatter ? { frontmatter: seed.frontmatter } : {}),
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label
        className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-input px-3 text-sm hover:bg-accent"
        data-testid="pack-skill-upload-package"
      >
        <Upload className="h-4 w-4" />
        {busy ? t("common.loading") : t("packs.editor.uploadSkillPackage")}
        <input
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            void handleFile(e.target.files?.[0] ?? null);
            e.target.value = "";
          }}
          data-testid="pack-skill-upload-input"
        />
      </label>
      {error && (
        <span className="text-xs text-destructive" data-testid="pack-skill-upload-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

// Per-role resource declaration picker (add-persona-resource-sets D6). Chip
// sources are the draft's OWN entries only — no free-form name input exists,
// so a declaration can never name a foreign resource (the server re-validates
// anyway). Dimension semantics mirror the manifest: a dimension left
// UNCHECKED is absent (= the role uses the whole pack's set for it); checked,
// the chip selection is the set (none checked = none). Enabling a dimension
// pre-selects everything — the equivalent of today's whole-pack behavior —
// and dropping both dimensions removes `resources` entirely (undeclared).
function AgentResourcesPicker({
  index,
  value,
  ownSkillNames,
  ownMcpNames,
  onChange,
}: {
  index: number;
  value: PackManifestAgent;
  ownSkillNames: string[];
  ownMcpNames: string[];
  onChange: (resources: PackManifestAgent["resources"]) => void;
}) {
  const { t } = useTranslation();
  const resources = value.resources;
  const skillsOn = Array.isArray(resources?.skills);
  const mcpOn = Array.isArray(resources?.mcpServers);
  // Auto-expand once a declaration exists, but let the author collapse it —
  // `open` must survive unrelated re-renders (typing in the persona textarea
  // re-renders this entry on every keystroke).
  const [open, setOpen] = useState(skillsOn || mcpOn);

  const setDimension = (dim: "skills" | "mcpServers", on: boolean, all: string[]) => {
    let next: PackManifestAgent["resources"] = { ...resources };
    if (on) next[dim] = [...all];
    else delete next[dim];
    if (!next.skills && !next.mcpServers) next = undefined;
    onChange(next);
  };
  const toggleChip = (dim: "skills" | "mcpServers", name: string) => {
    const current = resources?.[dim] ?? [];
    onChange({
      ...resources,
      [dim]: current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    });
  };

  const chips = (dim: "skills" | "mcpServers", names: string[]) =>
    names.length === 0 ? (
      <p className="text-xs text-muted-foreground" data-testid={`pack-agent-resource-empty-${dim}`}>
        {t(dim === "skills" ? "packs.editor.resourceEmptySkills" : "packs.editor.resourceEmptyMcp")}
      </p>
    ) : (
      <div className="flex flex-wrap gap-1.5" data-testid={`pack-agent-resource-chips-${index}-${dim}`}>
        {names.map((name) => {
          const on = (resources?.[dim] ?? []).includes(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggleChip(dim, name)}
              className={`border rounded-full px-2 py-0.5 text-xs transition-colors ${
                on ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"
              }`}
              data-testid={`pack-agent-resource-chip-${name}`}
            >
              {name}
            </button>
          );
        })}
      </div>
    );

  return (
    <details
      className="border border-border rounded-md px-3 py-2"
      data-testid={`pack-agent-resources-${index}`}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm text-muted-foreground select-none">
        {t("packs.editor.resourceSet")}
      </summary>
      <p className="text-xs text-muted-foreground mt-1 mb-2">{t("packs.editor.resourceHint")}</p>
      <div className="space-y-2">
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={skillsOn}
              onChange={(e) => setDimension("skills", e.target.checked, ownSkillNames)}
              data-testid={`pack-agent-resource-toggle-skills-${index}`}
            />
            {t("packs.editor.limitSkills")}
          </label>
          {skillsOn && chips("skills", ownSkillNames)}
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mcpOn}
              onChange={(e) => setDimension("mcpServers", e.target.checked, ownMcpNames)}
              data-testid={`pack-agent-resource-toggle-mcp-${index}`}
            />
            {t("packs.editor.limitMcp")}
          </label>
          {mcpOn && chips("mcpServers", ownMcpNames)}
        </div>
      </div>
    </details>
  );
}
