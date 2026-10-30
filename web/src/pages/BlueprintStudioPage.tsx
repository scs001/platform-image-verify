// BlueprintStudioPage.tsx — 蓝图构造间（add-blueprint-studio tasks 2.1/2.2）.
//
// owner 面独立分栏（design D1：治包不治舰，不嵌驾驶舱）：左清单右编辑。
// 编辑双轨——表单轨（板块边界/数据来源）与 JSON 轨互为只读同步，同一草稿池；
// 提交前全链校验（服务端既有校验器原文），校验未绿不得批准；批准后方可铸造
// 上架（市场=唯一通道）。草稿零副作用：本页只调 /api/blueprints，不产生
// 市场/铸造仓/集群库任何实体。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import {
  approveBlueprint,
  BlueprintApiError,
  deleteBlueprint,
  castBlueprint,
  createBlueprint,
  getBlueprint,
  getJudgeDefault,
  getTrialReport,
  listBlueprints,
  runTrial,
  signTrialReport,
  skeletonContent,
  unsignTrialReport,
  updateBlueprint,
  validateBlueprint,
  type Blueprint,
  type BlueprintContent,
  type BlueprintSummary,
  type JudgeDefaultProbe,
  type TrialReport,
  type ValidationError,
  type ValidationVerdict,
} from "@/lib/blueprint-api";

const STATUS_TONE: Record<string, string> = {
  draft: "border-border bg-muted/60 text-muted-foreground",
  approved: "border-primary/40 bg-primary/10 text-primary",
  cast: "border-emerald-500/50 bg-emerald-500/10 text-emerald-600",
};

// 起草提示词里的结构骨架（代码常量，非本地化串——`{{PACK_ID}}` 若走 locale
// 会被 i18next 当插值吃掉）。内容层文字由提示词正文承载。
const DRAFT_SCHEMA = `{
  "boundary": { "name": "", "oneLine": "", "outOfScope": "" },
  "dataSources": [{ "ref": "" }],
  "fleet": {
    "name": "",
    "members": [
      {
        "ref": "",
        "title": "",
        "parentRef": null,
        "target": { "kind": "pack-preset", "packId": "{{PACK_ID}}", "presetId": "" },
        "kpiSlots": [{ "key": "", "label": "" }],
        "cadence": { "cron": "0 9 * * *", "tz": "Asia/Shanghai", "promptTemplate": "" }
      }
    ]
  },
  "agents": [{ "id": "", "name": "", "persona": "" }],
  "mcpServers": [],
  "monitoring": {},
  "acceptance": [],
  "board": {}
}`;

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
        <li key={key} className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs whitespace-pre-line">
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
  const [tab, setTab] = useState<"form" | "json" | "draft">("form");
  const [verdict, setVerdict] = useState<ValidationVerdict | null>(null);
  const [verdictStale, setVerdictStale] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [trial, setTrial] = useState<TrialReport | null>(null);
  // 评审模型 roster（add-blueprint-judge-model-choice）：与聊天同一份模型清单。
  const modelRoster = useChatStore((s) => s.models);
  // 「跟随部署默认」实际解析到哪个模型（优化③）：cell 进程的名册常为空，界面
  // 单看 roster 无从得知空选项会落到谁——向服务端问一次真实解析结果。
  const [judgeDefault, setJudgeDefault] = useState<JudgeDefaultProbe | null>(null);
  useEffect(() => {
    let alive = true;
    getJudgeDefault()
      .then((p) => {
        if (alive) setJudgeDefault(p);
      })
      .catch(() => {
        if (alive) setJudgeDefault(null);
      });
    return () => {
      alive = false;
    };
  }, []);
  const [draftPaste, setDraftPaste] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
      setTrial((blueprint.trialReport as TrialReport | null) ?? null);
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

  // ── 起草轨（task 2.3，提示词桥）─────────────────────────────────────────
  // NL→草稿承袭构造师 pack 能力的编译产物：提示词给会话里的智能体，返回的
  // JSON 粘回同一草稿池（与 2.2 双轨同源），不引第二个编译源、不新造端点。
  const draftPrompt = useMemo(
    () =>
      `${t("blueprints.draft.promptIntro", { name: sceneName || t("blueprints.untitled") })}\n\n${DRAFT_SCHEMA}\n\n${t("blueprints.draft.constraints", { dep: "{{PACK_ID:<name>}}" })}`,
    [sceneName, t],
  );

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(draftPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setDraftError(t("blueprints.draft.copyFailed"));
    }
  };

  const applyDraft = () => {
    try {
      const parsed = JSON.parse(draftPaste) as unknown;
      const wrapped = parsed as { content?: unknown };
      const candidate =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) && wrapped.content && typeof wrapped.content === "object"
          ? wrapped.content
          : parsed;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        setDraftError(t("blueprints.draft.invalid"));
        return;
      }
      applyContent(candidate as BlueprintContent);
      setDraftError(null);
      setDraftPaste("");
      setTab("form");
      setNotice({ kind: "ok", text: t("blueprints.draft.applied") });
    } catch (e) {
      setDraftError(String((e as Error).message));
    }
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof BlueprintApiError) {
        if (e.status === 409) setNotice({ kind: "err", text: `${t("blueprints.notice.conflict")} ${String(e.body.currentVersion ?? "")}` });
        else {
          // 校验/写入失败：优先逐项 errors；仅带 findings（如存储层 v1 方言硬拒）时
          // 用其 error 原文——含多行迁移指引，notice 以 pre-line 呈现。
          const errors = (e.body.errors as ValidationError[] | undefined) ?? [];
          const findings = (e.body.findings as ValidationError[] | undefined) ?? [];
          const items = errors.length ? errors : findings;
          setNotice({ kind: "err", text: items.length ? `${e.message} — ${items.map((x) => x.error).join("\n")}` : e.message });
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

  const onDelete = () =>
    run("delete", async () => {
      if (!detail) return;
      await deleteBlueprint(detail.id);
      const rest = (await refreshList()).filter((x) => x.id !== detail.id);
      setDetail(null);
      setContent(null);
      setSelectedId(null);
      const next = rest[0];
      if (next) await open(next.id);
    });

  const onSign = () =>
    run("sign", async () => {
      if (!detail) return;
      const out = await signTrialReport(detail.id);
      setTrial(out.report);
      setDetail(out.blueprint);
      setNotice({ kind: "ok", text: t("blueprints.signoff.signed") });
    });

  const onUnsign = () =>
    run("sign", async () => {
      if (!detail) return;
      const out = await unsignTrialReport(detail.id);
      setTrial(out.report);
      setDetail(out.blueprint);
      setNotice({ kind: "ok", text: t("blueprints.signoff.cleared") });
    });

  const onLoadTrial = () =>
    run("trial", async () => {
      if (!detail) return;
      const out = await getTrialReport(detail.id);
      setTrial(out.report ?? null);
    });

  // 试跑触发（铸过的蓝图才有意义：服务端在临时沙盒里真建岗位、真点首轮，
  // 全部断言逐条落判决。跑完自动载入报告——绿色报告是签字与再铸的前提。）
  const onRunTrial = () =>
    run("trialRun", async () => {
      if (!detail) return;
      try {
        const out = await runTrial(detail.id);
        setTrial(out.report ?? null);
        setDetail(out.blueprint ?? null);
        await refreshList();
        setNotice({
          kind: out.report?.green ? "ok" : "err",
          text: out.report?.green
            ? t("blueprints.notice.trialGreen")
            : t("blueprints.notice.trialNotGreen"),
        });
      } catch (e) {
        // 车道/沙盒故障 ≠ 判不过：报告不落，如实说「重跑即可」，并附原始错误。
        setNotice({ kind: "err", text: `${t("blueprints.notice.trialFailed")} ${String((e as Error).message).slice(0, 160)}` });
      }
    });

  const canApprove = Boolean(verdict?.ok) && !verdictStale && !dirty && status !== "cast";
  // 「再铸」：铸造后拿到了**已签署的绿色报告**，把报告刷新进上架包里（可售闸
  // 读的是包内报告位）。没有可刷新的绿+签报告时按钮维持铸造期的禁用原样。
  // 例外=陈旧指针：市场包 id 已失效（改名/重建换 id）时试跑恒 404，而报告只能由
  // 试跑产出——此时必须允许再铸来重建包并把指针改到新 id，否则蓝图永久卡死
  // （服务端以旧 id 发版被 404 拒时会重建，见 routes/blueprints.js）。
  const reportedErrors: string[] = [
    ...(trial?.errors ?? []),
    ...((detail?.trialReport as { errors?: string[] } | null | undefined)?.errors ?? []),
  ];
  const pointerStale = reportedErrors.some((e) => /Pack (version )?not found/i.test(e));
  const canRecast = status === "cast" && (Boolean(trial?.green && trial?.signoff) || pointerStale);
  const castLabel = pointerStale && !(trial?.green && trial?.signoff)
    ? t("blueprints.recastRepair")
    : t("blueprints.recast");
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
                    disabled={(status !== "approved" && !canRecast) || busy !== null}
                    data-testid="blueprint-cast"
                  >
                    {busy === "cast" ? t("blueprints.casting") : canRecast ? castLabel : t("blueprints.cast")}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-40"
                    onClick={onDelete}
                    disabled={Boolean(detail.castPackId) || busy !== null}
                    title={detail.castPackId ? t("blueprints.delete.castLocked") : undefined}
                    data-testid="blueprint-delete"
                  >
                    {t("blueprints.delete.label")}
                  </button>
                </div>
              </div>
              {notice ? (
                <div className={`mt-2 text-xs whitespace-pre-line ${notice.kind === "ok" ? "text-emerald-600" : "text-destructive"}`} data-testid="blueprint-notice">
                  {notice.text}
                </div>
              ) : null}
            </header>

            <div className="flex items-center gap-1 border-b border-border px-5 pt-2">
              {(["form", "json", "draft"] as const).map((key) => (
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
                  <label className="block">
                    <span className="text-xs text-muted-foreground">{t("blueprints.judge.model.label")}</span>
                    <select
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      value={content.judgeModel ?? ""}
                      onChange={(e) => applyContent({ ...content, judgeModel: e.target.value || undefined })}
                      data-testid="blueprint-judge-model"
                    >
                      <option value="">{t("blueprints.judge.model.followDefault")}</option>
                      {(modelRoster ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                      {content.judgeModel && !(modelRoster ?? []).some((m) => m.id === content.judgeModel) ? (
                        <option value={content.judgeModel}>
                          {content.judgeModel} — {t("blueprints.judge.model.notInRoster")}
                        </option>
                      ) : null}
                    </select>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {content.judgeModel?.trim()
                        ? t("blueprints.judge.model.hint")
                        : judgeDefault?.resolved
                          ? t("blueprints.judge.model.followDefaultResolves", { model: judgeDefault.resolved.model })
                          : judgeDefault
                            ? t("blueprints.judge.model.followDefaultUnknown")
                            : t("blueprints.judge.model.hint")}
                    </span>
                  </label>
                  <p className="text-[11px] text-muted-foreground">{t("blueprints.fields.jsonHint")}</p>
                </div>
              ) : tab === "json" ? (
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
              ) : (
                <div className="max-w-2xl space-y-3" data-testid="blueprint-draft-track">
                  <p className="text-xs text-muted-foreground">{t("blueprints.draft.hint")}</p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted"
                      onClick={() => void copyPrompt()}
                      data-testid="blueprint-draft-copy"
                    >
                      {copied ? t("blueprints.draft.copied") : t("blueprints.draft.copy")}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    className="h-44 w-full rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]"
                    value={draftPrompt}
                    data-testid="blueprint-draft-prompt"
                  />
                  <textarea
                    className="h-44 w-full rounded-md border border-border bg-background p-2 font-mono text-[11px]"
                    value={draftPaste}
                    placeholder={t("blueprints.draft.pastePlaceholder")}
                    onChange={(e) => {
                      setDraftPaste(e.target.value);
                      setDraftError(null);
                    }}
                    data-testid="blueprint-draft-paste"
                  />
                  {draftError ? <div className="text-xs text-destructive" data-testid="blueprint-draft-error">{draftError}</div> : null}
                  <div>
                    <button
                      type="button"
                      className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-40"
                      onClick={applyDraft}
                      disabled={!draftPaste.trim()}
                      data-testid="blueprint-draft-apply"
                    >
                      {t("blueprints.draft.apply")}
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
                    <button type="button" className="rounded-md bg-primary/90 px-2 py-0.5 text-[11px] text-primary-foreground hover:bg-primary disabled:opacity-40" onClick={onRunTrial} disabled={busy !== null} data-testid="blueprint-trial-run">
                      {busy === "trialRun" ? t("blueprints.trial.running") : t("blueprints.trial.run")}
                    </button>
                    <button type="button" className="rounded-md border border-border px-2 py-0.5 text-[11px] hover:bg-muted" onClick={onLoadTrial} data-testid="blueprint-trial-load">
                      {t("blueprints.trial.load")}
                    </button>
                    {detail.castPackId ? (
                      <span className="text-[11px] text-muted-foreground">{t("blueprints.castPack", { packId: detail.castPackId })}</span>
                    ) : null}
                  </div>
                  {!trial ? (
                    <div className="mt-2 text-[11px] text-muted-foreground">{t("blueprints.trial.none")}</div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className={trial.green ? "text-emerald-600" : "text-destructive"}>
                          {trial.green ? t("blueprints.trial.green") : t("blueprints.trial.notGreen")}
                        </span>
                        <span className="text-muted-foreground">{t("blueprints.trial.ranAt", { when: new Date(trial.ranAt).toLocaleString() })}</span>
                        {trial.judged?.length ? (
                          <span className="text-muted-foreground">{t("blueprints.trial.judgedCount", { count: trial.judged.length })}</span>
                        ) : null}
                        {trial.judgeModelUsed ? (
                          <span className="text-muted-foreground" data-testid="blueprint-judge-used">
                            {t("blueprints.judge.model.used", { model: trial.judgeModelUsed })}
                            {trial.judged?.[0]?.audit?.judgeSource
                              ? ` · ${t(`blueprints.judge.model.source.${trial.judged[0].audit.judgeSource}`)}`
                              : ""}
                          </span>
                        ) : null}
                        {trial.signoff ? (
                          <span className="text-emerald-600" data-testid="blueprint-signoff-state">
                            {t("blueprints.signoff.by", { who: trial.signoff.by, when: String(trial.signoff.at).slice(0, 19) })}
                            <button type="button" className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted" onClick={onUnsign} disabled={busy !== null}>
                              {t("blueprints.signoff.clear")}
                            </button>
                          </span>
                        ) : trial.judged?.length ? (
                          <button
                            type="button"
                            className="rounded-md bg-primary/90 px-2 py-0.5 text-[11px] text-primary-foreground hover:bg-primary disabled:opacity-40"
                            onClick={onSign}
                            disabled={busy !== null}
                            data-testid="blueprint-signoff"
                          >
                            {t("blueprints.signoff.sign")}
                          </button>
                        ) : null}
                      </div>
                      <ul className="space-y-1">
                        {trial.assertions.map((a) => (
                          <li key={`${a.id}-${a.kind}`} className="rounded-md border border-border px-2 py-1 text-[11px]" data-testid={`blueprint-assert-${a.id}`}>
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded-full border px-1.5 py-0.5 text-[10px] ${
                                  a.pass
                                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600"
                                    : "border-destructive/40 bg-destructive/5 text-destructive"
                                }`}
                              >
                                {a.kind === "llm-judged"
                                  ? a.audit?.laneError
                                    ? // 判据没跑成 ≠ 证据不足：前者重跑即可，后者要改证据或判据。
                                      t("blueprints.judge.verdict.laneError")
                                    : t(`blueprints.judge.verdict.${a.verdict ?? "insufficient-evidence"}`)
                                  : a.pass
                                    ? t("blueprints.trial.pass")
                                    : t("blueprints.trial.fail")}
                              </span>
                              <span className="font-mono text-muted-foreground">{a.id}</span>
                              <span className="text-muted-foreground">{a.kind}</span>
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.detail}</span>
                            </div>
                            {a.audit ? (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-[10px] text-muted-foreground">{t("blueprints.judge.audit")}</summary>
                                <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/40 p-1.5 text-[10px]">{JSON.stringify(a.audit, null, 2)}</pre>
                              </details>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      {trial.errors?.length ? (
                        <ul className="space-y-1 text-[11px] text-destructive">
                          {keyed(trial.errors, (e) => e).map(({ key, row: e }) => (
                            <li key={key}>{e}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  )}
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
