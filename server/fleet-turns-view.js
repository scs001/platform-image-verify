// The architect's turn-diagnosis page (fix-tool-result-cost).
//
// `fleet_turns_read` is how a builder/operator answers "who is failing and
// why". It used to ship up to 100 rows as PRETTY-printed JSON with every field
// the row carried — on the deployment that was 2.3MB across one cell's traces,
// the third largest tool result after the handoff list and dsh's own `read`.
// Pretty-printing alone roughly doubles the bytes, and the diagnosis needs a
// handful of fields per row, not the whole row.
//
// Pure and exported so the page has a test face (the MCP module spawns a server
// at import, so nothing can import it).
export const TURNS_PAGE_DEFAULT = 20;
export const TURNS_PAGE_MAX = 100;
const ERROR_CHARS = 240;

export function shapeTurnsPage(turns = [], requestedLimit = null) {
  const requested = Number(requestedLimit);
  const page = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), TURNS_PAGE_MAX) : TURNS_PAGE_DEFAULT;
  const rows = (Array.isArray(turns) ? turns : []).slice(0, page).map((t) => ({
    id: t.id,
    memberId: t.memberId,
    source: t.source,
    status: t.status,
    errorKind: t.errorKind ?? null,
    // The first line of an error is the diagnosis; the rest is stack noise that
    // would be paid for on every read.
    error: t.error ? String(t.error).slice(0, ERROR_CHARS) : null,
    model: t.model ?? null,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    usage: t.usage ?? null,
    turnId: t.turnId ?? null,
    runId: t.runId ?? null,
    parentTurnId: t.parentTurnId ?? null,
    edgeKind: t.edgeKind ?? null,
  }));
  return { turns: rows, count: rows.length, page, truncated: rows.length >= page };
}
