// PackDetailDialog — inspect a pack in full before subscribing: every skill's
// complete body, MCP references (with required groups), agent personas, and
// author identity (spec: pack-marketplace). Subscribe is one action that
// records the subscription on the gateway and materializes the snapshot in
// this cell (design D8 browser-mediated flow).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDetail, PackReport } from "@/lib/packs-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "./Badge";

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

  useEffect(() => {
    setPack(null);
    setError(null);
    if (!packId) return;
    api
      .getPack(packId)
      .then(setPack)
      .catch((err) => setError((err as Error).message));
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
                      <div className="text-foreground">{a.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{a.id}</div>
                      <p className="text-xs whitespace-pre-wrap mt-1">{a.persona}</p>
                    </div>
                  ))}
                </div>
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
