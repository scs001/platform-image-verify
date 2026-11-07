// ConnectorBindingsView — the binding-first face of the connector card
// (add-connector-bindings 6.2).
//
// A pack declares what external systems it needs (`connectorBindings`); the
// connector account decides whether a provider can be reached at all. This view
// leads with the former, because "which of my installed packs still need
// something" is the question the user actually asks — the account list below it
// is how they answer.
//
// State vocabulary is the ledger's, rendered verbatim (connector-bindings spec):
//   satisfied     connected；令牌是否已授予另说（granted 决定按钮是「去授权」还是「撤销授权」）
//   missing       no connection for this provider yet — the user's todo
//   stale         the connection existed and stopped working — reconnect
//   unwired       the CATALOG does not cover the declared operations — a
//                 product capability gap, never degraded to `missing` here,
//                 because telling the user to connect something that cannot
//                 work is worse than saying nothing
//   undetermined  the catalog could not be asked — not a gap, not a todo
// `deprecated` rows are absent from this view: they record a binding key the
// pack no longer declares, so they are history, not a requirement.
//
// Every row carries the one action that repairs or reverses it (spec: 每条提供
// 对应动作). `unwired` and `undetermined` carry none on purpose — no user
// gesture closes a catalog gap, and an outage is not a todo. Connect/reconnect
// need the console's address from the deployment baseline; without it they are
// hidden rather than rendered as dead links (the account area below still
// offers paste/zero-paste connect).
//
// Local fetch on purpose (same shape as ChatwootConnectPanel): the card is
// self-contained and reads the projection GET /api/connections already serves.
// Nothing here holds credential material — the projection carries states only.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export interface BindingRow {
  packId: string;
  key: string;
  provider: string;
  operations: string[];
  status: "satisfied" | "missing" | "stale" | "unwired" | "undetermined" | "deprecated";
  optional: boolean;
  // Asked of the credential, not inferred: a satisfied binding without a live
  // token still has to be granted.
  granted?: boolean;
  grantedAt?: string | null;
}

export interface BindingSummary {
  packs: number;
  bindings: number;
  unresolved: number;
  unwired: number;
}

const STATE_STYLE: Record<string, string> = {
  satisfied: "bg-success/15 text-success",
  missing: "bg-warning/15 text-warning",
  stale: "bg-destructive/15 text-destructive",
  unwired: "bg-muted text-muted-foreground",
  undetermined: "bg-muted text-muted-foreground",
};

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.code ?? payload?.error ?? `http_${response.status}`;
    throw new Error(String(code));
  }
  return payload;
}

export function ConnectorBindingsView({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { connectorConnection } = useExtensionsStore();
  const [rows, setRows] = useState<BindingRow[] | null>(null);
  const [summary, setSummary] = useState<BindingSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/connections");
      if (!r.ok) return null;
      const body = await r.json();
      const connector = (body.connections ?? []).find((c: { id: string }) => c.id === "connector");
      if (!connector || !Array.isArray(connector.bindings)) return null;
      return { rows: connector.bindings as BindingRow[], summary: (connector.bindingSummary ?? null) as BindingSummary | null };
    } catch {
      /* unknown stays unknown — never render "nothing needed" on a failed read */
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const next = await load();
      if (!alive || !next) return;
      setRows(next.rows);
      setSummary(next.summary);
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // The console's user shell (deployment baseline origin + /me). Absent when
  // the baseline has no connector row — then connect/reconnect links are hidden.
  const meUrl = connectorConnection?.connectorUrl
    ? `${connectorConnection.connectorUrl}${connectorConnection.mePath}`
    : null;

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      const next = await load();
      if (next) {
        setRows(next.rows);
        setSummary(next.summary);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Unknown, or an installed set that declares no bindings: nothing to say.
  // (An empty state here would read as an achievement; the account area below
  // already carries the "connect something" affordance.)
  if (!rows) return null;
  const visible = rows.filter((row) => row.status !== "deprecated");
  if (visible.length === 0) return null;

  const byPack = new Map<string, BindingRow[]>();
  for (const row of visible) {
    const list = byPack.get(row.packId) ?? [];
    list.push(row);
    byPack.set(row.packId, list);
  }

  const actionFor = (row: BindingRow) => {
    const id = `${row.packId}:${row.key}`;
    if (row.status === "satisfied") {
      return row.granted ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy === id}
          data-testid="connector-binding-action"
          data-action="revoke"
          onClick={() =>
            act(id, () => postJson("/api/connector/bindings/revoke", { packId: row.packId, bindingKey: row.key }))
          }
        >
          {t("settings.connections.bindings.action.revoke")}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={busy === id}
          data-testid="connector-binding-action"
          data-action="grant"
          onClick={() =>
            act(id, () =>
              postJson("/api/connector/bindings/grant", { packId: row.packId, bindingKeys: [row.key] }),
            )
          }
        >
          {t("settings.connections.bindings.action.grant")}
        </Button>
      );
    }
    // A dead or absent connection is repaired inside the connector console.
    // There is no documented per-provider deep link, so the link opens the
    // console's own connections shell rather than inventing a query parameter.
    if ((row.status === "missing" || row.status === "stale") && meUrl) {
      return (
        <a
          href={meUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="connector-binding-action"
          data-action={row.status === "stale" ? "reconnect" : "connect"}
          className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {t(
            row.status === "stale"
              ? "settings.connections.bindings.action.reconnect"
              : "settings.connections.bindings.action.connect",
          )}
        </a>
      );
    }
    return null;
  };

  return (
    <div data-testid="connector-bindings-view" className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="plug" size={14} className="text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">{t("settings.connections.bindings.title")}</span>
        {summary && (
          <span className="text-xs text-muted-foreground" data-testid="connector-bindings-summary">
            {t("settings.connections.bindings.summary", {
              packs: summary.packs,
              bindings: summary.bindings,
              unresolved: summary.unresolved,
              unwired: summary.unwired,
            })}
          </span>
        )}
      </div>

      {error && (
        <p className="px-1 text-xs text-destructive" data-testid="connector-bindings-error">
          {t("settings.connections.bindings.actionFailed", { error })}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {[...byPack.entries()].map(([packId, packRows]) => (
          <li key={packId} data-testid="connector-binding-pack" data-pack={packId} className="flex flex-col gap-1">
            <p className="px-1 text-xs font-medium text-muted-foreground">{packId}</p>
            <ul className="flex flex-col gap-1">
              {packRows.map((row) => {
                const state = row.status;
                return (
                  <li
                    key={`${packId}:${row.key}`}
                    data-testid="connector-binding-row"
                    data-binding-key={row.key}
                    data-provider={row.provider}
                    data-state={state}
                    data-optional={row.optional ? "1" : "0"}
                    data-granted={row.granted ? "1" : "0"}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-1.5"
                  >
                    <span className="text-sm">{row.provider || row.key}</span>
                    {row.operations.length > 0 && (
                      <span className="flex gap-1">
                        {row.operations.map((op) => (
                          <span
                            key={op}
                            className="rounded-sm bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {t(`settings.connections.bindings.operations.${op}`, { defaultValue: op })}
                          </span>
                        ))}
                      </span>
                    )}
                    {row.optional && (
                      <span
                        data-testid="connector-binding-optional"
                        className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {t("settings.connections.bindings.optional")}
                      </span>
                    )}
                    {row.granted && row.grantedAt && (
                      <span data-testid="connector-binding-granted-at" className="text-[11px] text-muted-foreground">
                        {t("settings.connections.bindings.grantedAt", {
                          when: new Date(row.grantedAt).toLocaleString(),
                        })}
                      </span>
                    )}
                    <div className="flex-1" />
                    <span
                      data-testid="connector-binding-state"
                      data-state={state}
                      className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLE[state] ?? "bg-muted text-muted-foreground"}`}
                    >
                      {t(`settings.connections.bindings.state.${state}`, { defaultValue: state })}
                    </span>
                    {actionFor(row)}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>

      {/* `unwired` and `undetermined` get one sentence each, and only when
          present: they are the two states a badge alone misreads. The first is
          a capability gap no account closes; the second is an outage, not an
          answer. */}
      {visible.some((row) => row.status === "unwired") && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="connector-bindings-unwired-hint">
          {t("settings.connections.bindings.hint.unwired")}
        </p>
      )}
      {visible.some((row) => row.status === "undetermined") && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="connector-bindings-undetermined-hint">
          {t("settings.connections.bindings.hint.undetermined")}
        </p>
      )}
    </div>
  );
}
