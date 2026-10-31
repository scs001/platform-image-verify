// BlueprintTeamMode — the blueprint working surface inside the studio's team
// tab (fold-blueprint-into-studio): the blueprint lifecycle (draft pool in
// blueprints.db → validate → trial → approve → cast) is UNCHANGED (D3); this
// is a new read/write frontend over the same /api/blueprints endpoints. The
// blueprint-specific sections (boundary / dataSources / judgeModel) render as
// forms; the three buckets (agents / mcp) render through the SHARED
// AgentBucketsEditor (D1: one editor, two hosts); the JSON track is the full
// editor and never bypasses validation (dual-track, same as the retired page).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import { Plus, Trash2 } from "lucide-react";
import * as bp from "@/lib/blueprint-api";
import type { Blueprint, BlueprintContent, BlueprintSummary, TrialReport, ValidationVerdict } from "@/lib/blueprint-api";
import { AgentBucketsEditor } from "@/components/studio/AgentBucketsEditor";
import type { PackManifestAgent, PackManifestMcp } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
  draft: "border-border bg-muted/60 text-muted-foreground",
  approved: "border-primary/40 bg-primary/10 text-primary",
  cast: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function BlueprintTeamMode({ autoFocusPool = false }: { autoFocusPool?: boolean }) {
  const { t } = useTranslation();
  const modelRoster = useChatStore((s) => s.models);

  const [pool, setPool] = useState<BlueprintSummary[]>([]);
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);
  const [content, setContent] = useState<BlueprintContent | null>(null);
  const [track, setTrack] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ValidationVerdict | null>(null);
  const [trial, setTrial] = useState<TrialReport | null>(null);
  const [judgeDefault, setJudgeDefault] = useState<bp.JudgeDefaultProbe | null>(null);
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refreshPool = useCallback(async () => {
    try {
      const { blueprints } = await bp.listBlueprints();
      setPool(blueprints ?? []);
    } catch {
      setPool([]);
    }
  }, []);

  useEffect(() => {
    void refreshPool();
    bp.getJudgeDefault().then((p) => setJudgeDefault(p)).catch(() => {});
    fetch("/api/collections")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`collections ${r.status}`))))
      .then((body) => setCollections(Array.isArray(body?.collections) ? body.collections : []))
      .catch(() => setCollections([]));
  }, [refreshPool]);

  const open = useCallback(async (id: string) => {
    setBusy("open");
    setNotice(null);
    try {
      const { blueprint: b } = await bp.getBlueprint(id);
      setBlueprint(b);
      setContent(b.content as BlueprintContent);
      setVerdict(null);
      setTrial(null);
      setJsonText(JSON.stringify(b.content, null, 2));
      setTrack("form");
    } catch (err) {
      setNotice({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, []);

  const create = async () => {
    setBusy("create");
    try {
      const created = await bp.createBlueprint(bp.skeletonContent(t("studio.blueprint.untitled")));
      await refreshPool();
      await open(created.blueprint.id);
    } catch (err) {
      setNotice({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // Save + full-chain validate: edits only land through updateBlueprint
  // (expectVersion optimistic), and validation runs the stored content —
  // the JSON track can never bypass the chain (dual-track discipline).
  const saveAndValidate = async () => {
    if (!blueprint || !content) return;
    setBusy("save");
    setNotice(null);
    try {
      const updated = await bp.updateBlueprint(blueprint.id, blueprint.version, content);
      setBlueprint(updated.blueprint);
      const v = await bp.validateBlueprint(blueprint.id);
      setVerdict(v);
      setNotice({ kind: v.ok ? "ok" : "err", text: v.ok ? t("studio.blueprint.savedValid") : t("studio.validate.bad", { n: v.errors.length }) });
      await refreshPool();
    } catch (err) {
      setNotice({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const patch = (p: Partial<BlueprintContent>) => setContent((c) => (c ? { ...c, ...p } : c));

  const status = blueprint?.status ?? "draft";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="studio-blueprint-mode" data-autofocus-pool={autoFocusPool ? "true" : undefined}>
      {/* ── Draft pool ── */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2" data-testid="studio-blueprint-pool">
        <select
          className="max-w-64 rounded-md border border-border bg-background px-2 py-1 text-xs"
          value={blueprint?.id ?? ""}
          onChange={(e) => e.target.value && void open(e.target.value)}
          data-testid="studio-blueprint-select"
        >
          <option value="">{t("studio.blueprint.pick")}</option>
          {pool.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} · {t(`studio.blueprint.status.${b.status}`)}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={create} disabled={busy !== null} data-testid="studio-blueprint-new">
          <Plus className="h-3.5 w-3.5" /> {t("studio.blueprint.new")}
        </Button>
        {blueprint && (
          <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", STATUS_TONE[status])} data-testid="studio-blueprint-status">
            {t(`studio.blueprint.status.${status}`)} · v{blueprint.version}
          </span>
        )}
      </div>

      {!blueprint || !content ? (
        <p className="p-8 text-center text-sm text-muted-foreground" data-testid="studio-blueprint-empty">
          {t("studio.blueprint.empty")}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* ── Editor (form | json dual track) ── */}
          <div className="min-w-0 flex-1 space-y-3 overflow-y-auto p-3">
            <div className="flex gap-2 text-xs">
              {(["form", "json"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    if (k === "json" && content) setJsonText(JSON.stringify(content, null, 2));
                    setTrack(k);
                  }}
                  className={cn("rounded-t-md px-3 py-1", track === k ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}
                  data-testid={`studio-blueprint-track-${k}`}
                >
                  {t(`studio.blueprint.track.${k}`)}
                </button>
              ))}
            </div>

            {track === "form" ? (
              <>
                <div className="grid grid-cols-1 gap-2" data-testid="studio-blueprint-boundary">
                  <Field label={t("studio.blueprint.boundary.name")}>
                    <Input value={content.boundary?.name ?? ""} onChange={(e) => patch({ boundary: { ...content.boundary, name: e.target.value } })} data-testid="studio-blueprint-boundary-name" />
                  </Field>
                  <Field label={t("studio.blueprint.boundary.oneLine")}>
                    <Input value={content.boundary?.oneLine ?? ""} onChange={(e) => patch({ boundary: { ...content.boundary, oneLine: e.target.value } })} data-testid="studio-blueprint-boundary-oneline" />
                  </Field>
                  <Field label={t("studio.blueprint.boundary.outOfScope")}>
                    <Textarea rows={2} value={content.boundary?.outOfScope ?? ""} onChange={(e) => patch({ boundary: { ...content.boundary, outOfScope: e.target.value } })} data-testid="studio-blueprint-boundary-scope" />
                  </Field>
                </div>

                <Field label={t("studio.blueprint.judge")}>
                  <select
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    value={content.judgeModel ?? ""}
                    onChange={(e) => patch({ judgeModel: e.target.value || undefined })}
                    data-testid="studio-blueprint-judge"
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
                </Field>

                <div data-testid="studio-blueprint-sources">
                  <span className="text-xs text-muted-foreground">{t("studio.blueprint.sources")}</span>
                  <div className="mt-1 space-y-1">
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
                            patch({ dataSources: sources });
                          }}
                          data-testid={`studio-blueprint-source-${i}`}
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
                          onClick={() => patch({ dataSources: (content.dataSources ?? []).filter((_, j) => j !== i) })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <select
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      value=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        patch({ dataSources: [...(content.dataSources ?? []), { ref: e.target.value }] });
                      }}
                      data-testid="studio-blueprint-source-add"
                    >
                      <option value="">{t("studio.blueprint.pickCollection")}</option>
                      {collections.map((c) => (
                        <option key={c.id} value={`library:${c.id}`}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Three buckets via the SHARED editor (D1): agents + mcp;
                    blueprints carry no skills bucket. */}
                <AgentBucketsEditor
                  value={{
                    agents: (content.agents ?? []) as PackManifestAgent[],
                    mcpServers: (content.mcpServers ?? []) as PackManifestMcp[],
                  }}
                  showSkills={false}
                  catalogServers={[]}
                  onChange={({ agents, mcpServers }) => patch({ agents, mcpServers })}
                  testIdPrefix="studio-blueprint-bucket"
                />
                <p className="text-[11px] text-muted-foreground">{t("studio.blueprint.jsonHint")}</p>
              </>
            ) : (
              <div>
                <Textarea
                  rows={24}
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  className="font-mono text-xs"
                  data-testid="studio-blueprint-json"
                />
                {jsonError && <p className="mt-1 text-xs text-destructive">{jsonError}</p>}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  data-testid="studio-blueprint-json-apply"
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(jsonText) as BlueprintContent;
                      setContent(parsed);
                      setJsonError(null);
                      setTrack("form");
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

          {/* ── Lifecycle pane: save→validate→trial→approve→cast (unchanged) ── */}
          <aside className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-border p-3" data-testid="studio-blueprint-side">
            <Button size="sm" className="w-full" onClick={saveAndValidate} disabled={busy !== null} data-testid="studio-blueprint-save">
              {busy === "save" ? t("studio.emit.busy") : t("studio.blueprint.saveValidate")}
            </Button>

            {verdict && (
              <div data-testid="studio-blueprint-verdict">
                <div className={cn("text-xs font-medium", verdict.ok ? "text-emerald-600" : "text-destructive")}>
                  {verdict.ok ? t("studio.validate.ok") : t("studio.validate.bad", { n: verdict.errors.length })}
                </div>
                <ul className="mt-1 space-y-1">
                  {verdict.errors.map((e, i) => (
                    <li
                      /* biome-ignore lint/suspicious/noArrayIndexKey: flat error strings, never reordered */
                      key={i}
                      className="whitespace-pre-line rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs"
                    >
                      {e.entry ? <span className="mr-1 font-mono text-[11px] text-destructive">{e.entry}</span> : null}
                      {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {status === "draft" && verdict?.ok && (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                data-testid="studio-blueprint-trial"
                disabled={busy !== null}
                onClick={() =>
                  act("trial", async () => {
                    await bp.runTrial(blueprint.id);
                    const { report } = await bp.getTrialReport(blueprint.id);
                    setTrial(report);
                  })
                }
              >
                {t("studio.blueprint.trial")}
              </Button>
            )}
            {trial && (
              <div className="rounded-md border border-border p-2 text-xs" data-testid="studio-blueprint-trial-report">
                <div className="font-medium">{t("studio.blueprint.trialReport")}</div>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                  {JSON.stringify(trial, null, 1).slice(0, 2000)}
                </pre>
              </div>
            )}

            {status === "draft" && (
              <Button
                size="sm"
                className="w-full"
                data-testid="studio-blueprint-approve"
                disabled={busy !== null}
                onClick={() =>
                  act("approve", async () => {
                    const { blueprint: updated } = await bp.approveBlueprint(blueprint.id, blueprint.version);
                    setBlueprint(updated);
                    await refreshPool();
                  })
                }
              >
                {t("studio.blueprint.approve")}
              </Button>
            )}
            {status === "approved" && (
              <Button
                size="sm"
                className="w-full"
                data-testid="studio-blueprint-cast"
                disabled={busy !== null}
                onClick={() =>
                  act("cast", async () => {
                    const { blueprint: updated } = await bp.castBlueprint(blueprint.id);
                    setBlueprint(updated);
                    await refreshPool();
                  })
                }
              >
                {t("studio.blueprint.cast")}
              </Button>
            )}
            {blueprint.castPackId && (
              <p className="text-xs text-muted-foreground" data-testid="studio-blueprint-cast-ref">
                {t("studio.blueprint.castRef", { packId: blueprint.castPackId, version: blueprint.castPackVersion ?? "?" })}
              </p>
            )}

            {notice && (
              <p className={cn("text-xs", notice.kind === "ok" ? "text-emerald-600" : "text-destructive")} data-testid="studio-blueprint-notice">
                {notice.text}
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
