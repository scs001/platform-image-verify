// ── Copilot dock (add-line-boards-and-action-gate, tasks 14-15) ─────────────
//
// A global floating entry (bottom-right) that opens a right-side dock holding
// a same-origin iframe of /chat?embed=copilot&board=<line>.
//
// Why an iframe: useChatStore is a module singleton. A second conversation
// panel in the same document would fight the main chat for its state. A
// same-origin iframe gets its own document, its own store instance and its
// own WS connection — full isolation with zero store refactoring.
//
// The board context rides the URL (first frame) and postMessage (updates);
// the context bar inside the embed shows exactly what was sent.

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Bot, X } from "lucide-react";

export function CopilotDock() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [boardLine, setBoardLine] = useState<string | null>(null);

  // Derive the current board line from the route (/boards/:line). The dock
  // opens with that context; on other routes it opens context-free.
  useEffect(() => {
    const match = location.pathname.match(/^\/boards\/([^/]+)/);
    setBoardLine(match?.[1] ?? null);
  }, [location.pathname]);

  // Keep the iframe's context in sync when the user navigates between boards
  // while the dock is open. Same-origin, so postMessage is safe and direct.
  useEffect(() => {
    if (!open || !boardLine) return;
    const frame = document.querySelector<HTMLIFrameElement>("[data-testid=copilot-frame]");
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "copilot_context", board: boardLine }, window.location.origin);
    }
  }, [boardLine, open]);

  const src = `/chat?embed=copilot${boardLine ? `&board=${encodeURIComponent(boardLine)}` : ""}`;

  return (
    <>
      {!open && (
        <button
          type="button"
          data-testid="copilot-fab"
          aria-label="打开副驾"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
        >
          <Bot className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {open && (
        <aside
          data-testid="copilot-dock"
          className="fixed bottom-0 right-0 z-40 flex h-[70vh] w-[min(420px,92vw)] flex-col overflow-hidden rounded-tl-lg border border-border bg-background shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
            <span className="text-sm font-medium">副驾</span>
            <button
              type="button"
              data-testid="copilot-close"
              aria-label="关闭副驾"
              onClick={() => setOpen(false)}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <iframe
            data-testid="copilot-frame"
            title="副驾"
            src={src}
            className="min-h-0 flex-1 border-0"
          />
        </aside>
      )}
    </>
  );
}
