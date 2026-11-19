// ── Copilot dock (add-line-boards-and-action-gate, tasks 14-15) ─────────────
//
// A dock holding a same-origin iframe of
// /chat?embed=copilot&board=<line>&preset=<agentId>.
//
// Entry point (scope-copilot-dock-to-line-surfaces): the dock is NO LONGER a
// global floating button. Only surfaces that resolve a line context mount
// `<CopilotDockTrigger />` in their own header — the line boards, the pack
// market, the fleets hub. Everywhere else the dock has nothing to add: with no
// board line its iframe is just a second conversation beside the main one, and
// the 萬星 cross-line copilot already owns the conversation entry there.
//
// Why an iframe: useChatStore is a module singleton. A second conversation
// panel in the same document would fight the main chat for its state. A
// same-origin iframe gets its own document, its own store instance and its
// own WS connection — full isolation with zero store refactoring.
//
// The board context rides the URL (first frame) and postMessage (updates);
// the context bar inside the embed shows exactly what was sent.
//
// Focused preset (copilot-dock-focused-preset): the dock asks the server which
// installed pack is this line's focused assistant and puts its agent id on the
// URL; the embed switches the runtime to it once connected. The preset is
// CELL-wide (dsh bakes it at initialize, a switch restarts the child), so the
// dock remembers the agent the main chat was on and restores it on close —
// unless the user picked something else meanwhile, which then stands.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Bot, Maximize2, Minimize2, X } from "lucide-react";
import { useChatStore } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import { useAppConfig } from "@/hooks/useAppConfig";
import { subscribePackInspection, type CopilotPackContext } from "@/lib/copilot-pack-context";

export interface CopilotPreset {
  line: string;
  agentId: string;
  agentName: string;
  packId: string;
  packName: string;
}

interface Props {
  send: (m: ClientMessage) => void;
  /** The shell's rail state. The dock panel sits to the right of the 240px rail
   *  so opening it never covers navigation; collapsed, it takes the corner. */
  navCollapsed?: boolean;
}

/** Page-header triggers announce themselves here; the dock is a singleton, so
 *  every trigger opens the same panel on whatever line the route resolves. */
const OPEN_EVENT = "copilot-dock:open";

/** Whether an `/agents` `?tab=` value addresses the pack market — the surface
 *  whose focused assistant is the 谦面 line.
 *
 *  Three values qualify, and the old check only accepted the middle one: the
 *  market page normalizes its own slug (`LEGACY_TAB.market → agents`) and writes
 *  the normalized value back to the URL, so by the time the dock reads it the
 *  string is `agents`. With only `"market"` accepted, opening the dock on the
 *  market surface produced a context-free frame — no `board=facet`, no focused
 *  preset (caught by e2e/copilot-dock.spec.js). An absent tab is the same
 *  surface too: `agents` is the first tab, i.e. the default.
 */
/** Maximized-state memory for the dock panel (unify-yizuo-copilot-surface 3.x).
 *  localStorage: a viewer preference has no business riding the profile API. */
const DOCK_SIZE_KEY = "platform.copilotDock.maximized";

function readDockMaximized(): boolean {
  try {
    return localStorage.getItem(DOCK_SIZE_KEY) === "1";
  } catch {
    return false;
  }
}

function isMarketTab(tab: string | null): boolean {
  return tab === null || tab === "" || tab === "market" || tab === "agents";
}

/** Route → line, the same mapping the dock itself uses. The trigger needs it
 *  too: it only exists where the dock would carry a line. */
function lineForLocation(pathname: string, search: string): string | null {
  const match = pathname.match(/^\/boards\/([^/]+)/);
  if (match?.[1]) return match[1];
  if (pathname === "/packs" || (pathname === "/agents" && isMarketTab(new URLSearchParams(search).get("tab")))) {
    return "facet";
  }
  if (pathname === "/fleets" || pathname.startsWith("/fleets/")) return "fleets";
  return null;
}

/**
 * The dock's page-held entry (scope-copilot-dock-to-line-surfaces).
 *
 * Deliberately router-free: the pack market also mounts inside the facet shell,
 * which has no Router ancestor (same trap that made PackMarketView read
 * `window.location` instead of useSearchParams). Whether the surface carries a
 * line is decided by WHERE this is mounted — the line boards, the market, the
 * fleets hub — not by a hook inside it.
 *
 * Keeps `data-testid="copilot-fab"` — the name predates this change (it was a
 * floating action button) and four e2e assertions anchor on it, so renaming
 * buys nothing but churn. Renders nothing inside the embed (a framed document
 * is a guest, never a host).
 */
export function CopilotDockTrigger({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { copilotEnabled } = useAppConfig();
  const embedded =
    (typeof window !== "undefined" && window.self !== window.top) ||
    (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("embed") === "copilot");
  if (!copilotEnabled || embedded) return null;
  const label = t("copilot.open");
  return (
    <button
      type="button"
      data-testid="copilot-fab"
      data-dock-trigger=""
      aria-label={label}
      title={label}
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className={`inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted ${className}`}
    >
      <Bot className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );
}

export function CopilotDock({ send, navCollapsed = false }: Props) {
  const location = useLocation();
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(readDockMaximized);
  const { copilotEnabled, lineBoardsEnabled } = useAppConfig();
  const [open, setOpen] = useState(false);
  const [boardLine, setBoardLine] = useState<string | null>(null);
  // The resolved preset for `boardLine`, keyed on the line it was fetched for
  // so a stale answer from a previous board never rides into the iframe URL.
  const [preset, setPreset] = useState<{ line: string; copilot: CopilotPreset | null } | null>(null);
  const agentBeforeOpenRef = useRef<string | null>(null);
  const injectedAgentRef = useRef<string | null>(null);

  // Derive the dock's line context from the route. /boards/:line is the
  // board path; the 壹座 pack market carries the facet line (add-facet-copilot
  // D1) — the same focused-preset resolution serves both. The market surface
  // moved out of the (now dissolved) agents hub to its own /packs route, and
  // the dock's facet line had to move with it: without this the market opened
  // a context-free dock on the one surface whose whole contract is the 谦面
  // assistant line. The legacy /agents?tab=market URL stays mapped so old
  // bookmarks keep behaving. Other routes open context-free.
  useEffect(() => {
    const line = lineForLocation(location.pathname, location.search);
    setBoardLine(line);
  }, [location.pathname, location.search]);

  // Resolve the line's focused assistant as soon as the line is known (before
  // the trigger is clicked), so opening the dock does not wait on the request.
  useEffect(() => {
    if (!boardLine) {
      setPreset(null);
      return;
    }
    // The fleets hub is not a line board — its focus resolves from the
    // installed-pack roster, not the line-board copilot lane; the board-gate
    // (lineBoardsEnabled) does not apply to it.
    if (boardLine === "fleets") {
      let cancelled = false;
      fetch("/api/fleets/copilot")
        .then((r) => (r.ok ? r.json() : { copilot: null }))
        .then((body) => {
          if (!cancelled) setPreset({ line: boardLine, copilot: body?.copilot ?? null });
        })
        .catch(() => {
          if (!cancelled) setPreset({ line: boardLine, copilot: null });
        });
      return () => {
        cancelled = true;
      };
    }
    if (!lineBoardsEnabled) {
      setPreset(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/boards/${encodeURIComponent(boardLine)}/copilot`)
      .then((r) => (r.ok ? r.json() : { copilot: null }))
      .then((body) => {
        if (!cancelled) setPreset({ line: boardLine, copilot: body?.copilot ?? null });
      })
      .catch(() => {
        if (!cancelled) setPreset({ line: boardLine, copilot: null });
      });
    return () => {
      cancelled = true;
    };
  }, [boardLine, lineBoardsEnabled]);

  // Keep the iframe's context in sync when the user navigates between boards
  // while the dock is open. Same-origin, so postMessage is safe and direct.
  useEffect(() => {
    if (!open || !boardLine) return;
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "copilot_context", board: boardLine }, window.location.origin);
    }
  }, [boardLine, open]);

  // The market tab's inspected pack (add-facet-copilot D2): subscribe while
  // the dock is open on the facet line and forward it into the embed. The
  // context message re-sends on every change (open/switch/close), so the bar
  // always shows what the host sees.
  const [packCtx, setPackCtx] = useState<CopilotPackContext | null>(null);
  useEffect(() => {
    if (!open || boardLine !== "facet") {
      setPackCtx(null);
      return;
    }
    return subscribePackInspection(setPackCtx);
  }, [open, boardLine]);
  useEffect(() => {
    if (!open) return;
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "copilot_pack", pack: packCtx }, window.location.origin);
    }
  }, [packCtx, open]);

  // Teams-hub context (add-teams-hub-formation-board 3.1): while open on the
  // fleets line, mirror the hub's roster/selection into the embed so the
  // architect sees what the owner sees. Same postMessage channel as the
  // board/facet contexts.
  const [fleetCtx, setFleetCtx] = useState<string | null>(null);
  useEffect(() => {
    if (!open || boardLine !== "fleets") {
      setFleetCtx(null);
      return;
    }
    const onSelection = (e: Event) => {
      setFleetCtx((e as CustomEvent<{ fleetId?: string | null }>).detail?.fleetId ?? null);
    };
    window.addEventListener("fleets:selection", onSelection);
    return () => window.removeEventListener("fleets:selection", onSelection);
  }, [open, boardLine]);
  useEffect(() => {
    if (!open || boardLine !== "fleets") return;
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "copilot_context", board: "fleets", fleetId: fleetCtx }, window.location.origin);
    }
  }, [fleetCtx, open, boardLine]);

  // The preset answer for THIS line; still in flight → hold the iframe (a
  // reload after the first frame would re-run the switch for nothing). The
  // fleets line waits the same way — its answer comes from /api/fleets/copilot.
  const resolved = !boardLine || (boardLine !== "fleets" && !lineBoardsEnabled) || preset?.line === boardLine;
  const copilot = preset?.line === boardLine ? preset.copilot : null;

  // What the open dock last injected. Kept while the dock navigates to a route
  // without a board, so closing there still restores the main chat's agent.
  useEffect(() => {
    if (open && resolved && copilot?.agentId) injectedAgentRef.current = copilot.agentId;
  }, [open, resolved, copilot]);

  // The dock's own iframe runs this same App: without this guard the embed
  // would grow a second dock inside the dock. Any framed document is a guest,
  // never a host.
  const embedded =
    new URLSearchParams(location.search).get("embed") === "copilot" ||
    (typeof window !== "undefined" && window.self !== window.top);

  // Page-held triggers open the dock (scope-copilot-dock-to-line-surfaces).
  // Capture the main chat's agent here rather than in the trigger so the
  // restore-on-close contract keeps exactly one writer.
  useEffect(() => {
    if (!copilotEnabled || embedded) return;
    const onOpen = () => {
      agentBeforeOpenRef.current = useChatStore.getState().currentAgent;
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [copilotEnabled, embedded]);

  if (!copilotEnabled || embedded) return null;

  const src = `/chat?embed=copilot${boardLine ? `&board=${encodeURIComponent(boardLine)}` : ""}${
    copilot ? `&preset=${encodeURIComponent(copilot.agentId)}` : ""
  }`;

  const closeDock = () => {
    setOpen(false);
    const injected = injectedAgentRef.current;
    const current = useChatStore.getState().currentAgent;
    const before = agentBeforeOpenRef.current;
    agentBeforeOpenRef.current = null;
    injectedAgentRef.current = null;
    // Restore only what the dock changed: the runtime must still be on the
    // injected assistant, and it must differ from where the main chat was.
    if (injected && current === injected && before !== injected) {
      send({ type: "set_agent", id: before ?? "local" });
    }
  };

  if (!open) return null;

  return (
    <aside
      data-testid="copilot-dock"
      data-maximized={maximized ? "on" : "off"}
      // Right of the 240px rail so opening the dock never covers nav; the
      // rail collapsing (md:left-0) takes it back to the corner.
      //
      // Resize (unify-yizuo-copilot-surface 3.x): the browser's own handle
      // instead of a hand-written drag — same result, a tenth of the code.
      // The max-* caps keep the panel inside the viewport on narrow screens.
      className={`fixed bottom-0 left-0 z-40 flex flex-col overflow-hidden rounded-tr-lg border border-border bg-background shadow-2xl ${
        maximized ? "h-[92dvh] w-[min(720px,92vw)]" : "h-[70vh] w-[min(420px,92vw)]"
      } ${navCollapsed ? "md:left-0" : "md:left-[240px]"}`}
      style={{
        resize: "both",
        maxWidth: "92vw",
        maxHeight: "92dvh",
        minWidth: "320px",
        minHeight: "240px",
      }}
    >
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <span className="text-sm font-medium">副驾</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="copilot-maximize"
            aria-label={maximized ? t("copilot.restore") : t("copilot.maximize")}
            title={maximized ? t("copilot.restore") : t("copilot.maximize")}
            onClick={() => {
              setMaximized((value) => {
                const next = !value;
                try {
                  localStorage.setItem(DOCK_SIZE_KEY, next ? "1" : "0");
                } catch {
                  /* private mode: no memory, no breakage */
                }
                return next;
              });
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {maximized ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            data-testid="copilot-close"
            aria-label="关闭副驾"
            onClick={closeDock}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {resolved ? (
        <iframe
          data-testid="copilot-frame"
          title="副驾"
          src={src}
          className="min-h-0 flex-1 border-0"
        />
      ) : (
        <div
          data-testid="copilot-frame-pending"
          className="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground"
        >
          正在加载副驾…
        </div>
      )}
    </aside>
  );
}
