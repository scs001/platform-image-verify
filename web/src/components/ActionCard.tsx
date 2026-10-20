// ── ActionCard (add-line-boards-and-action-gate, task 7) ────────────────────
//
// Renders the propose_action tool call as a confirmation card:
//   - pending face: impact + risk tier + confirm/cancel buttons
//   - resolved face: result summary + audit entry link
//
// The card is keyed by toolCallId; when the proposal state changes via WS
// broadcast (action_approved / action_rejected / action_expired), the store
// updates the turn.blocks and the card re-renders.

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle, XCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface ActionResult {
  proposalId: string;
  state: "pending" | "approved" | "executed" | "rejected" | "expired";
  impact: string;
  risk: string;
  target: string;
  tier: string;
}

interface Props {
  block: {
    name: string;
    args?: unknown;
    state: "done" | "running" | "error";
    result?: ActionResult | unknown;
  };
}

function statusIcon(state: string) {
  switch (state) {
    case "pending":
      return <Clock className="h-4 w-4 text-muted-foreground" />;
    case "approved":
    case "executed":
      return <CheckCircle className="h-4 w-4 text-success" />;
    case "rejected":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "expired":
      return <AlertTriangle className="h-4 w-4 text-warning" />;
    default:
      return null;
  }
}

function riskBadge(risk: string) {
  const color =
    risk === "read"
      ? "bg-green-500/10 text-green-600 dark:text-green-400"
      : risk === "write"
        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
        : risk === "destructive" || risk === "cost"
          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : risk === "publish"
            ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
            : "bg-gray-500/10 text-gray-600 dark:text-gray-400";
  return (
    <span className={cn("rounded px-2 py-0.5 text-xs font-medium", color)}>
      {risk}
    </span>
  );
}

export const ActionCard = memo(function ActionCard({ block }: Props) {
  const { t } = useTranslation();
  const { result } = block;

  if (!result || typeof result !== "object") {
    // Running state — show a spinner with the impact preview
    return (
      <div
        data-testid="action-card-pending"
        className="rounded-md border border-border bg-muted px-3 py-2 text-sm"
      >
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 animate-spin text-primary" />
          <span>{t("action.pending")}</span>
        </div>
      </div>
    );
  }

  const typedResult = result as ActionResult;
  const proposalState = typedResult.state ?? "pending";
  const impact = typedResult.impact ?? "";
  const risk = typedResult.risk ?? "read";
  const target = typedResult.target ?? "any";
  const tier = typedResult.tier ?? "auto";

  return (
    <div
      data-testid={`action-card-${proposalState}`}
      data-proposal-id={typedResult.proposalId}
      className={cn(
        "rounded-md border border-l-2 bg-muted px-3 py-2 text-sm",
        proposalState === "pending" && "border-l-primary",
        proposalState === "approved" || proposalState === "executed"
          ? "border-l-success"
          : proposalState === "rejected"
            ? "border-l-destructive"
            : proposalState === "expired"
              ? "border-l-warning"
              : "border-l-muted"
      )}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5">{statusIcon(proposalState)}</div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-semibold text-foreground">
              {t(`action.state.${proposalState}`, { defaultValue: proposalState })}
            </span>
            {riskBadge(risk)}
            <span className="text-xs text-muted-foreground">{target}</span>
          </div>
          <p className="text-xs text-foreground">{impact}</p>
          {proposalState === "pending" && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t("action.tier", { defaultValue: tier })}</span>
              <span>•</span>
              <span>ID: {typedResult.proposalId.slice(0, 8)}…</span>
            </div>
          )}
          {proposalState !== "pending" && (
            <div className="mt-2 text-xs text-muted-foreground">
              {t("action.result", { defaultValue: "已处理" })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
