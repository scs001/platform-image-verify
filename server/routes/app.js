// App device-pairing endpoints (openspec: add-device-pairing-auth) — the
// same five routes the gateway serves, backed by the SAME shared module
// (gateway/app-auth.js) so both entrypoints keep one pairing implementation.
//
// Auth shape mirrors server/routes/mp.js: registerAuth's gate runs before
// these routes, so /api/app/devices and DELETE /api/app/bind/:deviceId never
// see an unauthenticated caller (req.user resolves a Logto cookie, an MP/app
// Bearer token, or a forward-auth identity — an app token carries the account
// email, so the app can manage its own bindings). The three pairing routes
// are exempt from the session requirement (server/auth.js prefix list): a
// native app has no browser session; each call authenticates through its own
// bind code / device key.
//
// JSON bodies arrive pre-parsed by server.js's global express.json().

export function registerAppRoutes(ctx) {
  const { app, appAuth } = ctx;

  app.post("/api/app/pair", async (req, res) => {
    const r = await appAuth.pair(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  app.post("/api/app/challenge", (req, res) => {
    const r = appAuth.challenge(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ nonce: r.nonce, ttlMs: r.ttlMs });
  });

  app.post("/api/app/login", (req, res) => {
    const r = appAuth.login(req.body ?? {});
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ token: r.token, email: r.email });
  });

  app.get("/api/app/devices", (req, res) => {
    if (!req.user?.email) return res.status(401).json({ error: "Authentication required" });
    res.json(appAuth.devicesFor(req.user.email));
  });

  app.delete("/api/app/bind/:deviceId", async (req, res) => {
    if (!req.user?.email) return res.status(401).json({ error: "Authentication required" });
    const r = await appAuth.revoke(req.user.email, String(req.params?.deviceId ?? ""));
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  });
}
