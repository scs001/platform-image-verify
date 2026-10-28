// MachinesPage.tsx — the unified machine console (add-unified-fleet-console).
//
// Cloud view of every steward-paired machine on this account: roster with
// derived health (silence / divergence / self-reported alerts), per-machine
// detail (deployment entries with their source, agent five-states, runtime
// occupancy, merge outcome), and the desired-state editor. Edits only land in
// the cloud desired set — the MACHINE pulls and applies them on its own beat;
// this page never drives the machine (no control channel, by design).
//
// Data sources: /api/machines (roster) and /api/machines/:id (detail) — the
// same shared routes the gateway and the single-process server mount.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface Health {
  silence: "online" | "silent" | "never_reported";
  alerts: { kind: string; count?: number; streak?: number; lastSeenAt?: number | null }[];
  divergenceStreak: number;
  lastSeenAt: number | null;
}

interface MachineRow {
  deviceId: string;
  label: string;
  boundAt: number | null;
  lastSeenAt: number | null;
  presence: { state?: string; os?: string; appVersion?: string } | null;
  desiredVersion: number;
  summary: {
    fleetCount: number | null;
    memberCount: number | null;
    enabledTaskCount: number | null;
    deploymentCount: number | null;
    capacity: { used: number; cap: number; unit: string } | null;
  };
  health: Health;
}

interface DeploymentRow {
  agentPath: string;
  packId: string;
  agentId: string;
  enabled: boolean;
  source: "manual" | "cloud";
}

interface DesiredEntry {
  packId: string;
  agentId: string;
  enabled: boolean;
}

interface MachineDetail {
  deviceId: string;
  detail: {
    at: number;
    capacity: { used: number; cap: number; unit: string } | null;
    deployments: DeploymentRow[];
    agents: { key: string; state: string; port: number | null; version: number | null }[];
    merge: { desiredVersionSeen: number | null; rejects?: { agentPath: string; code: string }[] } | null;
  } | null;
  desired: { version: number; entries: DesiredEntry[]; updatedAt: number | null };
  health: Health;
}

const POLL_MS = 15_000;
// A detail snapshot older than a few beats reads as stale, not live.
const STALE_AFTER_MS = 5 * 60_000;

function ageLabel(at: number | null | undefined, t: (k: string, o?: Record<string, unknown>) => string): string | null {
  if (!at) return null;
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return t("machines.age.seconds", { n: s });
  if (s < 3600) return t("machines.age.minutes", { n: Math.floor(s / 60) });
  return t("machines.age.hours", { n: Math.floor(s / 3600) });
}

const ALERT_KEYS: Record<string, string> = {
  silent: "machines.alerts.silent",
  divergence: "machines.alerts.divergence",
  crash_loop: "machines.alerts.crashLoop",
  pull_failures: "machines.alerts.pullFailures",
  merge_rejects: "machines.alerts.mergeRejects",
};

export function MachinesPage() {
  const { t } = useTranslation();
  const [machines, setMachines] = useState<MachineRow[] | null>(null);
  const [rosterCode, setRosterCode] = useState<string | null>(null);
  const [isAdminView, setIsAdminView] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MachineDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadRoster = useCallback(async () => {
    try {
      const r = await fetch("/api/machines");
      if (r.ok) {
        const doc = await r.json();
        setMachines(doc.machines ?? []);
        setIsAdminView(Boolean(doc.isAdminView));
        setRosterCode(null);
      } else {
        setRosterCode((await r.json().catch(() => ({}))).error || "roster_unavailable");
      }
    } catch {
      setRosterCode("roster_unavailable");
    }
  }, []);

  const loadDetail = useCallback(async (deviceId: string) => {
    try {
      const r = await fetch(`/api/machines/${encodeURIComponent(deviceId)}`);
      if (r.ok) setDetail(await r.json());
      else setDetail(null);
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void loadRoster();
    const timer = setInterval(() => void loadRoster(), POLL_MS);
    return () => clearInterval(timer);
  }, [loadRoster]);

  useEffect(() => {
    if (!openId) return;
    void loadDetail(openId);
    const timer = setInterval(() => void loadDetail(openId), POLL_MS);
    return () => clearInterval(timer);
  }, [openId, loadDetail]);

  const saveDesired = useCallback(
    async (deviceId: string, entries: DesiredEntry[]) => {
      setBusy(true);
      setSaveError(null);
      try {
        const r = await fetch(`/api/machines/${encodeURIComponent(deviceId)}/desired`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        });
        if (r.ok) {
          await loadDetail(deviceId);
          await loadRoster();
        } else {
          const doc = await r.json().catch(() => ({}));
          setSaveError(doc.error || "save_failed");
        }
      } catch {
        setSaveError("save_failed");
      } finally {
        setBusy(false);
      }
    },
    [loadDetail, loadRoster],
  );

  const desiredKey = (e: DesiredEntry) => `${e.packId}/${e.agentId}`;

  const toggleDesired = (entry: DesiredEntry) => {
    if (!detail || busy) return;
    const next = detail.desired.entries.map((e) => (desiredKey(e) === desiredKey(entry) ? { ...e, enabled: !e.enabled } : e));
    void saveDesired(detail.deviceId, next);
  };

  const removeDesired = (entry: DesiredEntry) => {
    if (!detail || busy) return;
    const next = detail.desired.entries.filter((e) => desiredKey(e) !== desiredKey(entry));
    void saveDesired(detail.deviceId, next);
  };

  const addDesiredFromDeployment = (d: DeploymentRow) => {
    if (!detail || busy) return;
    if (detail.desired.entries.some((e) => desiredKey(e) === `${d.packId}/${d.agentId}`)) return;
    void saveDesired(detail.deviceId, [...detail.desired.entries, { packId: d.packId, agentId: d.agentId, enabled: true }]);
  };

  const healthChip = (health: Health) => {
    if (health.alerts.length > 0) {
      return (
        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive" data-testid="machine-health-alert">
          {t(ALERT_KEYS[health.alerts[0]?.kind ?? ""] ?? "machines.alerts.other")}
        </span>
      );
    }
    if (health.silence === "online") {
      return <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs text-success">{t("machines.health.online")}</span>;
    }
    return <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t(health.silence === "never_reported" ? "machines.health.neverReported" : "machines.health.silent")}</span>;
  };

  const detailStale = detail?.detail ? Date.now() - detail.detail.at > STALE_AFTER_MS : false;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6" data-testid="machines-page">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{t("machines.title")}</h1>
        {isAdminView && <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t("machines.adminView")}</span>}
      </div>

      {rosterCode ? (
        <div className="rounded border border-border p-6 text-sm text-muted-foreground" data-testid="machines-error">
          {t("machines.rosterError")}
        </div>
      ) : !machines || machines.length === 0 ? (
        <div className="rounded border border-border p-6 text-sm text-muted-foreground" data-testid="machines-empty">
          {t("machines.empty")}
        </div>
      ) : (
        <ul className="space-y-2" data-testid="machines-list">
          {machines.map((m) => (
            <li key={m.deviceId}>
              <button
                type="button"
                onClick={() => setOpenId(m.deviceId)}
                className="flex w-full items-center justify-between rounded border border-border px-4 py-3 text-left hover:bg-muted/40"
                data-testid={`machine-row-${m.deviceId}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{m.label || m.deviceId}</span>
                    {healthChip(m.health)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("machines.summary.fleets", { n: m.summary.fleetCount ?? "—" })}
                    {" · "}
                    {t("machines.summary.members", { n: m.summary.memberCount ?? "—" })}
                    {" · "}
                    {t("machines.summary.deployments", { n: m.summary.deploymentCount ?? "—" })}
                    {m.summary.capacity ? ` · ${m.summary.capacity.used}/${m.summary.capacity.cap} ${m.summary.capacity.unit}` : ""}
                  </div>
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">{ageLabel(m.lastSeenAt, t) ?? ""}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {openId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setOpenId(null)} data-testid="machine-detail-overlay">
          <div className="h-full w-full max-w-xl overflow-y-auto bg-background p-6" onClick={(e) => e.stopPropagation()}>
            {!detail ? (
              <p className="text-sm text-muted-foreground">{t("machines.detailLoading")}</p>
            ) : (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">{detail.deviceId}</h2>
                  {healthChip(detail.health)}
                </div>

                {detail.detail ? (
                  <>
                    <p className={`text-xs ${detailStale ? "text-warning" : "text-muted-foreground"}`}>
                      {detailStale ? t("machines.detail.stale") : t("machines.detail.fresh")}
                      {` · ${ageLabel(detail.detail.at, t) ?? ""}`}
                    </p>

                    <section>
                      <h3 className="mb-2 text-sm font-medium">{t("machines.detail.deployments")}</h3>
                      {detail.detail.deployments.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("machines.detail.noDeployments")}</p>
                      ) : (
                        <ul className="space-y-1" data-testid="machine-deployments">
                          {detail.detail.deployments.map((d) => {
                            const desiredEntry = detail.desired.entries.find((e) => desiredKey(e) === `${d.packId}/${d.agentId}`);
                            const diverged = desiredEntry ? desiredEntry.enabled !== d.enabled : d.source === "cloud";
                            return (
                              <li key={d.agentPath} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                                <div className="min-w-0">
                                  <div className="truncate">
                                    {d.packId}/{d.agentId}
                                    <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${d.source === "cloud" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                                      {t(d.source === "cloud" ? "machines.source.cloud" : "machines.source.manual")}
                                    </span>
                                    {diverged && <span className="ml-1 rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">{t("machines.diverged")}</span>}
                                  </div>
                                  <div className="text-xs text-muted-foreground">{d.enabled ? t("machines.state.enabled") : t("machines.state.disabled")}</div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>

                    <section>
                      <h3 className="mb-2 text-sm font-medium">{t("machines.detail.agents")}</h3>
                      {detail.detail.agents.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("machines.detail.noAgents")}</p>
                      ) : (
                        <ul className="space-y-1" data-testid="machine-agents">
                          {detail.detail.agents.map((a) => (
                            <li key={a.key} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                              <span className="truncate">{a.key}</span>
                              <span className="text-xs text-muted-foreground">{a.state}{a.port ? ` · :${a.port}` : ""}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    {detail.detail.merge && detail.detail.merge.rejects && detail.detail.merge.rejects.length > 0 && (
                      <section>
                        <h3 className="mb-2 text-sm font-medium text-destructive">{t("machines.detail.mergeRejects")}</h3>
                        <ul className="space-y-1">
                          {detail.detail.merge.rejects.map((r) => (
                            <li key={`${r.agentPath}:${r.code}`} className="rounded border border-destructive/30 px-3 py-2 text-xs">
                              {r.agentPath} · {r.code}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("machines.detail.neverReported")}</p>
                )}

                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("machines.desired.title")}</h3>
                  <p className="mb-2 text-xs text-muted-foreground">{t("machines.desired.hint")}</p>
                  {detail.desired.entries.length === 0 ? (
                    <p className="text-xs text-muted-foreground" data-testid="desired-empty">{t("machines.desired.empty")}</p>
                  ) : (
                    <ul className="space-y-1" data-testid="desired-list">
                      {detail.desired.entries.map((e) => (
                        <li key={desiredKey(e)} className="flex items-center justify-between rounded border border-border px-3 py-2 text-sm">
                          <span className="min-w-0 truncate">
                            {e.packId}/{e.agentId}
                            <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${e.enabled ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                              {t(e.enabled ? "machines.desired.enabled" : "machines.desired.disabled")}
                            </span>
                          </span>
                          <span className="flex shrink-0 gap-2">
                            <button type="button" className="text-xs underline" disabled={busy} onClick={() => toggleDesired(e)}>
                              {t(e.enabled ? "machines.desired.disable" : "machines.desired.enable")}
                            </button>
                            <button type="button" className="text-xs underline text-destructive" disabled={busy} onClick={() => removeDesired(e)}>
                              {t("machines.desired.remove")}
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.detail && detail.detail.deployments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {detail.detail.deployments
                        .filter((d) => !detail.desired.entries.some((e) => desiredKey(e) === `${d.packId}/${d.agentId}`))
                        .map((d) => (
                          <button
                            key={d.agentPath}
                            type="button"
                            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/40"
                            disabled={busy}
                            onClick={() => addDesiredFromDeployment(d)}
                            data-testid={`desired-add-${d.packId}-${d.agentId}`}
                          >
                            + {d.packId}/{d.agentId}
                          </button>
                        ))}
                    </div>
                  )}
                  {saveError && <p className="mt-2 text-xs text-destructive">{t("machines.desired.saveError")}</p>}
                </section>

                <button type="button" className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted/40" onClick={() => setOpenId(null)}>
                  {t("machines.detail.close")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
