// ZhiyuPage.tsx — 萬星·智语: rooms list + pending invites + room creation
// (add-zhiyu-room group 9).
//
// Reads are server-owned like every other surface: the page re-fetches the
// list after each write instead of caching. The dual inbox below the rooms is
// where an invitation handshake is answered — invitations are ACTIONABLE rows
// (accept/decline), notifications are ambient (invite/call/minutes feed).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface RoomRow {
  id: string;
  title: string;
  ownerEmail: string;
  status: "active" | "ended";
  effectiveReplyCap: number;
  lastActivityAt: number;
  createdAt: number;
}

interface InviteRow {
  id: string;
  roomId: string;
  kind: "user" | "facade" | "agent";
  display: string;
  invitedBy: string;
  historyGrant: "join_from" | "full";
  room: { id: string; title: string } | null;
}

interface NoticeRow {
  id: string;
  type: string;
  roomId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
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

export function ZhiyuPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [notices, setNotices] = useState<NoticeRow[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [replyCap, setReplyCap] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [r, i, n] = await Promise.all([
        jcall<{ rooms: RoomRow[] }>("GET", "/api/zhiyu/rooms"),
        jcall<{ invites: InviteRow[] }>("GET", "/api/zhiyu/invites"),
        jcall<{ notifications: NoticeRow[]; unread: number }>("GET", "/api/zhiyu/notifications"),
      ]);
      setRooms(r.rooms);
      setInvites(i.invites);
      // Show every notification type (invites included) so the panel's row set
      // matches the unread count exactly — a badge can never point at nothing
      // (openspec: polish-web-surfaces, zhiyu-room 通知与触达).
      setNotices(n.notifications.slice(0, 20));
      setEnabled(true);
      setError(null);
    } catch (err) {
      setEnabled(false);
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Viewing this page clears the user's unread lane (openspec:
  // polish-web-surfaces, zhiyu-room 通知与触达). The fresh count is broadcast so
  // the nav badge clears at once — not on the sidebar's next 60s poll.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const out = await jcall<{ unread: number }>("POST", "/api/zhiyu/notifications/read-all");
        if (alive) {
          window.dispatchEvent(new CustomEvent("zhiyu:unread", { detail: { unread: out.unread } }));
        }
      } catch {
        /* unreachable server: the badge simply stays until the next poll */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const out = await jcall<{ room: RoomRow }>("POST", "/api/zhiyu/rooms", {
        title: title.trim(),
        ...(replyCap.trim() ? { replyCap: Number(replyCap) } : {}),
        ...(budget.trim() ? { dailyBudgetTurns: Number(budget) } : {}),
      });
      setCreateOpen(false);
      setTitle("");
      setReplyCap("");
      setBudget("");
      navigate(`/zhiyu/${out.room.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const answerInvite = async (invite: InviteRow, verdict: "accept" | "decline") => {
    try {
      await jcall("POST", `/api/zhiyu/invites/${invite.id}/${verdict}`);
      if (verdict === "accept") navigate(`/zhiyu/${invite.roomId}`);
      else void refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (enabled === false) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {t("zhiyu.unavailable", { error: error ?? "" })}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl overflow-y-auto p-6" data-testid="zhiyu-page">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("zhiyu.title")}</h1>
        <Button onClick={() => setCreateOpen(true)} data-testid="zhiyu-create-open">
          {t("zhiyu.createRoom")}
        </Button>
      </div>

      {error && <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      {invites.length > 0 && (
        <section className="mb-6 rounded-lg border p-4" data-testid="zhiyu-invites">
          <h2 className="mb-3 text-sm font-medium">{t("zhiyu.invites.title")}</h2>
          <ul className="space-y-2">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <b>{inv.display}</b> · {inv.room?.title ?? inv.roomId} · {t(`zhiyu.kind.${inv.kind}`)} ·{" "}
                  {t("zhiyu.invites.from", { by: inv.invitedBy })}
                </span>
                <span className="flex gap-2">
                  <Button size="sm" onClick={() => void answerInvite(inv, "accept")}>
                    {t("zhiyu.invites.accept")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void answerInvite(inv, "decline")}>
                    {t("zhiyu.invites.decline")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border" data-testid="zhiyu-rooms">
        {rooms.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{t("zhiyu.rooms.empty")}</p>
        ) : (
          <ul className="divide-y">
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50"
                  onClick={() => navigate(`/zhiyu/${room.id}`)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{room.title || room.id}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t("zhiyu.rooms.meta", {
                        status: t(`zhiyu.status.${room.status}`),
                        cap: room.effectiveReplyCap,
                        at: new Date(room.lastActivityAt).toLocaleString(),
                      })}
                    </span>
                  </span>
                  <span
                    className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      room.status === "active" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {t(`zhiyu.status.${room.status}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {notices.length > 0 && (
        <section className="mt-6 rounded-lg border p-4" data-testid="zhiyu-notices">
          <h2 className="mb-3 text-sm font-medium">{t("zhiyu.notices.title")}</h2>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {notices.map((n) => (
              <li key={n.id} className="flex justify-between gap-3">
                <span className="truncate">
                  {t(`zhiyu.notices.${n.type}`, {
                    room: String(n.payload?.roomTitle ?? ""),
                    from: String(n.payload?.from ?? n.payload?.invitedBy ?? ""),
                  })}
                </span>
                <span className="shrink-0 text-xs">{new Date(n.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("zhiyu.createRoom")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="zy-title">{t("zhiyu.form.title")}</Label>
              <Input id="zy-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("zhiyu.form.titlePlaceholder")} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="zy-cap">{t("zhiyu.form.replyCap")}</Label>
                <Input id="zy-cap" type="number" min={1} max={20} value={replyCap} onChange={(e) => setReplyCap(e.target.value)} placeholder={t("zhiyu.form.replyCapPlaceholder")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="zy-budget">{t("zhiyu.form.budget")}</Label>
                <Input id="zy-budget" type="number" min={1} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t("zhiyu.form.budgetPlaceholder")} />
              </div>
            </div>
            <Button className="w-full" disabled={busy} onClick={() => void create()} data-testid="zhiyu-create-submit">
              {t("zhiyu.form.submit")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
