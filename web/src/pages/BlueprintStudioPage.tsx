// BlueprintStudioPage.tsx — 蓝图构造间（add-blueprint-studio tasks 2.1/2.2）.
//
// owner 面独立分栏（design D1：治包不治舰，不嵌驾驶舱）：左清单右编辑。
// 编辑双轨——表单轨（板块边界/数据来源）与 JSON 轨互为只读同步，同一草稿池；
// 提交前全链校验（服务端既有校验器原文），校验未绿不得批准；批准后方可铸造
// 上架（市场=唯一通道）。草稿零副作用：本页只调 /api/blueprints，不产生
// 市场/铸造仓/集群库任何实体。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  approveBlueprint,
  BlueprintApiError,
  castBlueprint,
  createBlueprint,
  getBlueprint,
  getTrialReport,
  listBlueprints,
  skeletonContent,
  updateBlueprint,
  validateBlueprint,
  type Blueprint,
  type BlueprintContent,
  type BlueprintSummary,
  type ValidationError,
  type ValidationVerdict,
} from "@/lib/blueprint-api";

const STATUS_TONE: Record<string, string> = {
  draft: "border-border bg-muted/60 text-muted-foreground",
  approved: "border-primary/40 bg-primary/10 text-primary",
  cast: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600",
};

// 内容派生键（仓俗：数组下标不作 React key）——重复项以出现序数去重。
function keyed<T>(rows: T[], base: (row: T) => string): { key: string; row: T; index: number }[] {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const b = base(row) || "item";
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    return { key: `${b}#${n}`, row, index };
  });
}

function ErrorList({ errors, empty }: { errors: ValidationError[]; empty: string }) {
  const { t } = useTranslation();
  if (errors.length === 0) return <div className="text-xs text-muted-foreground">{empty}</div>;
  return (
    <ul className="space-y-1" data-testid="blueprint-errors">
      {keyed(errors, (e) => `${e.entry ?? "-"}:${e.error}`).map(({ key, row: e }) => (
        <li key={key} className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
          {e.entry ? <span className="mr-2 font-mono text-[11px] text-destructive">{t("blueprints.error.entry", { entry: e.entry })}</span> : null}
          <span>{e.error}</span>
        </li>
      ))}
    </ul>
  );
}

export function BlueprintStudioPage() {
  const { t } = useTranslation();
  const [list, setList] = useState<BlueprintSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Blueprint | null>(null);
  const [content, setContent] = useState<BlueprintContent | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [tab, setTab] = useState<"form" | "json">("form");
  const [verdict, setVerdict] = useState<ValidationVerdict | null>(null);
  const [verdictStale, setVerdictStale] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [trial, setTrial] = useState<unknown>(null);

  const refreshList = useCallback(async () => {
    const out = await listBlueprints();
    setList(out.blueprints);
    return out.blueprints;
  }, []);

  const open = useCallback(async (id: string) => {
    setBusy("open");
    try {
      const { blueprint } = await getBlueprint(id);
      setSelectedId(id);
      setDetail(blueprint);
      setContent(blueprint.content);
      setJsonText(JSON.stringify(blueprint.content, null, 2));
      setJsonError(null);
      setVerdict(null);
      setVerdictStale(false);
      setNotice(null);
      setTrial(blueprint.trialReport ?? null);
    } catch (e) {
      setNotice({ kind: "err", text: String((e as Error).message) });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const items = await refreshList();
        const first = items[0];
        if (first) await open(first.id);
      } catch (e) {
        setNotice({ kind: "err", text: String((e as Error).message) });
      }
    })();
  }, [refreshList, open]);

  // 同一草稿池的两个视图：content 是唯一真源，JSON 轨是它的序列化呈现。
  const applyContent = useCallback((next: BlueprintContent) => {
    setContent(next);
    setJsonText(JSON.stringify(next, null, 2));
    setJsonError(null);
    setVerdictStale(true);
  }, []);

  const patchBoundary = (key: "name" | "oneLine" | "outOfScope", value: string) => {
    if (!content) return;
    applyContent({ ...content, boundary: { ...(content.boundary ?? {}), [key]: value } });
  };

  const setDataSource = (index: number, ref: string) => {
    if (!content) return;
    const sources = [...(content.dataSources ?? [])];
    sources[index] = { ...sources[index], ref };
    applyContent({ ...content, dataSources: sources });
  };

  const addDataSource = () => {
    if (!content) return;
    applyContent({ ...content, dataSources: [...(content.dataSources ?? []), { ref: "" }] });
  };

  const removeDataSource = (index: number) => {
    if (!content) return;
    applyContent({ ...content, dataSources: (content.dataSources ?? []).filter((_, i) => i !== index) });
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as BlueprintContent;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError(t("blueprints.json.notObject"));
        return;
      }
      applyContent(parsed);
    } catch (e) {
      setJsonError(String((e as Error).message));
    }
  };

  const dirty = useMemo(() => {
    if (!detail || !content) return false;
    return JSON.stringify(content) !== JSON.stringify(detail.content);
  }, [detail, content]);

  const sceneName = content?.boundary?.name ?? detail?.name ?? "";
  const status = detail?.status ?? "draft";

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof BlueprintApiError) {
        if (e.status === 409) setNotice({ kind: "err", text: `${t("blueprints.notice.conflict")} ${String(e.body.currentVersion ?? "")}` });
        else {
          const errors = (e.body.errors as ValidationError[] | undefined) ?? [];
          setNotice({ kind: "err", text: errors.length ? `${e.message} — ${errors.map((x) => x.error).join("; ")}` : e.message });
        }
      } else {
        setNotice({ kind: "err", text: String((e as Error).message) });
      }
    } finally {
      setBusy(null);
    }
  };

  const onCreate = () =>
    run("create", async () => {
      const { blueprint } = await createBlueprint(skeletonContent(t("blueprints.untitled")));
      await refreshList();
      await open(blueprint.id);
      setNotice({ kind: "ok", text: t("blueprints.notice.created") });
    });

  const onSave = () =>
    run("save", async () => {
      if (!detail || !content) return;
      const { blueprint } = await updateBlueprint(detail.id, detail.version, content);
      setDetail(blueprint);
      setContent(blueprint.content);
      setJsonText(JSON.stringify(blueprint.content, null, 2));
      setVerdictStale(true);
      await refreshList();
      setNotice({ kind: "ok", text: t("blueprints.notice.saved", { version: blueprint.version }) });
    });

  const onValidate = () =>
    run("validate", async () => {
      if (!detail) return;
      const result = await validateBlueprint(detail.id);
      setVerdict(result);
      setVerdictStale(false);
      setNotice({ kind: result.ok ? "ok" : "err", text: result.ok ? t("blueprints.notice.validated") : t("blueprints.notice.invalid") });
    });

  const onApprove = () =>
    run("approve", async () => {
      if (!detail) return;
      const { blueprint } = await approveBlueprint(detail.id, detail.version);
      setDetail(blueprint);
      await refreshList();
      setNotice({ kind: "ok", text: t("blueprints.notice.approved") });
    });

  const onCast = () =>
    run("cast", async () => {
      if (!detail) return;
      const { blueprint, cast } = await castBlueprint(detail.id);
      setDetail(blueprint);
      await refreshList();
      setNotice({ kind: "ok", text: t("blueprints.notice.cast", { packId: cast.packId ?? "" }) });
    });

  const onLoadTrial = () =>
    run("trial", async () => {
      if (!detail) return;
      const out = await getTrialReport(detail.id);
      setTrial(out.report);
    });

  const canApprove = Boolean(verdict?.ok) && !verdictStale && !dirty && status !== "cast";
  const diffRows = useMemo(() => {
    if (!detail?.diffSummary) return null;
    try {
      const parsed = JSON.parse(detail.diffSummary);
      return Array.isArray(parsed) ? (parsed as { field: string; before: unknown; after: unknown }[]) : null;
    } catch {
      return null;
    }
  }, [detail]);

  return (
    <div className="flex h-full min-h-0 bg-background" data-testid="blueprint-studio">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h1 className="text-sm font-semibold">{t("blueprints.title")}</h1>
          <button
            type="button"
            className="ml-auto rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
            onClick={onCreate}
            disabled={busy !== null}
            data-testid="blueprint-new"
          >
            {t("blueprints.new")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground" data-testid="blueprint-empty">
              {t("blueprints.list.empty")}
            </div>
          ) : (
            <ul className="space-y-1">
              {list.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`w-full rounded-md px-2.5 py-2 text-left text-sm ${selectedId === b.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}
                    onClick={() => void open(b.id)}
                    data-testid={`blueprint-row-${b.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{b.name}</span>
                      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${STATUS_TONE[b.status] ?? STATUS_TONE.draft}`}>
                        {t(`blueprints.status.${b.status}`)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("blueprints.list.version", { version: b.version })}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!detail || !content ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground" data-testid="blueprint-placeholder">
            {t("blueprints.editor.pick")}
          </div>
        ) : (
          <>
            <header className="border-b border-border px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_TONE[status] ?? STATUS_TONE.draft}`} data-testid="blueprint-status">
                  {t(`blueprints.status.${status}`)}
                </span>
                <span className="text-xs text-muted-foreground">{t("blueprints.list.version", { version: detail.version })}</span>
                {detail.approvedBy ? (
                  <span className="text-xs text-muted-foreground" data-testid="blueprint-approved">
                    {t("blueprints.approved.by", { who: detail.approvedBy, when: String(detail.approvedAt ?? "").slice(0, 19) })}
                  </span>
                ) : null}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button type="button" className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40" onClick={onSave} disabled={!dirty || busy !== null} data-testid="blueprint-save">
                    {busy === "save" ? t("blueprints.saving") : t("blueprints.save")}
                  </button>
                  <button type="button" className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40" onClick={onValidate} disabled={busy !== null} data-testid="blueprint-validate">
                    {busy === "validate" ? t("blueprints.validating") : t("blueprints.validate")}
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-primary/90 px-2.5 py-1 text-xs text-primary-foreground hover:bg-primary disabled:opacity-40"
                    onClick={onApprove}
                    disabled={!canApprove || busy !== null}
                    data-testid="blueprint-approve"
                  >
                    {busy === "approve" ? t("blueprints.approving") : t("blueprints.approve")}
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-emerald-600/90 px-2.5 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-40"
                    onClick={onCast}
                    disabled={status !== "approved" || busy !== null}
                    data-testid="blueprint-cast"
                  >
                    {busy === "cast" ? t("blueprints.casting") : t("blueprints.cast")}
                  </button>
                </div>
              </div>
              {notice ? (
                <div className={`mt-2 text-xs ${notice.kind === "ok" ? "text-emerald-600" : "text-destructive"}`} data-testid="blueprint-notice">
                  {notice.text}
                </div>
              ) : null}
            </header>

            <div className="flex items-center gap-1 border-b border-border px-5 pt-2">
              {(["form", "json"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded-t-md px-3 py-1.5 text-xs ${tab === key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"}`}
                  onClick={() => setTab(key)}
                  data-testid={`blueprint-tab-${key}`}
                >
                  {t(`blueprints.tabs.${key}`)}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {dirty ? t("blueprints.editor.unsaved") : t("blueprints.editor.synced")}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {tab === "form" ? (
                <div className="max-w-2xl space-y-4" data-testid="blueprint-form-track">
                  <label className="block">
                    <span className="text-xs text-muted-foreground">{t("blueprints.fields.name")}</span>
                    <input
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      value={sceneName}
                      onChange={(e) => patchBoundary("name", e.target.value)}
                      data-testid="blueprint-field-name"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">{t("blueprints.fields.oneLine")}</span>
                    <input
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      value={content.boundary?.oneLine ?? ""}
                      onChange={(e) => patchBoundary("oneLine", e.target.value)}
                      data-testid="blueprint-field-oneline"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-muted-foreground">{t("blueprints.fields.outOfScope")}</span>
                    <textarea
                      className="mt-1 h-20 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      value={content.boundary?.outOfScope ?? ""}
                      onChange={(e) => patchBoundary("outOfScope", e.target.value)}
                      data-testid="blueprint-field-outofscope"
                    />
                  </label>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t("blueprints.sources.title")}</span>
                      <button type="button" className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-muted" onClick={addDataSource} data-testid="blueprint-source-add">
                        {t("blueprints.sources.add")}
                      </button>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{t("blueprints.sources.hint")}</p>
                    <div className="mt-2 space-y-1.5">
                      {keyed(content.dataSources ?? [], (s) => s.ref).map(({ key, row: s, index: i }) => (
                        <div key={key} className="flex items-center gap-2">
                          <input
                            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                            value={s.ref}
                            placeholder={t("blueprints.sources.placeholder")}
                            onChange={(e) => setDataSource(i, e.target.value)}
                            data-testid={`blueprint-source-${i}`}
                          />
                          <button type="button" className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted" onClick={() => removeDataSource(i)}>
                            {t("blueprints.sources.remove")}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t("blueprints.fields.jsonHint")}</p>
                </div>
              ) : (
                <div className="flex h-full flex-col gap-2" data-testid="blueprint-json-track">
                  <textarea
                    className="min-h-[320px] flex-1 rounded-md border border-border bg-background p-3 font-mono text-xs"
                    value={jsonText}
                    onChange={(e) => {
                      setJsonText(e.target.value);
                      setJsonError(null);
                    }}
                    data-testid="blueprint-json-text"
                  />
                  {jsonError ? <div className="text-xs text-destructive" data-testid="blueprint-json-error">{jsonError}</div> : null}
                  <div>
                    <button type="button" className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted" onClick={applyJson} data-testid="blueprint-json-apply">
                      {t("blueprints.json.apply")}
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div className="rounded-md border border-border p-3" data-testid="blueprint-verdict">
                  <div className="mb-2 text-xs font-medium">{t("blueprints.verify.title")}</div>
                  {!verdict ? (
                    <div className="text-xs text-muted-foreground">{t("blueprints.verify.notRun")}</div>
                  ) : (
                    <>
                      <div className={`mb-2 text-xs ${verdict.ok ? "text-emerald-600" : "text-destructive"}`}>
                        {verdict.ok ? t("blueprints.verify.ok") : t("blueprints.verify.fail", { count: verdict.errors.length })}
                      </div>
                      <ErrorList errors={verdict.errors} empty={t("blueprints.verify.ok")} />
                    </>
                  )}
                  {verdictStale ? <div className="mt-2 text-[11px] text-amber-600">{t("blueprints.verify.stale")}</div> : null}
                </div>

                <div className="rounded-md border border-border p-3" data-testid="blueprint-diff">
                  <div className="mb-2 text-xs font-medium">{t("blueprints.diff.title")}</div>
                  {!diffRows || diffRows.length === 0 ? (
                    <div className="text-xs text-muted-foreground">{t("blueprints.diff.none")}</div>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {diffRows.map((d) => (
                        <li key={d.field} className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">{d.field}</span>
                          <span className="truncate text-muted-foreground line-through">{String(d.before ?? "")}</span>
                          <span className="truncate">{String(d.after ?? "")}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {status === "cast" ? (
                <div className="mt-4 rounded-md border border-border p-3" data-testid="blueprint-trial">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{t("blueprints.trial.title")}</span>
                    <button type="button" className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-muted" onClick={onLoadTrial} data-testid="blueprint-trial-load">
                      {t("blueprints.trial.load")}
                    </button>
                    {detail.castPackId ? (
                      <span className="text-[11px] text-muted-foreground">{t("blueprints.castPack", { packId: detail.castPackId })}</span>
                    ) : null}
                  </div>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/40 p-2 text-[11px]">{trial ? JSON.stringify(trial, null, 2) : t("blueprints.trial.none")}</pre>
                </div>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default BlueprintStudioPage;
