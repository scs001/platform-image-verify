// PackDetailDialog — inspect a pack in full before subscribing: every skill's
// complete body, MCP references (with required groups), agent personas, and
// author identity (spec: pack-marketplace). Subscribe is one action that
// records the subscription on the market and materializes the snapshot in
// this cell; the cell fetches the manifest server-side from the pack id +
// version (pack-install-server-side-manifest).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDetail, PackDeployment, PackReport } from "@/lib/packs-api";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "./Badge";
import { RhythmEditor, rhythmEntryValid } from "./RhythmEditor";
import { PackVersionList } from "./PackVersionList";
import { guideFor, promptsFor, type PackGuide } from "@/lib/packGuides";
import type { RhythmEntry } from "./RhythmEditor";

interface Props {
  packId: string | null;
  onOpenChange: (open: boolean) => void;
  // packId rides the callback (simplify-chat-and-agents-ia): the install
  // report's next-steps CTA needs the pack id to deep-link a multi-role pack
  // into a cluster bind.
  onSubscribed: (report: PackReport, name: string, packId: string) => void;
  onGotoMine?: () => void;
  // Signed-out signal (polish-facet-interactions): hosts whose viewers can be
  // anonymous (the facet shell) wire this — gated actions (subscribe, goto-
  // mine) flip the action bar to a login-guidance row instead of firing or
  // surfacing a raw error. Hosts without it (壹座 — every viewer holds a
  // session) keep the authenticated-error fallback below.
  onRequireLogin?: () => void;
}

// The 万星 console deep link (agent-service-config): the deployment's slug and
// the console origin. The slug rule mirrors the serving side's slugFor
// (fd-wanxing wanxing-facade core.js) — a minimal copy, keep the two in
// lockstep (the same discipline the console's setPaused copy follows).
const wanxingConsoleBase = () => import.meta.env.VITE_WANXING_CONSOLE_URL || "https://wanxing.finddatatech.cloud";

// Authentication failures get a localized guidance line, never raw English
// (polish-facet-interactions): exact-match the platform's well-known
// "Authentication required" body; anything else passes through untouched.
function authErrorMessage(t: (k: string) => string, err: Error): string {
  if (err.message === "Authentication required") return t("packs.detail.authRequired");
  return err.message;
}
const wanxingSlugFor = (agentPath: string) =>
  String(agentPath).replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();

// Budget draft rule (add-deploy-form-model-budget D2) — a client mirror of
// the platform's budgetMinutesError (lib/pack-manifest.js: positive whole
// minutes, cap 120 = BUDGET_MAX_MINUTES). Same discipline as RhythmEditor
// mirroring lib/rhythm.js: the server stays the enforcement point; this only
// refuses the submit so a typo never meets its error server-side first.
const BUDGET_MAX_MINUTES = 120;
function budgetDraftValid(text: string): boolean {
  if (!/^\d+$/.test(text)) return false;
  const n = Number(text);
  return n > 0 && n <= BUDGET_MAX_MINUTES;
}

export function PackDetailDialog({ packId, onOpenChange, onSubscribed, onGotoMine, onRequireLogin }: Props) {
  const { t } = useTranslation();
  // Tool-face disclosure (pack-tool-declaration-gate D4): the declared count
  // rides the version manifest; the per-server total comes from the catalog's
  // tool_list snapshot (the same source the draft editor's picker uses) — no
  // live probe, so an unreachable server cannot break this page.
  const { marketCatalog, refreshMarketCatalog } = useExtensionsStore();
  useEffect(() => {
    if (packId) void refreshMarketCatalog();
  }, [packId, refreshMarketCatalog]);
  // The action bar's login-guidance row (polish-facet-interactions): flipped
  // when a signed-out viewer activates a gated action and the host wired
  // onRequireLogin; cleared when the dialog reopens for another pack.
  const [loginHint, setLoginHint] = useState(false);
  // Script confirm gate (add-packaged-skills 5.1): set when the install
  // answered 400 code=script-confirm-required — the names + script files it
  // carries render the one-time acknowledgment; confirming retries with
  // confirm=true. Server-enforced, this dialog is only the explanation.
  const [scriptGate, setScriptGate] = useState<{ name: string; scriptFiles: string[] }[] | null>(null);
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<PackDeployment[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  // Deployer rhythm overrides (add-agent-residency D7): agentId → entries.
  const [overrides, setOverrides] = useState<Record<string, RhythmEntry[]>>({});
  // Deploy-time model/budget drafts (add-deploy-form-model-budget): agentId →
  // trimmed input. Empty = the dimension rides no map (standing precedence:
  // preserved override → declaration → platform default); the form never
  // sends null (clearing is the serving config surface's act).
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [budgetDrafts, setBudgetDrafts] = useState<Record<string, string>>({});
  const [pauseBusy, setPauseBusy] = useState<string | null>(null);
  // Billing readout (add-agent-platform-ops D3; revised by
  // revise-billing-key-acquisition): linked + accountState drives the deploy
  // surface — "none" shows the SSO connect guidance, "ok" shows the balance
  // and the per-agent key paste inputs; unlinked shows no readout, no gate.
  const [billing, setBilling] = useState<api.MyBillingState | null>(null);
  // Serving agentId → whether a key is already bound (booleans only).
  const [bindings, setBindings] = useState<Record<string, boolean> | null>(null);
  // Paste inputs, serving agentId → drafted key (never echoed back).
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  // Optional agents toggle for cluster view (agent-cluster-platform)
  const [showOptionalAgents, setShowOptionalAgents] = useState(false);

  useEffect(() => {
    setPack(null);
    setError(null);
    setDeployments([]);
    setDeployNote(null);
    setBindings(null);
    setKeyDrafts({});
    setModelDrafts({});
    setBudgetDrafts({});
    setLoginHint(false);
    setScriptGate(null);
    setShowOptionalAgents(false);
    if (!packId) return;
    api
      .getPack(packId)
      .then(setPack)
      .catch((err) => setError((err as Error).message));
    api
      .getPackDeployments(packId)
      .then((d) => setDeployments(d.deployments ?? []))
      .catch(() => setDeployments([])); // deployments route absent = nothing deployed
    api
      .myBillingState()
      .then(setBilling)
      .catch(() => setBilling(null));
    api
      .getBillingBindings(packId)
      .then(setBindings)
      .catch(() => setBindings(null)); // bindings route absent = pre-revise gateway
  }, [packId]);

  const subscribe = async (confirmScripts = false) => {
    if (!packId || !pack) return;
    if (onRequireLogin) {
      // Host-wired signed-out path (facet shell): no call is made — the bar
      // flips to the login guidance row (spec: anonymous subscribe attempts
      // get a login guidance bar). Only the row's sign-in action invokes the
      // host's navigation.
      setLoginHint(true);
      return;
    }
    setSubscribing(true);
    setError(null);
    try {
      const sub = await api.subscribePack(packId);
      // Only the reference crosses the wire: the cell fetches the manifest
      // server-side (pack-install-server-side-manifest). A script-bearing
      // pack installs only with the explicit confirm (server-enforced).
      const { report } = await api.installPack(sub.packId, sub.version, confirmScripts);
      // Close this dialog BEFORE the report mounts: both are fixed overlays,
      // and a dialog left open above the report intercepts every click on
      // the report's actions (the report's own z-index cannot win a
      // still-mounted Radix portal). The report carries the result.
      onOpenChange(false);
      onSubscribed(report, pack.name, packId);
    } catch (err) {
      const e = err as Error & { body?: { code?: string; details?: { name: string; scriptFiles: string[] }[] } };
      if (e.body?.code === "script-confirm-required") {
        // Map the server's refusal to the one-time acknowledgment; the retry
        // carries confirm=true (task 5.1).
        setScriptGate(Array.isArray(e.body.details) ? e.body.details : []);
        return;
      }
      setError(authErrorMessage(t, e));
    } finally {
      setSubscribing(false);
    }
  };

  const servingAgents = (pack?.manifest?.agents ?? []).filter((a) => a.serving);

  // Any invalid budget draft freezes the deploy submit (add-deploy-form-
  // model-budget D2): a scalar typo meets its error in the form, never
  // server-side. Empty drafts are fine (empty = the dimension rides no map).
  const anyBudgetInvalid = servingAgents.some((a) => {
    const d = (budgetDrafts[a.id] ?? "").trim();
    return d.length > 0 && !budgetDraftValid(d);
  });

  // Serving capability (add-selfhost-funnel-guidance, F3.1): a self-hosted
  // instance without agent serving renders the official-market guidance
  // panel — the raw "not configured" error never surfaces.
  const [servingReady, setServingReady] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getServingStatus()
      .then((d) => live && setServingReady(Boolean(d.configured)))
      .catch(() => live && setServingReady(true)); // probe failure ≠ not configured
    return () => {
      live = false;
    };
  }, []);

  const deploy = async () => {
    if (!packId || !pack) return;
    setDeploying(true);
    setError(null);
    setDeployNote(null);
    try {
      // Only VALID filled override entries ride the deploy request; untouched
      // agents (and the empty map) mean "manifest default".
      const rhythms: Record<string, RhythmEntry[]> = {};
      for (const [agentId, entries] of Object.entries(overrides)) {
        const valid = (entries ?? []).filter(rhythmEntryValid);
        if (valid.length > 0) rhythms[agentId] = valid;
      }
      // Pasted keys (revise-billing-key-acquisition): non-empty drafts only —
      // omitted agents keep their existing binding (absent=keep).
      const billingKeys: Record<string, string> = {};
      for (const a of servingAgents) {
        const draft = (keyDrafts[a.id] ?? "").trim();
        if (draft) billingKeys[a.id] = draft;
      }
      // Model drafts (add-deploy-form-model-budget): non-empty trimmed only.
      // No client lane check — lanes belong to the bound/pasted key and are
      // unknowable here; the server's gates refuse with a code the catch
      // below localizes.
      const models: Record<string, string> = {};
      for (const a of servingAgents) {
        const draft = (modelDrafts[a.id] ?? "").trim();
        if (draft) models[a.id] = draft;
      }
      // Budget drafts: a single scalar where silently dropping an invalid
      // value would second-guess the deployer — the submit button is already
      // disabled while any draft is invalid (budgetDraftValid), and this is
      // the race-proof second gate.
      const budgets: Record<string, number> = {};
      for (const a of servingAgents) {
        const draft = (budgetDrafts[a.id] ?? "").trim();
        if (!draft) continue;
        if (!budgetDraftValid(draft)) {
          setError(t("packs.detail.budgetInvalid", { defaultValue: "turn budget must be whole minutes, 1–120" }));
          return;
        }
        budgets[a.id] = Number(draft);
      }
      const out = await api.deployPack(
        packId,
        pack.version,
        Object.keys(rhythms).length > 0 ? rhythms : undefined,
        Object.keys(billingKeys).length > 0 ? billingKeys : undefined,
        Object.keys(models).length > 0 ? models : undefined,
        Object.keys(budgets).length > 0 ? budgets : undefined,
      );
      const d = await api.getPackDeployments(packId);
      setDeployments(d.deployments ?? []);
      setKeyDrafts({});
      setModelDrafts({});
      setBudgetDrafts({});
      api.getBillingBindings(packId).then(setBindings).catch(() => {});
      setDeployNote(t("packs.detail.deployEffective", { minutes: Math.ceil(out.effectiveWithinSecs / 60) }));
    } catch (err) {
      const e = err as Error & { body?: { code?: string; reason?: string } };
      const code = e.body?.code;
      if (code === "BILLING_KEY_INVALID") {
        setError(t(`packs.detail.keyInvalid.${e.body?.reason ?? "liveness"}`, { defaultValue: e.message }));
      } else if (code === "BILLING_KEY_REQUIRED") {
        setError(t("packs.detail.keyRequired", { defaultValue: e.message }));
      } else if (code === "MODEL_LANE_REJECTED") {
        // The server's reason names the agent and the gate (whitelist/lanes);
        // the prefix is the only localized half (add-deploy-form-model-budget D3).
        setError(t("packs.detail.modelLaneRejected", { reason: e.message, defaultValue: e.message }));
      } else if (code === "MODEL_NOT_IN_ROSTER") {
        setError(t("packs.detail.modelNotInRoster", { reason: e.message, defaultValue: e.message }));
      } else if (/model lanes cannot be validated/.test(e.message)) {
        // The unlinked-billing-plane refusal for a filled model. MUST be
        // matched BEFORE the serving-not-configured branch below: its text
        // ("billing plane not configured — …") also matches that branch's
        // /not configured/i, which would swap the whole deploy form for the
        // self-host guidance panel and bury the actual reason.
        setError(t("packs.detail.modelLanesUnavailable", { defaultValue: e.message }));
      } else if (servingReady === false || /not configured/i.test(e.message)) {
        setServingReady(false); // race-proof: the probe lost to a click
      } else {
        setError(e.message);
      }
      // A 402 no-account answer may race the open-time readout: refresh.
      if (code === "NO_SUB2API_ACCOUNT" || code === "INSUFFICIENT_BALANCE") {
        api.myBillingState().then(setBilling).catch(() => {});
      }
    } finally {
      setDeploying(false);
    }
  };

  const togglePause = async (agentId: string, paused: boolean) => {
    if (!packId) return;
    setPauseBusy(agentId);
    setError(null);
    try {
      await api.pauseDeployment(packId, agentId, paused);
      const d = await api.getPackDeployments(packId);
      setDeployments(d.deployments ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPauseBusy(null);
    }
  };

  const m = pack?.manifest;
  // Guide resolution chain (add-pack-tutorials-and-wizard): the creator's own
  // manifest.guide wins; the client content module covers launch packs; no
  // content renders no card at all.
  const manifestGuide = (m as { guide?: { steps: { title: string; body: string }[] } } | undefined)?.guide;
  const guide: PackGuide | null = manifestGuide
    ? { name: pack?.name ?? "", steps: manifestGuide.steps as PackGuide["steps"] }
    : guideFor(packId);
  // Example questions are platform-curated (client module), never creator
  // content — shown beneath the steps as read-only decision help.
  const examples = promptsFor(packId) ?? [];

  return (
    <Dialog open={!!packId} onOpenChange={onOpenChange}>
      <DialogContent
        className="relative flex max-h-[85vh] max-w-2xl flex-col overflow-hidden p-0"
        data-testid="pack-detail"
      >
        {/* Close control at the dialog's top-right — the conventional spot.
            A sibling of the scroll pane, so it never scrolls away. */}
        <button
          type="button"
          aria-label={t("packs.detail.close")}
          className="absolute right-3 top-3 z-20 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onOpenChange(false)}
          data-testid="pack-detail-close"
        >
          ✕
        </button>
        <div className="flex-1 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>
            {pack?.name ?? (error ? t("packs.detail.notFound") : "")}
            {pack?.visibility === "private" && (
              <span data-testid="pack-private-badge" className="ml-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 align-middle">
                {t("packs.detail.private")}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {pack ? `${pack.authorEmail} · v${pack.version}` : ""}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>
        )}

        {pack && m && (
          <div className="space-y-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="text-muted-foreground">{pack.description}</p>
              {/* Raw download surface (add-facet-platform 4.4): the anonymous
                  skill-md route and the version manifest stay linkable from
                  the SPA — editors and scripts consume exactly these. */}
              <a
                href={`/api/packs/${pack.id}/versions/${pack.version}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs text-primary hover:underline"
                data-testid="pack-manifest-link"
              >
                {t("packs.detail.manifestJson")}
              </a>
            </div>
            {!!pack.tags?.length && (
              <div className="flex gap-1.5 flex-wrap">
                {pack.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}

            {/* Usage guide (add-onboarding-tutorial): three steps from the
                client content module — informational only, purely absent when
                the module has no entry for this pack id. Guide bodies are the
                pack's own-language content (zh); the chrome labels are i18n. */}
            {guide && (
              <section
                className="rounded-md border border-primary/30 bg-primary/5 p-3"
                data-testid="pack-guide-card"
              >
                <h4 className="mb-2 font-medium">{t("packs.guide.title")}</h4>
                <ol className="space-y-2" data-testid="pack-guide-steps">
                  {guide.steps.map((s, i) => (
                    <li key={s.title} className="text-xs">
                      <span className="font-medium text-foreground">
                        {t("packs.guide.step", { n: i + 1 })} · {s.title}
                      </span>
                      <p className="mt-0.5 leading-5 text-muted-foreground">{s.body}</p>
                    </li>
                  ))}
                </ol>
                {examples.length > 0 && (
                  <div className="mt-2 border-t border-primary/20 pt-2" data-testid="pack-guide-examples">
                    <p className="text-xs font-medium text-muted-foreground">{t("packs.guide.examples")}</p>
                    <ul className="mt-1 space-y-0.5">
                      {examples.slice(0, 4).map((ex) => (
                        <li key={ex.title} className="text-xs leading-5 text-muted-foreground">
                          · {ex.title}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="mt-2 text-xs text-muted-foreground">{t("packs.guide.hint")}</p>
              </section>
            )}

            {/* Version history (add-facet-version-history): lazy disclosure —
                the list fetches only when opened, never riding the default
                detail payload; rows are inspect-only (manifest + skill
                links, notes when present). */}
            <PackVersionList packId={pack.id} />

            {(m.skills?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.skills")}</h4>
                <div className="space-y-2">
                  {m.skills!.map((s) => (
                    <div key={s.name} className="border border-border rounded-md p-3" data-testid={`pack-skill-${s.name}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-mono text-xs text-foreground">{s.name}</div>
                        <a
                          href={`/api/packs/${pack.id}/versions/${pack.version}/skills/${encodeURIComponent(s.name)}.md`}
                          download
                          className="shrink-0 text-xs text-primary hover:underline"
                          data-testid={`pack-skill-download-${s.name}`}
                        >
                          {t("packs.detail.downloadSkill")}
                        </a>
                      </div>
                      <div className="text-xs text-muted-foreground mb-1">{s.description}</div>
                      <pre className="text-xs whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-48 overflow-auto">
                        {s.content}
                      </pre>
                      {/* File inventory (add-packaged-skills D4): the detail
                          projection lists a tree skill's auxiliary paths —
                          contents fetch per-file on demand, nothing hidden. */}
                      {Array.isArray(s.files) && s.files.length > 0 && (
                        <div className="mt-1" data-testid={`pack-skill-files-${s.name}`}>
                          <p className="text-xs font-medium text-muted-foreground">
                            {t("packs.detail.skillFiles", { count: s.files.length })}
                          </p>
                          <ul className="mt-0.5 max-h-24 space-y-0.5 overflow-y-auto">
                            {s.files.map((f) => (
                              <li key={f} className="font-mono text-[10px] text-muted-foreground">· {f}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(m.mcpServers?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.mcp")}</h4>
                <ul className="space-y-1">
                  {m.mcpServers!.map((r) => {
                    const total =
                      marketCatalog?.mcpServers?.find((s) => s.name === r.registryName)?.toolList?.length ?? null;
                    const declared = Array.isArray(r.allowTools) && r.allowTools.length > 0 ? r.allowTools.length : null;
                    const face =
                      declared !== null
                        ? t(
                            total === null ? "packs.detail.toolFaceDeclaredNoTotal" : "packs.detail.toolFaceDeclared",
                            { declared, total },
                          )
                        : r.fullSurface === true
                          ? t(total === null ? "packs.detail.toolFaceFullNoTotal" : "packs.detail.toolFaceFull", { total })
                          : t(
                              total === null
                                ? "packs.detail.toolFaceUndeclaredNoTotal"
                                : "packs.detail.toolFaceUndeclared",
                              { total },
                            );
                    return (
                      <li key={r.registryName} className="py-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{r.registryName}</span>
                          {r.requiredGroup && (
                            <Badge>{t("packs.detail.requiresGroup", { group: r.requiredGroup })}</Badge>
                          )}
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`pack-mcp-tool-face-${r.registryName}`}
                          >
                            {face}
                          </span>
                        </div>
                        {r.fullSurface === true && r.fullSurfaceReason && (
                          <p
                            className="mt-0.5 text-xs text-muted-foreground"
                            data-testid={`pack-mcp-full-surface-reason-${r.registryName}`}
                          >
                            {t("packs.detail.toolFaceReason", { reason: r.fullSurfaceReason })}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Facade panel (add-principal-facade): the pack declares itself a
                principal's conversational front door. Attribution is the
                platform's author stamp (never the manifest's self-narrative);
                the corpus as-of is the viewed version's publish time (corpus
                rides the immutable version — refresh = new version + redeploy);
                the chat entry exists only when the reception role is deployed
                (slug mirrors the serving side's slugFor). */}
            {pack.manifest?.facade && (
              <section
                className="border border-primary/20 bg-primary/5 rounded-md p-4"
                data-testid="pack-facade-info"
              >
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-medium text-primary">{t("packs.detail.facade.title")}</h4>
                  <Badge>{t("packs.detail.facade.stanceHosted")}</Badge>
                </div>
                <div className="space-y-1 text-sm" data-testid="pack-facade-attribution">
                  <p className="text-muted-foreground">
                    {t("packs.detail.facade.attribution", { owner: pack.authorEmail })}
                  </p>
                  <p className="text-muted-foreground" data-testid="pack-facade-asof">
                    {t("packs.detail.facade.asOf", {
                      date: new Date(pack.publishedAt).toLocaleDateString(),
                    })}
                  </p>
                </div>
                {(() => {
                  const reception = pack.manifest.facade!.reception;
                  const dep = deployments.find((d) => d.agentId === reception);
                  if (!dep) {
                    return (
                      <p className="mt-2 text-xs text-muted-foreground" data-testid="pack-facade-not-deployed">
                        {t("packs.detail.facade.notDeployed")}
                      </p>
                    );
                  }
                  const chatUrl = `${wanxingConsoleBase()}/#/chat/${wanxingSlugFor(dep.agentPath)}`;
                  return (
                    <a
                      href={chatUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-sm text-primary underline"
                      data-testid="pack-facade-chat-entry"
                    >
                      {t("packs.detail.facade.chatEntry")}
                    </a>
                  );
                })()}
              </section>
            )}

            {/* Cluster Info (agent-cluster-platform): when the pack declares cluster metadata,
                show a dedicated section with cluster name, description, and agent composition. */}
            {pack.manifest?.cluster && (
              <section className="border border-primary/20 bg-primary/5 rounded-md p-4" data-testid="pack-cluster-info">
                <h4 className="font-medium text-primary mb-1">{t("packs.detail.cluster.title")}</h4>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-lg font-semibold text-foreground">{pack.manifest.cluster.name}</h3>
                  <Badge data-testid="pack-cluster-agent-count">
                    {t("packs.detail.cluster.agentCount", { count: m?.agents?.length ?? 0 })}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mb-3">{pack.manifest.cluster.description}</p>
                
                {/* Agent composition list */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">{t("packs.detail.cluster.agents")}</p>
                  <div className="space-y-1">
                    {/* Default agents */}
                    {(pack.manifest.cluster.defaultAgents ?? []).map((agentId) => {
                      const agent = m?.agents?.find((a) => a.id === agentId);
                      if (!agent) return null;
                      return (
                        <div key={agentId} className="flex items-center gap-2 text-xs" data-testid={`pack-cluster-default-agent-${agentId}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                          <span className="font-medium text-foreground">{agent.name}</span>
                          <span className="text-muted-foreground">({agentId})</span>
                        </div>
                      );
                    })}
                    
                    {/* Optional agents toggle */}
                    {(pack.manifest.cluster.optionalAgents ?? []).length > 0 && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-xs pl-2"
                          data-testid="pack-cluster-toggle-optional"
                          onClick={() => setShowOptionalAgents(!showOptionalAgents)}
                        >
                          {showOptionalAgents ? t("packs.detail.cluster.hideOptional") : t("packs.detail.cluster.showOptional")}
                        </Button>
                        
                        {/* Optional agents (collapsible) */}
                        {showOptionalAgents && (
                          <div className="ml-3 space-y-1 pt-1 border-l border-border pl-2">
                            {(pack.manifest.cluster.optionalAgents ?? []).map((agentId) => {
                              const agent = m?.agents?.find((a) => a.id === agentId);
                              if (!agent) return null;
                              return (
                                <div key={agentId} className="flex items-center gap-2 text-xs" data-testid={`pack-cluster-optional-agent-${agentId}`}>
                                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground"></span>
                                  <span className="text-foreground">{agent.name}</span>
                                  <span className="text-muted-foreground">({agentId})</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </section>
            )}

            {(m.agents?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.agents")}</h4>
                <div className="space-y-2">
                  {m.agents!.map((a) => (
                    <div key={a.id} className="border border-border rounded-md p-3">
                      <div className="flex items-center gap-2">
                        <div className="text-foreground">{a.name}</div>
                        {a.serving && (
                          <span
                            data-testid={`pack-agent-serving-${a.id}`}
                            className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-primary"
                          >
                            A2A
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{a.id}</div>
                      {!!a.serving?.rhythm?.length && (
                        <div className="flex flex-wrap gap-1 mt-1" data-testid={`pack-agent-rhythm-default-${a.id}`}>
                          {a.serving.rhythm.map((r, j) => (
                            /* biome-ignore lint/suspicious/noArrayIndexKey: read-only chips from an immutable manifest snapshot — never reordered */
                            <span key={j} className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {r.daily ?? r.every}
                              {r.do ? ` · ${r.do.slice(0, 18)}${r.do.length > 18 ? "…" : ""}` : ""}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-xs whitespace-pre-wrap mt-1">{a.persona}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {servingAgents.length > 0 && servingReady === false && (
              <section className="border border-dashed border-border rounded-md p-3" data-testid="pack-deploy-guidance">
                <h4 className="font-medium mb-2">{t("packs.detail.selfhostTitle")}</h4>
                <p className="text-xs text-muted-foreground leading-5">{t("packs.detail.selfhostBody")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => window.open("https://facet.finddatatech.cloud", "_blank", "noopener")}
                    data-testid="pack-deploy-guidance-market"
                  >
                    {t("packs.detail.selfhostMarketBtn")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      window.open(
                        "https://github.com/FindDataTechnology/platform/blob/main/docs/creating-packs.md",
                        "_blank",
                        "noopener",
                      )
                    }
                    data-testid="pack-deploy-guidance-creating"
                  >
                    {t("packs.detail.selfhostCreatingBtn")}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t("packs.detail.selfhostNote")}</p>
              </section>
            )}

            {servingAgents.length > 0 && (servingReady === null || servingReady) && (
              <section className="border border-border rounded-md p-3" data-testid="pack-deploy-section">
                <h4 className="font-medium mb-2">{t("packs.detail.deployTitle")}</h4>
                <p className="text-xs text-muted-foreground leading-5 mb-3" data-testid="pack-deploy-summary">
                  {t("packs.detail.deploySummary")}
                </p>
                {billing?.linked && billing.accountState === "none" && (
                  <div className="text-xs mb-2 rounded-md px-2 py-2 bg-amber-500/10 text-amber-700" data-testid="pack-billing-no-account">
                    <p>{t("packs.detail.noAccountHintNew")}</p>
                    <p className="mt-1 text-muted-foreground">{t("packs.detail.noAccountHintExisting")}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 px-2 text-xs"
                      onClick={() => billing.panelUrl && window.open(billing.panelUrl, "_blank", "noopener")}
                      data-testid="pack-billing-connect"
                    >
                      {t("packs.detail.connectPanel")}
                    </Button>
                  </div>
                )}
                {billing?.linked && billing.accountState === "ok" && (
                  <div
                    data-testid="pack-billing-readout"
                    className={`text-xs mb-2 rounded-md px-2 py-1 ${billing.balance != null && billing.balance <= 1 ? "bg-amber-500/10 text-amber-700" : "text-muted-foreground"}`}
                  >
                    {billing.balance != null
                      ? t("packs.detail.balance", { balance: billing.balance.toFixed(2) })
                      : t("packs.detail.balanceUnknown")}
                    {billing.balance != null && billing.balance <= 1 && (
                      <span className="block">{t("packs.detail.balanceLow")}</span>
                    )}
                  </div>
                )}
                {billing?.linked && billing.accountState === "ok" && (
                  <div className="mb-2 space-y-2">
                    <p className="text-xs text-muted-foreground leading-5">{t("packs.detail.keySubtitle")}</p>
                    {servingAgents.map((a) => (
                      <div key={a.id} data-testid={`pack-billing-key-${a.id}`}>
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-muted-foreground">
                            {t("packs.detail.keyPasteLabel", { id: a.id })}
                          </p>
                          {bindings?.[a.id] && (
                            <span
                              className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono text-primary"
                              data-testid={`pack-billing-bound-${a.id}`}
                            >
                              {t("packs.detail.keyBoundBadge")}
                            </span>
                          )}
                        </div>
                        <input
                          type="text"
                          className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
                          placeholder={t("packs.detail.keyPastePlaceholder")}
                          value={keyDrafts[a.id] ?? ""}
                          onChange={(e) => setKeyDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                          autoComplete="off"
                          spellCheck={false}
                          data-testid={`pack-billing-key-input-${a.id}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground leading-5 mb-2">{t("packs.detail.rhythmSubtitle")}</p>
                <p className="text-xs text-muted-foreground leading-5 mb-2">{t("packs.detail.modelSubtitle")}</p>
                <p className="text-xs text-muted-foreground leading-5 mb-2">{t("packs.detail.budgetSubtitle")}</p>
                {servingAgents.map((a) => (
                  <div key={a.id} className="mb-2" data-testid={`pack-deploy-override-${a.id}`}>
                    <p className="text-xs text-muted-foreground">{t("packs.detail.rhythmOverride", { id: a.id })}</p>
                    <RhythmEditor
                      value={overrides[a.id] ?? []}
                      onChange={(entries) => setOverrides((o) => ({ ...o, [a.id]: entries }))}
                      testIdPrefix={`pack-deploy-override-editor-${a.id}`}
                    />
                    <p className="text-xs text-muted-foreground mt-1.5">{t("packs.detail.modelOverride", { id: a.id })}</p>
                    <input
                      type="text"
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
                      placeholder={a.serving?.model || t("packs.detail.modelPlaceholder")}
                      value={modelDrafts[a.id] ?? ""}
                      onChange={(e) => setModelDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      data-testid={`pack-deploy-model-${a.id}`}
                      list={`pack-deploy-model-wl-${a.id}`}
                    />
                    {a.serving?.modelWhitelist?.length ? (
                      <>
                        <datalist id={`pack-deploy-model-wl-${a.id}`}>
                          {a.serving.modelWhitelist.map((m) => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                        <p className="text-xs text-muted-foreground" data-testid={`pack-deploy-model-wl-${a.id}`}>
                          {t("packs.detail.modelHintWhitelist", { list: a.serving.modelWhitelist.join(" · ") })}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground" data-testid={`pack-deploy-model-wl-${a.id}`}>
                        {t("packs.detail.modelHintNoWhitelist")}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1.5">{t("packs.detail.budgetOverride", { id: a.id })}</p>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
                      placeholder={
                        a.serving?.budget?.turnMinutes != null
                          ? String(a.serving.budget.turnMinutes)
                          : t("packs.detail.budgetPlaceholder")
                      }
                      value={budgetDrafts[a.id] ?? ""}
                      onChange={(e) => setBudgetDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                      autoComplete="off"
                      spellCheck={false}
                      data-testid={`pack-deploy-budget-${a.id}`}
                    />
                    {(budgetDrafts[a.id] ?? "").trim().length > 0 && !budgetDraftValid((budgetDrafts[a.id] ?? "").trim()) && (
                      <p className="text-xs text-amber-600" data-testid={`pack-deploy-budget-invalid-${a.id}`}>
                        {t("packs.detail.budgetInvalid")}
                      </p>
                    )}
                  </div>
                ))}
                {deployments.length > 0 && (
                  <ul className="space-y-1 mb-2">
                    {deployments.map((d) => (
                      <li key={d.agentId} className="flex items-center gap-2 text-xs" data-testid="pack-deployment-row">
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{d.agentId}</span>
                        <span className="text-muted-foreground">v{d.version}</span>
                        <span className={d.paused ? "text-amber-600" : "text-primary"} data-testid={`pack-deployment-state-${d.agentId}`}>
                          {d.paused ? t("packs.detail.paused") : t("packs.detail.deployOnline")}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 px-2 text-xs"
                          disabled={pauseBusy === d.agentId}
                          onClick={() => void togglePause(d.agentId, !d.paused)}
                          data-testid={`pack-deployment-pause-${d.agentId}`}
                        >
                          {d.paused ? t("packs.detail.resumeBtn") : t("packs.detail.pauseBtn")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() =>
                            window.open(`${wanxingConsoleBase()}/#/console/${wanxingSlugFor(d.agentPath)}`, "_blank", "noopener")
                          }
                          data-testid={`pack-deployment-config-${d.agentId}`}
                        >
                          {t("packs.detail.gotoConfig")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {deployNote && <p className="text-xs text-primary mb-2">{deployNote}</p>}
                <Button
                  variant="outline"
                  onClick={() => void deploy()}
                  disabled={deploying || anyBudgetInvalid}
                  data-testid="pack-deploy-btn"
                >
                  {deploying ? t("common.loading") : t("packs.detail.deployBtn")}
                </Button>
                <p className="text-xs text-muted-foreground mt-1.5" data-testid="pack-deploy-outcome">
                  {t("packs.detail.deployOutcome")}
                </p>
              </section>
            )}

          </div>
        )}

        </div>

        {/* Action bar (polish-facet-interactions): a real flex child pinned to
            the dialog's bottom edge — the scroll pane ends above it, so it is
            always visible and nothing can show through behind it. The host-
            selected goto-mine affordance renders only when wired (the facet
            shell routes it through the login guidance when signed out). */}
        <div
          className="shrink-0 border-t border-border bg-background px-6 py-3"
          data-testid="pack-action-bar"
        >
          {loginHint && (
            <div
              className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
              data-testid="pack-login-guidance"
            >
              <span className="text-xs text-muted-foreground">{t("packs.detail.loginHint")}</span>
              {onRequireLogin && (
                <Button size="sm" className="h-7 px-3 text-xs" onClick={onRequireLogin} data-testid="pack-login-go">
                  {t("packs.detail.loginGo")}
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button onClick={() => void subscribe()} disabled={subscribing} data-testid="pack-subscribe">
              {subscribing ? t("common.loading") : t("packs.detail.subscribe")}
            </Button>
            {onGotoMine &&
              (onRequireLogin ? (
                // Facet shell: no installed-packs surface for an anonymous
                // viewer — the button joins the login guidance row instead
                // of being a silent no-op.
                <Button variant="ghost" onClick={() => setLoginHint(true)}>
                  {t("packs.detail.gotoMine")}
                </Button>
              ) : (
                <Button variant="ghost" onClick={onGotoMine}>
                  {t("packs.detail.gotoMine")}
                </Button>
              ))}
          </div>
        </div>

        {/* Script confirm gate (add-packaged-skills 5.1): the one-time
            acknowledgment for script-bearing packs, mounted only after the
            server refused with script-confirm-required. Confirming retries
            the install with confirm=true; the gate is server-enforced. */}
        <Dialog open={scriptGate !== null} onOpenChange={(open) => !open && setScriptGate(null)}>
          <DialogContent className="max-w-md" data-testid="pack-script-confirm">
            <DialogHeader>
              <DialogTitle>{t("packs.detail.scriptGateTitle")}</DialogTitle>
              <DialogDescription>{t("packs.detail.scriptGateBody")}</DialogDescription>
            </DialogHeader>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {scriptGate?.map((b) => (
                <li key={b.name}>
                  <span className="font-mono text-xs text-foreground">{b.name}</span>
                  <ul className="ml-4 list-disc">
                    {b.scriptFiles.map((f) => (
                      <li key={f} className="text-xs text-amber-700 dark:text-amber-400">{f}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setScriptGate(null)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void subscribe(true)} disabled={subscribing} data-testid="pack-script-confirm-ok">
                {subscribing ? t("common.loading") : t("packs.detail.scriptGateConfirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
