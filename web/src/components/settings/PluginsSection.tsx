// Settings → Plugins (openspec: add-dsh-plugin-supply). The dsh-layer bundle
// roster: whatever the deployment whitelisted (matrix bake + template bundle
// declaration) appears here as a read-only inventory with one enable/disable
// toggle per row — no install, no remove, no edit. A toggle rides the
// plugin-supply bridge: the child persists the bundle-layer selection and
// either recomposes live (HMR) or restarts and resumes sessions; this pane
// shows a pending state until the fresh roster pulses back as `plugins_changed`.
//
// Rows carrying `readOnlyReason` are management-protected (the bundle supplies
// the manager itself — dsh-base): the toggle is disabled, the reason is shown.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Package } from "lucide-react";
import type { PluginBundleInfo } from "@platform/core";
import { useChatStore } from "@platform/core";
import { Switch } from "@/components/ui/switch";
import { wsSend } from "@/hooks/useWebSocket";
import { cn } from "@/lib/utils";

export function PluginsSection() {
  const { t } = useTranslation();
  const bundles = useChatStore((s) => s.pluginBundles);
  const available = useChatStore((s) => s.pluginsAvailable);
  const status = useChatStore((s) => s.status);
  // The shared runtime's live turn — the server refuses a toggle mid-turn
  // (same guard family as set_model), so gray the switches out rather than
  // letting the user hit the refusal.
  const isStreaming = useChatStore((s) => s.isStreaming);
  // The bundle id whose toggle is in flight. Cleared when the roster pulses
  // (plugins_changed) — that is the server's own completion signal, and it
  // covers both apply paths (live recompose and restart-and-resume).
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (status === "connected") wsSend({ type: "list_plugins" });
  }, [status]);

  useEffect(() => {
    setPending(null);
  }, []);

  const onToggle = useCallback(
    (bundle: PluginBundleInfo) => {
      if (pending !== null) return;
      setPending(bundle.id);
      wsSend({ type: "set_plugin_enabled", id: bundle.id, enabled: !bundle.enabled });
    },
    [pending],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{t("plugins.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("plugins.description")}</p>
      </header>

      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        {t("plugins.suppliedHint")}
      </div>

      {!available && bundles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("plugins.unavailable")}</p>
      ) : bundles.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="plugins-empty">
          {t("plugins.empty")}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="plugins-list">
          {bundles.map((bundle) => {
            const protectedRow = typeof bundle.readOnlyReason === "string";
            const failed = bundle.error !== undefined;
            const rowPending = pending === bundle.id;
            const disabled = !available || protectedRow || failed || pending !== null || isStreaming;
            return (
              <li
                key={bundle.id}
                data-testid={`plugin-row-${bundle.id}`}
                className={cn(
                  "flex items-start gap-3 rounded-md border border-border px-3 py-2.5",
                  rowPending && "opacity-70",
                )}
              >
                <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-sm text-foreground">{bundle.name}</span>
                    {bundle.version ? (
                      <span className="text-xs text-muted-foreground">{bundle.version}</span>
                    ) : null}
                    {protectedRow ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {t("plugins.protected")}
                      </span>
                    ) : null}
                  </div>
                  {bundle.description ? (
                    <p className="text-sm text-muted-foreground">{bundle.description}</p>
                  ) : null}
                  {failed ? (
                    <p className="text-xs text-destructive">
                      {t("plugins.failed", {
                        reason: bundle.error?.message || bundle.error?.code || "error",
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {rowPending ? (
                    <span className="text-xs text-muted-foreground">{t("plugins.applying")}</span>
                  ) : null}
                  <Switch
                    checked={bundle.enabled}
                    disabled={disabled}
                    onCheckedChange={() => onToggle(bundle)}
                    aria-label={t("plugins.toggleLabel", { name: bundle.name })}
                    data-testid={`plugin-toggle-${bundle.id}`}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">{t("plugins.applyHint")}</p>
      {isStreaming ? (
        <p className="text-xs text-muted-foreground" data-testid="plugins-streaming-hint">
          {t("plugins.busyHint")}
        </p>
      ) : null}
    </div>
  );
}