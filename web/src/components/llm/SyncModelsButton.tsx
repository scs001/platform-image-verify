// SyncModelsButton — admin action that reconciles a provider's roster against
// its gateway (add-llm-model-discovery). One long-lived request (up to ~60s
// for a 33-id gateway), so the button turns into a spinner and the summary
// lands in a toast. The reserved env provider runs a dry run: the result is
// shown read-only inline ("would add: …") because nothing gets written.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { showToast } from "@/components/Toast";
import { syncProvider } from "@platform/core";

interface Props {
  providerId: string;
  reserved: boolean;
  onDone: () => void;
}

export function SyncModelsButton({ providerId, reserved, onDone }: Props) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [dryRunIds, setDryRunIds] = useState<string[] | null>(null);

  const onClick = async () => {
    setRunning(true);
    try {
      const r = await syncProvider(providerId);
      if (r.dryRun) {
        setDryRunIds(r.wouldAdd ?? []);
      } else {
        const statuses = Object.values(r.statuses);
        const serving = statuses.filter((s) => s.status === "serving").length;
        const flagged = statuses.length - serving;
        showToast(t("modelsPage.syncSummary", { added: r.added?.length ?? 0, serving, flagged }));
        onDone();
      }
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={running}
        aria-label={reserved ? t("modelsPage.syncDryRun") : t("modelsPage.syncModels")}
        data-testid="llm-sync-btn"
      >
        {running
          ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
        {reserved ? t("modelsPage.syncDryRun") : t("modelsPage.syncModels")}
      </Button>
      {reserved && dryRunIds && (
        <span
          className="text-xs text-muted-foreground"
          data-testid="llm-sync-dryrun-result"
        >
          {dryRunIds.length
            ? t("modelsPage.wouldAdd", { ids: dryRunIds.join(", ") })
            : t("modelsPage.wouldAddNone")}
        </span>
      )}
    </div>
  );
}
