// ZhiyuRoomPage.tsx — the room itself (add-zhiyu-room group 9).
//
// Stream model (design D-E): one EventSource per room pumps seq-monotone rows
// (messages + system/event rows) and, on the `overlay` event, ephemeral
// agent_start/delta/done marks rendered as a transient "answering" bubble.
// Persisted rows win: an overlay bubble dissolves when its agent's settled
// message row arrives over the pump. Duty circuit (take over / hand back /
// call) acts on the roster; posting is itself a take-over.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface MemberRow {
  id: string;
  kind: "user" | "facade" | "agent";
  ref: string;
  onBehalfOf: string | null;
  display: string;
  presence: "active" | "away" | "on_duty" | "listening";
  state: string;
}

interface RoomDetail {
  id: string;
  title: string;
  ownerEmail: string;
  status: "active" | "ended";
  effectiveReplyCap: number;
  idleMinutes: number;
  replyCap: number | null;
  dailyBudgetTurns: number | null;
}

interface StreamRow {
  seq: number;
  kind: "human" | "agent" | "system" | "event";
  senderMemberId: string | null;
  fromAgent: boolean;
  visibility: string;
  content: string;
  meta: Record<string, unknown> | null;
  provenance: string | null;
  createdAt: number;
}

interface Overlay {
  memberId: string;
  display: string;
  text: string;
  startedAt: number;
}

async function jcall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}

const EVENT_LABEL_KEYS = new Set([
  "member_joined",
  "member_left",
  "member_removed",
  "invite_sent",
  "invite_accepted",
  "invite_declined",
  "invite_auto_declined",
  "room_ended",
  "room_hatched",
  "reply_cap_changed",
  "budget_changed",
  "reply_cap_hit",
  "budget_exhausted",
  "agent_busy",
  "agent_failed",
  "agent_declined_insolvent",
  "pass",
  "all_passed",
  "needs_you",
  "take_over",
  "hand_back",
  "owner_transferred",
  "room_renamed",
]);

export function ZhiyuRoomPage() {
  const { t } = useTranslation();
  const { roomId = "" } = useParams();
  const navigate = useNavigate();
  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [myMemberId, setMyMemberId] = useState<string | null>(null);
  const [rows, setRows] = useState<StreamRow[]>([]);
  const [overlays, setOverlays] = useState<Record<string, Overlay>>({});
  const [privateOpen, setPrivateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composer, setComposer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({ kind: "user", ref: "", onBehalfOf: "", display: "", historyGrant: "join_from" });
  const [capForm, setCapForm] = useState("");
  const [budgetForm, setBudgetForm] = useState("");
  // Website-embed management (add-zhiyu-website-embed group 5, owner only).
  const [widgetStatus, setWidgetStatus] = useState<{
    enabled: boolean;
    publicOpen: boolean;
    token: { fingerprint: string; allowlist: string[]; createdAt: number; revoked: boolean } | null;
    linkToken: { fingerprint: string; createdAt: number } | null;
  } | null>(null);
  const [widgetDomainInput, setWidgetDomainInput] = useState("");
  const [widgetIssued, setWidgetIssued] = useState<{ token: string; siteSecret: string; snippet: string } | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [widgetBusy, setWidgetBusy] = useState(false);
  const [widgetNote, setWidgetNote] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const membersRef = useRef<MemberRow[]>([]);
  membersRef.current = members;

  const load = useCallback(async () => {
    try {
      const d = await jcall<{ room: RoomDetail; members: MemberRow[]; myMemberId: string | null }>("GET", `/api/zhiyu/rooms/${roomId}`);
      setRoom(d.room);
      setMembers(d.members);
      setMyMemberId(d.myMemberId);
      setCapForm(d.room.replyCap != null ? String(d.room.replyCap) : "");
      setBudgetForm(d.room.dailyBudgetTurns != null ? String(d.room.dailyBudgetTurns) : "");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Widget status loads lazily with the settings dialog (owner-only surface).
  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const st = await jcall<typeof widgetStatus>("GET", `/api/zhiyu/rooms/${roomId}/widget`);
        if (!cancelled) {
          setWidgetStatus(st);
          if (st?.token?.allowlist) setWidgetDomainInput(st.token.allowlist.join("\n"));
        }
      } catch {
        if (!cancelled) setWidgetStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, roomId]);

  const widgetEnable = async () => {
    setWidgetBusy(true);
    setWidgetNote(null);
    try {
      const allowlist = widgetDomainInput.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const out = await jcall<{ token: string; siteSecret: string; snippet: string } & Record<string, unknown>>(
        "POST",
        `/api/zhiyu/rooms/${roomId}/widget`,
        { allowlist },
      );
      setWidgetIssued({ token: out.token, siteSecret: out.siteSecret, snippet: out.snippet });
      const st = await jcall<typeof widgetStatus>("GET", `/api/zhiyu/rooms/${roomId}/widget`);
      setWidgetStatus(st);
    } catch (err) {
      setWidgetNote((err as Error).message);
    } finally {
      setWidgetBusy(false);
    }
  };

  const widgetAction = async (action: "patch" | "rotate-secret" | "revoke" | "share-link" | "share-link/revoke") => {
    setWidgetBusy(true);
    setWidgetNote(null);
    try {
      if (action === "patch") {
        const allowlist = widgetDomainInput.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        await jcall("PATCH", `/api/zhiyu/rooms/${roomId}/widget`, { allowlist });
        setWidgetNote("白名单已更新");
      } else if (action === "rotate-secret") {
        const out = await jcall<{ siteSecret: string }>("POST", `/api/zhiyu/rooms/${roomId}/widget/rotate-secret`);
        setWidgetIssued({ token: "", siteSecret: out.siteSecret, snippet: "" });
        setWidgetNote("站点密钥已轮换（旧密钥即刻失效）");
      } else if (action === "revoke") {
        await jcall("POST", `/api/zhiyu/rooms/${roomId}/widget/revoke`);
        setWidgetIssued(null);
        setWidgetStatus(null);
        const st = await jcall<typeof widgetStatus>("GET", `/api/zhiyu/rooms/${roomId}/widget`);
        setWidgetStatus(st);
      } else if (action === "share-link") {
        const out = await jcall<{ url: string }>("POST", `/api/zhiyu/rooms/${roomId}/share-link`);
        setShareUrl(out.url);
      } else if (action === "share-link/revoke") {
        await jcall("POST", `/api/zhiyu/rooms/${roomId}/share-link/revoke`);
        setShareUrl(null);
        setWidgetNote("进房链接已吊销");
      }
      if (action !== "revoke" && action !== "share-link/revoke") {
        const st = await jcall<typeof widgetStatus>("GET", `/api/zhiyu/rooms/${roomId}/widget`);
        setWidgetStatus(st);
      }
    } catch (err) {
      setWidgetNote((err as Error).message);
    } finally {
      setWidgetBusy(false);
    }
  };

  const copyText = async (text: string, note: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setWidgetNote(note);
    } catch {
      setWidgetNote("复制失败，请手动选择复制");
    }
  };

  // SSE pump + overlay events.
  useEffect(() => {
    if (!roomId) return;
    const es = new EventSource(`/api/zhiyu/rooms/${roomId}/events`);
    es.onmessage = (ev) => {
      try {
        const row = JSON.parse(ev.data) as StreamRow;
        setRows((prev) => (prev.some((r) => r.seq === row.seq) ? prev : [...prev, row]));
        if (row.kind === "agent") {
          setOverlays((prev) => {
            if (!row.senderMemberId || !prev[row.senderMemberId]) return prev;
            const next = { ...prev };
            delete next[row.senderMemberId];
            return next;
          });
        }
        if (row.kind === "system" && row.meta && ["member_joined", "member_left", "member_removed", "take_over", "hand_back", "room_ended"].includes(String(row.meta.event))) {
          void load();
        }
      } catch { /* malformed frame */ }
    };
    es.addEventListener("overlay", (ev) => {
      try {
        const o = JSON.parse((ev as MessageEvent).data) as { type: string; memberId: string; display?: string; delta?: string; outcome?: string };
        if (o.type === "agent_start") {
          setOverlays((prev) => ({ ...prev, [o.memberId]: { memberId: o.memberId, display: o.display ?? "", text: "", startedAt: Date.now() } }));
        } else if (o.type === "agent_delta") {
          setOverlays((prev) => {
            const cur = prev[o.memberId];
            if (!cur) return prev;
            return { ...prev, [o.memberId]: { ...cur, text: cur.text + (o.delta ?? "") } };
          });
        } else if (o.type === "agent_done") {
          setOverlays((prev) => {
            const next = { ...prev };
            delete next[o.memberId];
            return next;
          });
        }
      } catch { /* malformed overlay */ }
    });
    return () => es.close();
  }, [roomId, load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rows/overlays are intentional re-scroll triggers, not values the effect body reads
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [rows, overlays]);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const me = members.find((m) => m.id === myMemberId) ?? null;
  const isOwner = Boolean(room && me && room.ownerEmail === me.ref);
  const active = room?.status === "active";

  // Fleet bridge state (add-zhiyu-team-memory 刀B). Subscriptions are event
  // sources, not members; the summon plan separates serving members (can be
  // invited) from cockpit-only posts (named honestly, never fake-invited).
  interface FleetSub { id: string; fleetId: string; fleetName: string }
  interface SummonPlan { fleetId: string; fleetName: string; summonable: { ref: string; title?: string }[]; cockpitOnly: string[] }
  const [fleetSubs, setFleetSubs] = useState<FleetSub[] | null>(null);
  const [fleetIdDraft, setFleetIdDraft] = useState("");
  const [summonPlan, setSummonPlan] = useState<SummonPlan | null>(null);
  const [summonResult, setSummonResult] = useState<{ ref: string; ok: boolean; error?: string }[] | null>(null);
  const reloadFleetSubs = useCallback(async () => {
    if (!isOwner || !active) return setFleetSubs(null);
    try {
      const r = await jcall<{ subscriptions: FleetSub[] }>("GET", `/api/zhiyu/rooms/${roomId}/fleet-subscriptions`);
      setFleetSubs(r.subscriptions);
    } catch {
      setFleetSubs(null); // the bridge face degrades to absence, not an error
    }
  }, [isOwner, active, roomId]);
  useEffect(() => {
    void reloadFleetSubs();
  }, [reloadFleetSubs]);

  const label = (row: StreamRow): string => {
    if (row.provenance) return t("zhiyu.room.hatchedSender");
    const m = row.senderMemberId ? memberById.get(row.senderMemberId) : null;
    if (row.kind === "human") return m?.display || m?.ref || t("zhiyu.room.memberFallback");
    if (row.kind === "agent") {
      const base = m?.display || t("zhiyu.room.agentFallback");
      return m?.kind === "facade" && m.onBehalfOf ? t("zhiyu.room.facadeLabel", { name: base, owner: m.onBehalfOf }) : base;
    }
    return t("zhiyu.room.systemLabel");
  };

  const send = async () => {
    const content = composer.trim();
    if (!content) return;
    setComposer("");
    try {
      await jcall("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content });
    } catch (err) {
      setError((err as Error).message);
      setComposer(content);
    }
  };

  // @mention completion on the last @ fragment.
  const mentionFragment = useMemo(() => {
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(composer);
    return m?.[2] ?? null;
  }, [composer]);
  const mentionCandidates = useMemo(() => {
    if (mentionFragment === null) return [];
    const frag = mentionFragment.toLowerCase();
    return members
      .filter((m) => (m.kind === "agent" || m.kind === "facade") && m.state === "active")
      .filter((m) => m.display.toLowerCase().includes(frag) || m.ref.toLowerCase().includes(frag))
      .slice(0, 6);
  }, [mentionFragment, members]);

  const completeMention = (display: string) => {
    setComposer((prev) => prev.replace(/@([^\s@]{0,30})$/, `@${display} `));
  };

  const act = async (path: string, body?: unknown) => {
    try {
      await jcall("POST", path, body ?? {});
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const invite = async () => {
    try {
      await jcall("POST", `/api/zhiyu/rooms/${roomId}/invites`, {
        kind: inviteForm.kind,
        ref: inviteForm.ref.trim().toLowerCase(),
        ...(inviteForm.onBehalfOf.trim() ? { onBehalfOf: inviteForm.onBehalfOf.trim().toLowerCase() } : {}),
        ...(inviteForm.display.trim() ? { display: inviteForm.display.trim() } : {}),
        historyGrant: inviteForm.historyGrant,
      });
      setInviteOpen(false);
      setInviteForm({ kind: "user", ref: "", onBehalfOf: "", display: "", historyGrant: "join_from" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const presenceLabel = (m: MemberRow) => {
    if (m.kind === "user") return t(`zhiyu.room.presence.${m.presence}`);
    if (m.kind === "facade") return t(`zhiyu.room.presence.${m.presence}`);
    return t("zhiyu.room.presence.seated");
  };

  if (error && !room) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm text-muted-foreground">
        <p>{error}</p>
        <Button variant="outline" onClick={() => navigate("/zhiyu")}>{t("zhiyu.room.back")}</Button>
      </div>
    );
  }

  const visibleRows = rows.filter((r) => !(r.kind === "event" && !EVENT_LABEL_KEYS.has(String(r.meta?.event ?? ""))));
  const privateRows = rows.filter((r) => myMemberId && r.visibility === `private:${myMemberId}`);

  return (
    <div className="flex h-full min-h-0" data-testid="zhiyu-room">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{room?.title ?? roomId}</h1>
            <p className="text-xs text-muted-foreground">
              {t("zhiyu.room.headerMeta", { cap: room?.effectiveReplyCap ?? "—", status: t(`zhiyu.status.${room?.status ?? "active"}`) })}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setPrivateOpen((v) => !v)} data-testid="zhiyu-private-toggle">
              {t("zhiyu.room.privateWindow")}{privateRows.length ? ` (${privateRows.length})` : ""}
            </Button>
            {active && (
              <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)} data-testid="zhiyu-invite-open">
                {t("zhiyu.room.invite")}
              </Button>
            )}
            {isOwner && (
              <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)} data-testid="zhiyu-settings-open">
                {t("zhiyu.room.settings")}
              </Button>
            )}
          </div>
        </header>

        {error && <div className="mx-4 mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="zhiyu-stream">
          {visibleRows.map((row) => {
            if (row.kind === "system" || row.kind === "event") {
              const key = String(row.meta?.event ?? "");
              // A system row whose content IS the message (e.g. the guest
              // greeting) renders its text; meta-only rows keep the label.
              return (
                <div key={row.seq} className="my-1.5 text-center text-xs text-muted-foreground" data-testid={`zy-event-${key}`}>
                  {row.content?.trim()
                    ? row.content
                    : t(`zhiyu.event.${key}`, {
                        name: String(
                          row.meta?.display ?? (row.meta?.member as { display?: string } | undefined)?.display ?? row.meta?.by ?? row.meta?.to ?? "",
                        ),
                        value: String(row.meta?.effective ?? row.meta?.replyCap ?? row.meta?.dailyBudgetTurns ?? ""),
                      })}
                </div>
              );
            }
            return (
              <div key={row.seq} className={`group mb-3 flex ${row.kind === "agent" ? "" : "flex-row-reverse"}`} data-testid={`zy-msg-${row.seq}`}>
                <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${row.kind === "agent" ? "bg-muted" : "bg-primary text-primary-foreground"}`}>
                  <div className={`mb-0.5 text-xs ${row.kind === "agent" ? "text-muted-foreground" : "text-primary-foreground/70"}`}>{label(row)}</div>
                  <div className="whitespace-pre-wrap break-words">{row.content}</div>
                </div>
              </div>
            );
          })}
          {Object.values(overlays).map((o) => (
            <div key={o.memberId} className="mb-3 flex" data-testid="zy-overlay">
              <div className="max-w-[75%] rounded-2xl bg-muted px-3.5 py-2 text-sm opacity-80">
                <div className="mb-0.5 text-xs text-muted-foreground">{o.display} · {t("zhiyu.room.answering")}</div>
                <div className="whitespace-pre-wrap break-words">{o.text || "…"}</div>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {privateOpen && (
          <div className="border-t bg-muted/30 px-4 py-3" data-testid="zhiyu-private-panel">
            <h3 className="mb-2 text-xs font-medium">{t("zhiyu.room.privateWindow")}</h3>
            {privateRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("zhiyu.room.privateEmpty")}</p>
            ) : (
              <ul className="max-h-40 space-y-1.5 overflow-y-auto text-sm">
                {privateRows.map((row) => (
                  <li key={row.seq} className="rounded-md bg-background px-2.5 py-1.5">
                    <span className="mr-2 text-xs text-muted-foreground">{label(row)}</span>
                    {row.content}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {active && (
          <div className="relative border-t p-3">
            {mentionCandidates.length > 0 && (
              <div className="absolute bottom-full left-3 mb-1 w-64 rounded-md border bg-popover p-1 shadow-md" data-testid="zy-mentions">
                {mentionCandidates.map((m) => (
                  <button key={m.id} type="button" className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted" onClick={() => completeMention(m.display)}>
                    @{m.display} <span className="text-xs text-muted-foreground">{m.kind === "facade" ? `(${m.onBehalfOf})` : m.ref}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={t("zhiyu.room.composerPlaceholder")}
                className="min-h-[44px] flex-1"
                data-testid="zhiyu-composer"
              />
              <Button onClick={() => void send()} disabled={!composer.trim()} data-testid="zhiyu-send">
                {t("zhiyu.room.send")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <aside className="hidden w-64 shrink-0 border-l p-3 md:block" data-testid="zhiyu-roster">
        <h3 className="mb-2 text-xs font-medium">{t("zhiyu.room.roster", { count: members.filter((m) => m.state === "active").length })}</h3>
        <ul className="space-y-1.5">
          {members.filter((m) => m.state === "active").map((m) => (
            <li key={m.id} className="rounded-md border px-2.5 py-1.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium">{m.display}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t(`zhiyu.kind.${m.kind}`)}</span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{presenceLabel(m)}</span>
                <span className="flex gap-1">
                  {m.kind === "user" && me && m.ref !== me.ref && active && (
                    <button type="button" className="text-xs text-primary hover:underline" onClick={() => void act(`/api/zhiyu/rooms/${roomId}/call`, { target: m.ref })} data-testid={`zy-call-${m.ref}`}>
                      {t("zhiyu.room.call")}
                    </button>
                  )}
                  {m.kind === "facade" && me && m.onBehalfOf === me.ref && active && (
                    m.presence === "on_duty" ? (
                      <button type="button" className="text-xs text-primary hover:underline" onClick={() => void act(`/api/zhiyu/rooms/${roomId}/takeover`)} data-testid="zy-takeover">
                        {t("zhiyu.room.takeOver")}
                      </button>
                    ) : (
                      <button type="button" className="text-xs text-primary hover:underline" onClick={() => void act(`/api/zhiyu/rooms/${roomId}/handback`)} data-testid="zy-handback">
                        {t("zhiyu.room.handBack")}
                      </button>
                    )
                  )}
                  {isOwner && m.id !== myMemberId && active && (
                    <button type="button" className="text-xs text-destructive hover:underline" onClick={() => void act(`/api/zhiyu/rooms/${roomId}/remove`, { memberId: m.id })}>
                      {t("zhiyu.room.remove")}
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>

        {/* Fleet bridge (add-zhiyu-team-memory 刀B): owner-facing subscription
            list + summon. Subscriptions are event sources, NOT members — the
            section names that distinction itself. */}
        {isOwner && active && (
          <div className="mt-4 border-t pt-3" data-testid="zy-fleet-bridge">
            <h3 className="mb-1.5 text-xs font-medium">{t("zhiyu.fleet.title")}</h3>
            <ul className="space-y-1" data-testid="zy-fleet-subs">
              {(fleetSubs ?? []).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs">
                  <span className="min-w-0 truncate">{s.fleetName}</span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-destructive hover:underline"
                    onClick={async () => {
                      await jcall("DELETE", `/api/zhiyu/rooms/${roomId}/fleet-subscriptions/${s.id}`);
                      await reloadFleetSubs();
                    }}
                    data-testid={`zy-fleet-unsub-${s.id}`}
                  >
                    {t("zhiyu.fleet.unsubscribe")}
                  </button>
                </li>
              ))}
              {(fleetSubs ?? []).length === 0 && <li className="text-xs text-muted-foreground">{t("zhiyu.fleet.none")}</li>}
            </ul>
            <div className="mt-2">
              <input
                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
                placeholder={t("zhiyu.fleet.fleetIdPlaceholder")}
                value={fleetIdDraft}
                onChange={(e) => setFleetIdDraft(e.target.value)}
                data-testid="zy-fleet-id-input"
              />
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  onClick={async () => {
                    setSummonPlan(null);
                    const r = await jcall<{ plan: SummonPlan }>("POST", `/api/zhiyu/rooms/${roomId}/fleet-summon`, { fleetId: fleetIdDraft, dryRun: true });
                    setSummonPlan(r.plan);
                  }}
                  data-testid="zy-fleet-preview"
                >
                  {t("zhiyu.fleet.preview")}
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                  disabled={!summonPlan || !summonPlan.summonable.length}
                  onClick={async () => {
                    const r = await jcall<{ results: { ref: string; ok: boolean; error?: string }[] }>("POST", `/api/zhiyu/rooms/${roomId}/fleet-summon`, { fleetId: fleetIdDraft });
                    setSummonResult(r.results);
                    setFleetIdDraft("");
                    await reloadFleetSubs();
                  }}
                  data-testid="zy-fleet-summon"
                >
                  {t("zhiyu.fleet.summon")}
                </button>
              </div>
              {summonPlan && (
                <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground" data-testid="zy-fleet-plan">
                  {summonPlan.summonable.map((m) => (
                    <div key={m.ref}>✓ {m.title ?? m.ref}</div>
                  ))}
                  {summonPlan.cockpitOnly.map((title) => (
                    <div key={title} className="text-amber-600">• {t("zhiyu.fleet.cockpitOnly", { title })}</div>
                  ))}
                </div>
              )}
              {summonResult && (
                <div className="mt-1.5 space-y-0.5 text-xs" data-testid="zy-fleet-summon-result">
                  {summonResult.map((r) => (
                    <div key={r.ref} className={r.ok ? "text-primary" : "text-destructive"}>
                      {r.ok ? "✓" : "✗"} {r.ref}{r.error ? `：${r.error}` : ""}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </aside>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("zhiyu.invite.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              {(["user", "facade", "agent"] as const).map((k) => (
                <Button key={k} size="sm" variant={inviteForm.kind === k ? "default" : "outline"} onClick={() => setInviteForm((f) => ({ ...f, kind: k }))}>
                  {t(`zhiyu.kind.${k}`)}
                </Button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label>{inviteForm.kind === "user" ? t("zhiyu.invite.refUser") : t("zhiyu.invite.refAgent")}</Label>
              <Input value={inviteForm.ref} onChange={(e) => setInviteForm((f) => ({ ...f, ref: e.target.value }))} placeholder={inviteForm.kind === "user" ? "someone@corp.com" : "pack-id:agent-id"} />
            </div>
            {inviteForm.kind !== "user" && (
              <div className="space-y-1.5">
                <Label>{t("zhiyu.invite.onBehalfOf")}</Label>
                <Input value={inviteForm.onBehalfOf} onChange={(e) => setInviteForm((f) => ({ ...f, onBehalfOf: e.target.value }))} placeholder="owner@corp.com" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{t("zhiyu.invite.display")}</Label>
              <Input value={inviteForm.display} onChange={(e) => setInviteForm((f) => ({ ...f, display: e.target.value }))} placeholder={t("zhiyu.invite.displayPlaceholder")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("zhiyu.invite.historyGrant")}</Label>
              <div className="flex gap-2">
                {(["join_from", "full"] as const).map((g) => (
                  <Button key={g} size="sm" variant={inviteForm.historyGrant === g ? "default" : "outline"} onClick={() => setInviteForm((f) => ({ ...f, historyGrant: g }))}>
                    {t(`zhiyu.invite.grant.${g}`)}
                  </Button>
                ))}
              </div>
            </div>
            <Button className="w-full" onClick={() => void invite()} data-testid="zhiyu-invite-submit">
              {t("zhiyu.invite.submit")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("zhiyu.settings.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("zhiyu.settings.cap")}</Label>
                <Input type="number" min={1} max={20} value={capForm} onChange={(e) => setCapForm(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{t("zhiyu.settings.budget")}</Label>
                <Input type="number" min={1} value={budgetForm} onChange={(e) => setBudgetForm(e.target.value)} placeholder={t("zhiyu.settings.budgetPlaceholder")} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  void (async () => {
                    try {
                      await jcall("PATCH", `/api/zhiyu/rooms/${roomId}`, {
                        ...(capForm.trim() ? { replyCap: Number(capForm) } : { replyCap: null }),
                        ...(budgetForm.trim() ? { dailyBudgetTurns: Number(budgetForm) } : { dailyBudgetTurns: null }),
                      });
                      await load();
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  })()
                }
                data-testid="zhiyu-settings-save"
              >
                {t("zhiyu.settings.save")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  void (async () => {
                    if (window.confirm(t("zhiyu.settings.endConfirm"))) {
                      await act(`/api/zhiyu/rooms/${roomId}/end`);
                      navigate("/zhiyu");
                    }
                  })();
                }}
              >
                {t("zhiyu.settings.end")}
              </Button>
            </div>

            {/* Website embed (add-zhiyu-website-embed). Owner-only surface; the
                public lane reports separately whether it is deployment-open. */}
            <div className="border-t pt-4">
              <h3 className="mb-2 text-sm font-medium">{t("zhiyu.widget.title")}</h3>
              {widgetStatus && !widgetStatus.publicOpen && (
                <p className="mb-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">{t("zhiyu.widget.publicClosed")}</p>
              )}
              <p className="mb-2 text-xs text-muted-foreground">
                {widgetStatus?.enabled
                  ? t("zhiyu.widget.statusOn", { fp: widgetStatus.token?.fingerprint ?? "" })
                  : t("zhiyu.widget.statusOff")}
              </p>
              <div className="space-y-2">
                <Label className="text-xs">{t("zhiyu.widget.allowlist")}</Label>
                <Textarea
                  value={widgetDomainInput}
                  onChange={(e) => setWidgetDomainInput(e.target.value)}
                  placeholder={"shop.example.com\n*.partner.com"}
                  className="min-h-[64px] text-xs"
                />
                <div className="flex flex-wrap gap-2">
                  {!widgetStatus?.enabled ? (
                    <Button size="sm" disabled={widgetBusy} onClick={() => void widgetEnable()} data-testid="zy-widget-enable">
                      {t("zhiyu.widget.enable")}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" disabled={widgetBusy} onClick={() => void widgetAction("patch")}>
                        {t("zhiyu.widget.saveAllowlist")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void copyText(`<script src="${location.origin}/zhiyu/widget.js" data-room="${widgetIssued?.token ?? ""}" async></script>`, "已复制 snippet")}>
                        {t("zhiyu.widget.copySnippet")}
                      </Button>
                      <Button size="sm" variant="outline" disabled={widgetBusy} onClick={() => void widgetAction("rotate-secret")}>
                        {t("zhiyu.widget.rotate")}
                      </Button>
                      <Button size="sm" variant="destructive" disabled={widgetBusy} onClick={() => void widgetAction("revoke")}>
                        {t("zhiyu.widget.revoke")}
                      </Button>
                    </>
                  )}
                </div>
                {widgetIssued?.token && (
                  <div className="rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    <div className="font-medium">{t("zhiyu.widget.onceOnly")}</div>
                    <code className="mt-1 block break-all">{widgetIssued.snippet}</code>
                    <code className="mt-1 block break-all">site-secret: {widgetIssued.siteSecret}</code>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" disabled={widgetBusy} onClick={() => void widgetAction("share-link")}>
                    {t("zhiyu.widget.makeLink")}
                  </Button>
                  {shareUrl && (
                    <button type="button" className="truncate text-xs text-primary hover:underline" onClick={() => void copyText(shareUrl, "链接已复制")}>
                      {shareUrl}
                    </button>
                  )}
                </div>
                {widgetNote && <p className="text-xs text-muted-foreground">{widgetNote}</p>}
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  老客服台（Chatwoot）商家两条线可并行：既有会话继续走{" "}
                  <a className="text-primary hover:underline" href="/external/crm-desk/sso">客服台</a>
                  ，新接待访客可从本房间的嵌入或进房链接起线，分期迁移互不打断。
                </p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
