// ── Board routes (add-line-boards-and-action-gate, task 10) ─────────────────
//
// GET /api/boards/:line — fetch a board's blocks
// Returns { line, title, originUrl, blocks: [...] } where each block has
// { id, type, title, data?, error? }.
//
// Unknown lines return 404 with an honest message.

import { getBoardAdapter, listBoardLines } from "../../lib/board-adapters.js";

export function registerBoardRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/boards/:line", async (req, res) => {
    const { line } = req.params;
    const adapter = getBoardAdapter(line);

    if (!adapter) {
      // Honest degradation: unknown line → 404 with guidance
      return res.status(404).json({
        error: "line_not_found",
        message: `该线尚未接入 (${line})`,
        availableLines: listBoardLines(),
      });
    }

    try {
      const result = await adapter.fetchBlocks({ email: req.user?.email ?? null });
      return res.json({
        line: adapter.id,
        title: adapter.title,
        originUrl: adapter.originUrl,
        ...result,
      });
    } catch (err) {
      console.error(`[boards/${line}] fetch failed:`, err.message);
      // Per-block errors are rendered by the UI; here we return a single
      // error block that covers the whole board.
      return res.json({
        line: adapter.id,
        title: adapter.title,
        originUrl: adapter.originUrl,
        blocks: [
          {
            id: "error",
            type: "metrics",
            title: "加载失败",
            error: err.message || "服务器错误",
          },
        ],
      });
    }
  });
}
