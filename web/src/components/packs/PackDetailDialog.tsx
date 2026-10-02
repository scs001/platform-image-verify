// PackDetailDialog — inspect a pack in full before subscribing: every skill's
// complete body, MCP references (with required groups), agent personas, and
// author identity (spec: pack-marketplace). Subscribe is one action that
// records the subscription on the gateway and materializes the snapshot in
// this cell (design D8 browser-mediated flow).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDetail, PackDeployment, PackReport } from "@/lib/packs-api";
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
import type { RhythmEntry } from "./RhythmEditor";

interface Props {
  packId: string | null;
  onOpenChange: (open: boolean) => void;
  onSubscribed: (report: PackReport, name: string) => void;
  onGotoMine?: () => void;
}

export function PackDetailDialog({ packId, onOpenChange, onSubscribed, onGotoMine }: Props) {
  const { t } = useTranslation();
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<PackDeployment[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  // Deployer rhythm overrides (add-agent-residency D7): agentId → entries.
  const [overrides, setOverrides] = useState<Record<string, RhythmEntry[]>>({});
  const [pauseBusy, setPauseBusy] = useState<string | null>(null);

  useEffect(() => {
    setPack(null);
    setError(null);
    setDeployments([]);
    setDeployNote(null);
    if (!packId) return;
    api
      .getPack(packId)
      .then(setPack)
      .catch((err) => setError((err as Error).message));
    api
      .getPackDeployments(packId)
      .then((d) => setDeployments(d.deployments ?? []))
      .catch(() => setDeployments([])); // deployments route absent = nothing deployed
  }, [packId]);

  const subscribe = async () => {
    if (!packId || !pack) return;
    setSubscribing(true);
    setError(null);
    try {
      const sub = await api.subscribePack(packId);
      const { report } = await api.installPack(sub.packId, sub.version, sub.manifest);
      onSubscribed(report, pack.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubscribing(false);
    }
  };

  const servingAgents = (pack?.manifest?.agents ?? []).filter((a) => a.serving);

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
      const out = await api.deployPack(packId, pack.version, Object.keys(rhythms).length > 0 ? rhythms : undefined);
      const d = await api.getPackDeployments(packId);
      setDeployments(d.deployments ?? []);
      setDeployNote(t("packs.detail.deployEffective", { minutes: Math.ceil(out.effectiveWithinSecs / 60) }));
    } catch (err) {
      setError((err as Error).message);
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

  return (
    <Dialog open={!!packId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto" data-testid="pack-detail">
        <DialogHeader>
          <DialogTitle>{pack?.name ?? (error ? t("packs.detail.notFound") : "")}</DialogTitle>
          <DialogDescription>
            {pack ? `${pack.authorEmail} · v${pack.version}` : ""}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>
        )}

        {pack && m && (
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">{pack.description}</p>
            {!!pack.tags?.length && (
              <div className="flex gap-1.5 flex-wrap">
                {pack.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}

            {(m.skills?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.skills")}</h4>
                <div className="space-y-2">
                  {m.skills!.map((s) => (
                    <div key={s.name} className="border border-border rounded-md p-3" data-testid={`pack-skill-${s.name}`}>
                      <div className="font-mono text-xs text-foreground">{s.name}</div>
                      <div className="text-xs text-muted-foreground mb-1">{s.description}</div>
                      <pre className="text-xs whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-48 overflow-auto">
                        {s.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(m.mcpServers?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.mcp")}</h4>
                <ul className="space-y-1">
                  {m.mcpServers!.map((r) => (
                    <li key={r.registryName} className="flex items-center gap-2">
                      <span className="font-mono text-xs">{r.registryName}</span>
                      {r.requiredGroup && <Badge>{t("packs.detail.requiresGroup", { group: r.requiredGroup })}</Badge>}
                    </li>
                  ))}
                </ul>
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
                            className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                          >
                            A2A
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{a.id}</div>
                      {!!a.serving?.rhythm?.length && (
                        <div className="flex flex-wrap gap-1 mt-1" data-testid={`pack-agent-rhythm-default-${a.id}`}>
                          {a.serving.rhythm.map((r, j) => (
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

            {servingAgents.length > 0 && (
              <section className="border border-border rounded-md p-3" data-testid="pack-deploy-section">
                <h4 className="font-medium mb-2">{t("packs.detail.deployTitle")}</h4>
                {servingAgents.map((a) => (
                  <div key={a.id} className="mb-2" data-testid={`pack-deploy-override-${a.id}`}>
                    <p className="text-xs text-muted-foreground">{t("packs.detail.rhythmOverride", { id: a.id })}</p>
                    <RhythmEditor
                      value={overrides[a.id] ?? []}
                      onChange={(entries) => setOverrides((o) => ({ ...o, [a.id]: entries }))}
                      testIdPrefix={`pack-deploy-override-editor-${a.id}`}
                    />
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
                      </li>
                    ))}
                  </ul>
                )}
                {deployNote && <p className="text-xs text-primary mb-2">{deployNote}</p>}
                <Button
                  variant="outline"
                  onClick={() => void deploy()}
                  disabled={deploying}
                  data-testid="pack-deploy-btn"
                >
                  {deploying ? t("common.loading") : t("packs.detail.deployBtn")}
                </Button>
              </section>
            )}

            <div className="flex items-center gap-2 pt-2">
              <Button onClick={() => void subscribe()} disabled={subscribing} data-testid="pack-subscribe">
                {subscribing ? t("common.loading") : t("packs.detail.subscribe")}
              </Button>
              {onGotoMine && (
                <Button variant="ghost" onClick={onGotoMine}>
                  {t("packs.detail.gotoMine")}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
