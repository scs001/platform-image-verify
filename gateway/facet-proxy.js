// ── 壹座's embedded-facet proxy (add-facet-platform 2.5) ────────────────────
//
// When FACET_BASE_URL is configured the gateway stops hosting the pack
// market and instead proxies the whole /api/packs prefix onto the facet
// service — same-origin for the browser, so web/src/lib/packs-api.ts and the
// whole Settings → 功能集 surface work with zero frontend change. The user
// the gateway already verified rides along as a forwarded identity, stamped
// with the internal shared credential so the facet service accepts it
// (facet/identity.js). Without that credential facet treats the request as
// anonymous — correct for its public read face and harmless here, since the
// gateway only stamps identities it verified itself.
//
// Rollback = unset FACET_BASE_URL (the local-market mount below the proxy
// branch in gateway/index.js is the fallback) and restart.

export function registerFacetProxy(app, {
  base, // facet origin, no trailing slash
  resolveUser,
  token, // FACET_INTERNAL_TOKEN
  fetchImpl = fetch,
  timeoutMs = 30_000,
}) {
  const forward = async (req, res) => {
    const user = resolveUser(req);
    const headers = {
      // Identity travels only when verified; facet's proxy channel requires
      // the token, so an anonymous browser lands as facet-anonymous (public
      // read face answers, write routes 401 — same wall as before cutover).
      ...(user
        ? {
            "x-facet-user": Buffer.from(JSON.stringify({ email: user.email, groups: user.groups ?? [] })).toString("base64url"),
            "x-facet-token": token,
          }
        : {}),
      ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}),
      ...(req.headers["idempotency-key"] ? { "Idempotency-Key": req.headers["idempotency-key"] } : {}),
    };

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    let upstream;
    try {
      upstream = await fetchImpl(`${base}${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return res.status(502).json({ error: `facet service unreachable: ${e?.message || e}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    const ctype = upstream.headers.get("content-type");
    if (ctype) res.type(ctype);
    res.send(buf);
  };

  // Every method, whole prefix — the facet service owns the marketplace API
  // surface entirely (including /api/packs/internal/*, which the runner and
  // the wanxing facade keep addressing through 壹座).
  app.all("/api/packs", forward);
  app.all("/api/packs/*", forward);
}
