import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { useChatStore } from "@platform/core";
import { Chat } from "@/components/Chat";
import { ChatHeader } from "@/components/ChatHeader";
import { useBranding } from "@/hooks/useAppConfig";
import { ChatWelcome } from "@/components/ChatWelcome";
import { Composer } from "@/components/Composer";
import { PlanPanel } from "@/components/PlanPanel";
import { OnboardingTour, tourDone } from "@/components/OnboardingTour";
import type { ClientMessage } from "@platform/core";

// Chat page: the empty state (ChatWelcome) and the in-session state
// (ChatHeader + Chat + Composer) are mutually exclusive — they never render
// together. The branch is keyed on `turns.length === 0` per design D1: the
// welcome is a "no turns" affordance, the header takes over once the user
// starts or resumes a conversation. `clearView` flips back to the welcome.
//
// The composer draft is owned HERE (not inside Composer) so it survives the
// welcome → in-session branch swap, and so ChatWelcome's suggested-prompt
// cards can prefill it: clicking a card fills the composer and focuses it —
// the user stays in control of what actually gets sent.
//
// Sessions are deep-linkable: /chat/:sessionId loads that session, and the
// URL follows the active session both ways (refresh and back keep context).
interface Props {
  send: (m: ClientMessage) => void;
  // Toggles the off-canvas nav drawer (below md, rendered by App).
  onToggleNav?: () => void;
}

export function ChatPage({ send, onToggleNav }: Props) {
  const { t } = useTranslation();
  const { brand } = useBranding();
  const { sessionId: urlSessionId } = useParams();
  const [searchParams] = useSearchParams();
  // Embed mode (add-line-boards-and-action-gate): the copilot dock mounts this
  // page inside a same-origin iframe. It hides the sidebar/header chrome but
  // keeps the transcript, composer and action cards.
  const embedMode = searchParams.get("embed") === "copilot";
  const boardLine = searchParams.get("board") || null;
  // Focused preset (copilot-dock-focused-preset): the dock puts the line's
  // focused assistant on the URL; the embed switches the runtime to it once
  // the socket is up and the current agent is known. The switch is cell-wide
  // (a dsh restart) and is sent once per attempt, never looped — a rejection
  // (main chat mid-answer) clears pendingConfig without an agent_changed, and
  // the context bar offers a retry.
  const presetAgent = embedMode ? searchParams.get("preset") || null : null;
  const currentAgent = useChatStore((s) => s.currentAgent);
  const currentPreset = useChatStore((s) => s.currentPreset);
  const configErrorSeq = useChatStore((s) => s.configErrorSeq);
  const agents = useChatStore((s) => s.agents);
  const [focusAttempt, setFocusAttempt] = useState(0);
  // The attempt the switch was sent for, and the refusal count seen then: a
  // refusal is "the count moved since", never "pendingConfig went back to
  // null" (the connect burst clears that too).
  const [focusSent, setFocusSent] = useState<{ attempt: number; errorSeq: number } | null>(null);
  // Length-and-pending subscription: this page branches on emptiness —
  // subscribing to the whole turns array would re-render it per streamed
  // token. An optimistic session switch clears turns the instant the request
  // leaves (perf-session-open), and that pending view belongs to the
  // transcript's skeleton, not the welcome.
  const isEmpty = useChatStore((s) => s.turns.length === 0 && s.pendingSession === null);
  const status = useChatStore((s) => s.status);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  // Send the focus switch once per attempt, only when the runtime is known to
  // be on another agent: switching to the current agent returns without an
  // agent_changed broadcast, which would leave pendingConfig stuck. Waiting
  // for currentPreset means the connect burst is over and the runtime is
  // live — a switch sent mid-boot would be refused.
  useEffect(() => {
    if (!presetAgent || status !== "connected" || currentAgent === null || currentPreset === null) return;
    if (currentAgent === presetAgent || focusSent?.attempt === focusAttempt) return;
    setFocusSent({ attempt: focusAttempt, errorSeq: configErrorSeq });
    useChatStore.getState().setPendingConfig("agent");
    send({ type: "set_agent", id: presetAgent });
  }, [presetAgent, status, currentAgent, currentPreset, focusAttempt, focusSent, configErrorSeq, send]);
  const focused = !!presetAgent && currentAgent === presetAgent;
  const focusRejected =
    !!presetAgent && !focused && focusSent?.attempt === focusAttempt && configErrorSeq > focusSent.errorSeq;
  const focusedName = agents.find((a) => a.id === presetAgent)?.name ?? presetAgent;

  const [draft, setDraft] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const prefillComposer = (text: string) => {
    setDraft(text);
    setFocusTick((n) => n + 1);
  };

  // Cross-page handoff in: a page that parked a draft (library "Start
  // conversation") navigates here with the WS store carrying it. Consume
  // exactly once — read + clear — so a stale draft can never leak into a later
  // visit. Subscribed (not mount-time only) because a queued prompt's cancel
  // also parks its text here (concurrent-chat-sessions), and that happens while
  // this page is already mounted.
  const parkedDraft = useChatStore((s) => s.composerDraft);
  useEffect(() => {
    if (!parkedDraft) return;
    useChatStore.getState().setComposerDraft(null);
    setDraft(parkedDraft);
    setFocusTick((n) => n + 1);
  }, [parkedDraft]);

  // Cluster termination fallback (dynamic-cluster-composer spec): when the
  // cluster bound to this session is terminated, the session falls back to the
  // built-in agent. The banner below carries the notice; the store clears the
  // chip itself (chat-store's cluster_terminated case).
  const clusterTerminatedNotice = useChatStore((s) => s.clusterTerminatedNotice);
  const clearClusterTerminatedNotice = useChatStore((s) => s.clearClusterTerminatedNotice);
  useEffect(() => {
    if (!clusterTerminatedNotice) return;
    send({ type: "set_agent", id: "local" });
  }, [clusterTerminatedNotice, send]);

  // First-run tour (add-onboarding-tutorial): present on the welcome state
  // when this browser hasn't finished it, or when the help center's replay
  // affordance clears the marker and fires the replay event.
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (isEmpty && !tourDone()) setTourOpen(true);
    const onReplay = () => setTourOpen(true);
    window.addEventListener("onboarding:replay", onReplay);
    return () => window.removeEventListener("onboarding:replay", onReplay);
  }, [isEmpty]);

  // Deep link in: a session id in the URL that isn't current loads it. The URL
  // changes ONLY through user navigation (sidebar rows / new chat navigate
  // explicitly; refresh keeps its place) — a reactive URL-follows-session
  // effect here would race this one and ping-pong switch_session between the
  // stale URL and the fresh session id.
  //
  // The serviced-url ref is what kills the ping-pong (perf-session-open): the
  // optimistic flip moves `currentSessionId` synchronously while the router
  // param lags a render, so an effect keyed on their (dis)agreement "corrects"
  // a just-clicked switch back toward the stale URL. Service each URL change
  // exactly once; a restore after a failed switch intentionally does not
  // re-arm (the row re-click is the retry). A URL seen while the socket is
  // still connecting is NOT serviced — the send would be lost and the ref
  // would suppress the retry — so it waits for `status` to arm the effect.
  const servicedUrlRef = useRef<string | null | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `status` is a deliberate trigger — a URL first seen while connecting must re-arm once the socket opens (the send would have been dropped)
  useEffect(() => {
    if (urlSessionId === servicedUrlRef.current) return;
    if (urlSessionId && urlSessionId !== currentSessionId) {
      if (useChatStore.getState().status !== "connected") return;
      servicedUrlRef.current = urlSessionId;
      send({ type: "switch_session", id: urlSessionId });
      return;
    }
    servicedUrlRef.current = urlSessionId;
  }, [urlSessionId, currentSessionId, status, send]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Embed mode hides the nav chrome entirely: the copilot dock owns its
          own close affordance and the page is a conversation panel. */}
      {!embedMode && onToggleNav && (
        <div className="flex items-center border-b border-border bg-card px-3 py-1.5 md:hidden">
          <button
            type="button"
            onClick={onToggleNav}
            aria-label={t("nav.openMenu")}
            data-testid="nav-toggle"
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="ml-1 truncate text-xs text-muted-foreground">
            {t("sidebar.brand", { brand })}
          </span>
        </div>
      )}
      {/* Copilot context bar (embed mode): shows what the assistant is told
          about the board it was opened from, and lets the user clear it; the
          focus segment names the preset the dock injected (or why it did
          not). Clearing the board context leaves the preset alone — the
          preset is restored by closing the dock, not by this bar. */}
      {embedMode && (boardLine || presetAgent) && (
        <div
          data-testid="copilot-context-bar"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
        >
          {boardLine && (
            <span data-testid="copilot-context-board">
              {t("copilot.context", { defaultValue: "正在看" })}: {boardLine}
            </span>
          )}
          {presetAgent ? (
            focused ? (
              <span data-testid="copilot-focus" data-state="focused">
                {t("copilot.focused", { defaultValue: "聚焦预设" })}: {focusedName}
              </span>
            ) : focusRejected ? (
              <span data-testid="copilot-focus" data-state="rejected" className="inline-flex items-center gap-1">
                {t("copilot.focusRejected", { defaultValue: "主对话正在回答，暂未聚焦" })}
                <button
                  type="button"
                  data-testid="copilot-focus-retry"
                  onClick={() => setFocusAttempt((n) => n + 1)}
                  className="rounded border border-border px-1.5 py-0.5 hover:bg-background hover:text-foreground"
                >
                  {t("copilot.focusRetry", { defaultValue: "重试" })}
                </button>
              </span>
            ) : (
              <span data-testid="copilot-focus" data-state="pending">
                {t("copilot.focusPending", { defaultValue: "正在切换到聚焦预设…" })}
              </span>
            )
          ) : (
            <span data-testid="copilot-focus" data-state="unfocused">
              {t("copilot.unfocused", { defaultValue: "未聚焦：该线助手 pack 未安装" })}
            </span>
          )}
          {boardLine && (
            <button
              type="button"
              onClick={() => {
                const url = new URL(window.location.href);
                url.searchParams.delete("board");
                window.history.replaceState({}, "", url.toString());
              }}
              className="ml-auto rounded px-2 py-0.5 hover:bg-background hover:text-foreground"
            >
              {t("copilot.clearContext", { defaultValue: "清除" })}
            </button>
          )}
        </div>
      )}
      {/* A dropped socket used to be legible only in the sidebar's 6px status
          dot — and it stranded the streaming state. The store now finalizes
          the turn on disconnect; this banner names what happened while the
          WS hook's backoff reconnects. */}
      {status === "disconnected" && (
        <div
          data-testid="connection-banner"
          className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" />
          {t("chat.connectionLost")}
          <button
            type="button"
            data-testid="connection-retry"
            onClick={() => window.dispatchEvent(new Event("platform:reconnect"))}
            className="ml-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted"
          >
            {t("chat.retry")}
          </button>
        </div>
      )}
      {/* Two columns: the chat column (header + log + composer) and, on wide
          viewports with a live plan, the progress panel beside it. The panel
          unmounts when the plan is empty, so the chat column re-centers with
          no reserved gutter (add-plan-progress-panel). */}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isEmpty ? (
            <>
              <ChatWelcome onPrefill={prefillComposer} send={send} />
              <Composer send={send} value={draft} onChange={setDraft} focusTick={focusTick} />
              {tourOpen && <OnboardingTour onFinish={() => setTourOpen(false)} />}
            </>
          ) : (
            <>
              <ChatHeader send={send} />
              {clusterTerminatedNotice && (
                <div
                  data-testid="cluster-terminated-banner"
                  className="flex items-center justify-between gap-3 border-b border-border bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground"
                >
                  <span className="truncate">
                    {t("chat.cluster.terminatedNotice", { name: clusterTerminatedNotice })}
                  </span>
                  <button
                    type="button"
                    onClick={() => clearClusterTerminatedNotice()}
                    aria-label={t("common.dismiss")}
                    className="shrink-0 rounded p-1 hover:bg-muted hover:text-foreground"
                  >
                    ×
                  </button>
                </div>
              )}
              <Chat send={send} onPrefill={prefillComposer} />
              <Composer send={send} value={draft} onChange={setDraft} focusTick={focusTick} />
            </>
          )}
        </div>
        <PlanPanel />
      </div>
    </main>
  );
}

// Re-export for the Ctrl+O shortcut helper if needed elsewhere.
export const useChatToggleAll = useChatStore;
