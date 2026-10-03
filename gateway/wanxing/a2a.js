// ── Wanxing facade, A2A protocol face (add-wanxing-serving-api design D2/D5) ─
//
// The v1 wire protocol of the external front door: native A2A JSON-RPC at
// per-agent routes, the public catalog and cards, forwarded to the agent's
// runtime route through the registry proxy on the platform's internal dual
// credentials (X-Authorization service credential + Authorization backend
// token — both platform-held; the caller's sub2api key never travels past
// this module). Everything auth/limit/idempotency/settlement-shaped is
// delegated to the protocol-agnostic core.

import express from "express";
import { createHash, randomBytes } from "node:crypto";

const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const EXTERNAL_CONTEXT_PREFIX = "wx:"; // the runner's reap pass keys on this (design D10)

const textOf = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
  return text || null;
};

const jsonRpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// Context derivation: caller-supplied context_id passes through untouched; a
// send without one gets a fresh external context derived from the idempotency
// key (stable across replays — a replayed request resumes the same context),
// a stream without one gets a one-shot context. All derived ids carry the
// external prefix so the runner can reap them.
export function contextIdFor(message, idemKey) {
  const supplied = message?.context_id ?? message?.contextId ?? null;
  if (supplied) return String(supplied);
  if (idemKey) return `${EXTERNAL_CONTEXT_PREFIX}${sha256(idemKey).slice(0, 16)}`;
  return `${EXTERNAL_CONTEXT_PREFIX}${randomBytes(8).toString("hex")}`;
}

export function createA2aFace({
  core,
  resolveDeployment, // (slug) → { agentPath } | null
  listDeployments,   // () → [{ slug, agentPath }]
  forwardHeaders,    // () → the platform's internal dual-credential headers
  registryFetch,     // (path, init?) → fetch Response against the registry
  config,            // { agentUrlFor(agentPath) }
  upstreamFetch = fetch, // injection seam for tests
}) {
  // Registry-entry cache: catalog/visibility on a 60s TTL; the paused flag
  // re-reads when older than 15s so an operator's pause reflects promptly
  // (the runner itself lags up to its poll interval anyway).
  const entryTtlMs = 60_000;
  const pausedTtlMs = 15_000;
  const entryCache = new Map(); // slug → { at, entry }

  async function entryFor(slug) {
    const cached = entryCache.get(slug);
    if (cached && Date.now() - cached.at < entryTtlMs) return cached.entry;
    const dep = resolveDeployment(slug);
    if (!dep) return null;
    let entry = null;
    try {
      const r = await registryFetch(`/api/agents${dep.agentPath}`);
      if (r.ok) entry = await r.json();
    } catch { /* registry unreachable: fall through to the cached view */ }
    if (!entry) return cached?.entry ?? null;
    entryCache.set(slug, { at: Date.now(), entry });
    return entry;
  }

  async function agentState(slug) {
    const dep = resolveDeployment(slug);
    if (!dep) return { exists: false, slug };
    let entry = await entryFor(slug);
    const cached = entryCache.get(slug);
    if (entry && (!cached || Date.now() - cached.at >= pausedTtlMs)) {
      // A stale-enough view re-reads once so the paused flag is current; on
      // a registry hiccup the cached verdict stands.
      try {
        const r = await registryFetch(`/api/agents${dep.agentPath}`);
        if (r.ok) {
          entry = await r.json();
          entryCache.set(slug, { at: Date.now(), entry });
        }
      } catch { /* keep the cached view */ }
    }
    if (!entry) return { exists: false, slug };
    return {
      exists: true,
      slug,
      visibility: entry?.visibility === "private" ? "private" : "public",
      paused: entry?.metadata?.paused === true,
      entry,
      agentPath: dep.agentPath,
    };
  }

  function publicCard(slug, entry, req) {
    return {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      provider: entry.provider ?? { organization: "paas-pack" },
      capabilities: entry.capabilities ?? { streaming: true },
      skills: entry.skills ?? [],
      tags: entry.tags ?? [],
      default_input_modes: entry.default_input_modes ?? ["text"],
      default_output_modes: entry.default_output_modes ?? ["text"],
      preferred_transport: entry.preferred_transport ?? "jsonrpc",
      // The card points callers at the facade, never at the internal runtime.
      url: `${req.protocol}://${req.get("host")}/api/wanxing/v1/a2a/${slug}`,
    };
  }

  function register(app) {
    // ── Public discovery: no credential by design (spec: card and catalog
    // are public). Private agents are simply absent from both.
    app.get("/api/wanxing/v1/agents", async (_req, res) => {
      const out = [];
      for (const dep of listDeployments()) {
        const entry = await entryFor(dep.slug);
        if (!entry || entry.visibility === "private") continue;
        out.push({
          slug: dep.slug,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          tags: entry.tags ?? [],
          capabilities: entry.capabilities ?? { streaming: true },
          skills: entry.skills ?? [],
        });
      }
      res.json({ agents: out });
    });

    app.get("/api/wanxing/v1/a2a/:agentSlug/.well-known/agent-card.json", async (req, res) => {
      const state = await agentState(req.params.agentSlug);
      if (!state.exists || state.visibility === "private") {
        return res.status(404).json({ error: { code: "AGENT_NOT_FOUND", message: "no public agent at this route" } });
      }
      res.json(publicCard(req.params.agentSlug, state.entry, req));
    });

    // ── The A2A turn surface. Order is the kernel's admission pipeline:
    // key gate → protocol shape → agent admission → rate → slot → idempotency.
    app.post("/api/wanxing/v1/a2a/:agentSlug", express.json({ limit: "1mb" }), async (req, res) => {
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const auth = await core.authenticate(bearer);
      if (!auth.ok) return res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      const caller = auth.caller;

      const { id, method, params } = req.body ?? {};
      if (req.body?.jsonrpc !== "2.0" || typeof method !== "string") {
        return res.status(200).json(jsonRpcError(id, -32600, "Invalid Request"));
      }
      if (method !== "message/send" && method !== "message/stream") {
        return res.status(200).json(jsonRpcError(id, -32601, `Method not found: ${method}`));
      }
      const message = params?.message ?? params;
      const text = textOf(message);
      if (!text) return res.status(200).json(jsonRpcError(id, -32604, "empty message"));

      const slug = req.params.agentSlug;
      const state = await agentState(slug);
      const admitted = core.admit(caller, state);
      if (!admitted.ok) return res.status(admitted.status).json({ error: { code: admitted.code, message: admitted.message } });

      if (!core.checkRpm(caller.userId)) {
        return res.status(429).json({ error: { code: "RATE_LIMITED", message: "caller rate limit exceeded" } });
      }

      const idemKey = (() => {
        const h = req.headers["idempotency-key"];
        return typeof h === "string" && h.trim() ? h.trim().slice(0, 200) : null;
      })();
      // Idempotency triage BEFORE the slot (send only — streams never replay):
      // a finished request replays from the ledger (a read), a running flight
      // is JOINED (the turn is already admitted; concurrent duplicates both
      // receive its outcome), and only a genuinely new turn takes the
      // (caller, agent) concurrency slot. Replays and joins never hold the
      // slot, so they cannot leak it, and they record no usage of their own.
      const prior = method === "message/send" ? core.idempotencyState({ callerId: caller.userId, slug, idemKey }) : "new";
      let holdsSlot = false;
      if (prior === "new") {
        if (!core.acquireSlot(caller.userId, slug)) {
          res.set("Retry-After", "5");
          return res.status(409).json({ error: { code: "TURN_IN_FLIGHT", message: "a turn for this caller and agent is already running; retry after the hint" } });
        }
        holdsSlot = true;
      }

      const contextId = contextIdFor(message, idemKey);
      const startedAt = Date.now();

      // finish = THIS request's turn ended (slot-holder only): ledger row +
      // fire-and-forget settlement (the pending sweep retries, idempotently).
      // exitReadonly = a replay/join leaves without recording anything.
      const finish = (outcome) => {
        core.releaseSlot(caller.userId, slug);
        const row = core.recordUsage({ caller, slug, idemKey, startedAt, endedAt: Date.now(), outcome });
        if (row.settlementStatus === "pending") void core.trySettle(row).catch(() => {});
      };
      const exitReadonly = () => {
        if (holdsSlot) core.releaseSlot(caller.userId, slug);
      };

      const rpcBody = (m) => JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: m,
        params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
      });

      try {
        if (method === "message/stream") {
          // Raw SSE passthrough: frames flow unmodified; the ledger closes
          // when the upstream stream ends (done or error).
          const upstream = await upstreamFetch(config.agentUrlFor(state.agentPath), {
            method: "POST",
            headers: { ...forwardHeaders(), "Content-Type": "application/json" },
            body: rpcBody("message/stream"),
          });
          const ctype = upstream.headers.get("content-type") || "";
          if (!upstream.ok || !ctype.includes("text/event-stream")) {
            const body = await upstream.text().catch(() => "");
            finish("error");
            return res.status(502).json({ error: { code: "UPSTREAM_FAILED", message: `agent route refused the turn: ${body.slice(0, 200) || upstream.status}` } });
          }
          res.status(200).set("Content-Type", "text/event-stream").set("Cache-Control", "no-cache");
          let outcome = "ok";
          try {
            const reader = upstream.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              // Decode ONCE — the decoder is stateful across chunks; an error
              // event in the frame flips the turn unbillable.
              const frame = decoder.decode(value, { stream: true });
              res.write(frame);
              if (/event:\s*error/.test(frame)) outcome = "error";
            }
          } catch {
            outcome = "error";
          } finally {
            res.end();
            finish(outcome);
          }
          return;
        }

        // message/send, with replay semantics on the idempotency key.
        const out = await core.idempotentSend({
          callerId: caller.userId,
          slug,
          idemKey,
          exec: async () => {
            const upstream = await upstreamFetch(config.agentUrlFor(state.agentPath), {
              method: "POST",
              headers: { ...forwardHeaders(), "Content-Type": "application/json" },
              body: rpcBody("message/send"),
            });
            const doc = await upstream.json().catch(() => null);
            if (!upstream.ok) {
              throw Object.assign(new Error(`agent route refused the turn (${upstream.status})`), { code: -32033 });
            }
            return { response: doc ?? { jsonrpc: "2.0", id: id ?? null, result: { message: { parts: [] } } } };
          },
        });
        // message/send: replay/join land here without a slot of their own —
        // no usage row, no settle; the flight's owner did (or will) record.
        if (!out.replayed) finish("ok");
        else exitReadonly();
        res.status(200).json(out.response);
      } catch (e) {
        if (holdsSlot) finish("error");
        else exitReadonly();
        res.status(200).json(jsonRpcError(id, Number.isInteger(e?.code) ? e.code : -32032, String(e?.message || e)));
      }
    });
  }

  return { register, entryFor, agentState };
}
