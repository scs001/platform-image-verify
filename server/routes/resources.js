// ── Resource library REST surface (openspec: add-resource-library) ───────────
//
// List, save a workspace file, rename, delete. Mutations broadcast
// `resources_changed` from the service; the event payload is deliberately thin
// (action + id + type) and clients refetch — library lists are small, and that
// removes all client-side merge logic.
//
// Byte serving is NOT here: stored files are served by the file route's
// `root=resources` (server/routes/files.js), inheriting its containment,
// disposition and Range/ETag behavior unchanged.

import * as resources from "../../resources.js";

function errorResponse(res, err) {
  res.status(err.status || 500).json({ error: err.message, code: err.code || "error" });
}

export function registerResourceRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/resources", (req, res) => {
    const { type, q, limit, offset } = req.query ?? {};
    res.json(
      resources.list({
        type: typeof type === "string" && type ? type : null,
        q: typeof q === "string" && q.trim() ? q.trim() : null,
        limit,
        offset,
      })
    );
  });

  app.post("/api/resources", async (req, res) => {
    const body = req.body ?? {};
    try {
      const result = await resources.saveFile({
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
        messageId: Number.isInteger(body.messageId) ? body.messageId : null,
        path: body.path,
        // The agent workspace, same source as the file-serving route's
        // `workspace` root — a file must be inside the workspace to be saved.
        workspaceRoot: ctx.dshBridge?.getCwd?.() || process.cwd(),
      });
      // inserted=false is a success with an explanation ("already in the
      // library"), not an error — the client shows the difference.
      res.json({ inserted: result.inserted, resource: result.resource });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.patch("/api/resources/:id", (req, res) => {
    try {
      const resource = resources.rename(req.params.id, req.body?.title);
      if (!resource) return res.status(404).json({ error: "资源不存在" });
      res.json({ resource });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.delete("/api/resources/:id", async (req, res) => {
    try {
      const removed = await resources.remove(req.params.id);
      if (!removed) return res.status(404).json({ error: "资源不存在" });
      res.json({ removed: { id: removed.id, type: removed.type } });
    } catch (err) {
      errorResponse(res, err);
    }
  });
}