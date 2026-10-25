// ── Runner-side matters executor (add-matter-threads D3) ────────────────────
//
// One instance per runner: the policy and the egress for every facade
// child's matter_open / matter_status / matter_read call. The child only
// names an op; everything a matter call needs to reach the platform — the
// facet internal route, the deployment service credential, the per-agent
// OPEN bound — lives HERE, in host configuration, and never enters the child
// environment.
//
// The egress is the facet's internal matters route (the host-settle channel
// family): same packs base URL the notify relay derives from, same shared
// service credential, 10s bound per call. Reads (status/read) are unthrottled
// and answer-cacheless; OPEN carries a per-agent token bucket (a runaway
// reception cannot matter-spam its principal).
//
// Every decision and egress attempt lands one jsonl audit line
// ({agent, op, outcome, reason, len} — never the matter text), the notify
// relay's no-content law mirrored.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const CALL_TIMEOUT_MS = 10_000;

export function createMatters({ config, log = console, fetchImpl, now = () => Date.now() }) {
  const openPerMin = Number(config?.mattersOpenPerMin) > 0 ? Number(config.mattersOpenPerMin) : 4;
  const buckets = new Map(); // agentKey → { tokens, refilledAt }

  const audit = (agent, op, outcome, reason, len) => {
    try {
      mkdirSync(path.dirname(config.mattersLogFile), { recursive: true });
      appendFileSync(
        config.mattersLogFile,
        `${JSON.stringify({
          agent,
          op,
          outcome,
          reason: reason ?? null,
          len,
          at: new Date(now()).toISOString(),
        })}\n`,
      );
    } catch (e) {
      log.warn?.(`[agent-runner] matters audit write failed: ${e?.message || e}`);
    }
  };

  const take = (agentKey) => {
    const t = now();
    let bucket = buckets.get(agentKey);
    if (!bucket) {
      bucket = { tokens: openPerMin, refilledAt: t };
      buckets.set(agentKey, bucket);
    }
    const refill = ((t - bucket.refilledAt) / 60_000) * openPerMin;
    bucket.tokens = Math.min(openPerMin, bucket.tokens + refill);
    bucket.refilledAt = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const call = async (httpPath, { method = "GET", body } = {}) => {
    const base = String(config?.packsBaseUrl || "").replace(/\/+$/, "");
    const token = config?.registryToken || "";
    if (!base || !token) {
      return { ok: false, reason: "not-configured", message: "the matters plane is not configured on this runner" };
    }
    const doFetch = fetchImpl ?? fetch;
    try {
      const res = await doFetch(base + httpPath, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const doc = await res.json().catch(() => null);
      if (!res.ok) {
        return { ok: false, reason: "platform", status: res.status, message: String(doc?.error || `HTTP ${res.status}`) };
      }
      return { ok: true, ...(doc ?? {}) };
    } catch (e) {
      return { ok: false, reason: "network", message: e?.message || String(e) };
    }
  };

  // handle({ packId, agentId, agent, op, args }) — the manager wires each
  // facade child's matterCall/send here with its deployment identity.
  const handle = async ({ packId, agentId, agent, op, args = {} }) => {
    if (!packId || !agentId) {
      return { ok: false, reason: "identity", message: "matter calls need a deployment identity" };
    }
    const enc = encodeURIComponent;
    if (op === "open") {
      const summary = typeof args.summary === "string" ? args.summary : "";
      if (!summary.trim()) {
        audit(agent, op, "declined", "empty-summary", 0);
        return { ok: false, reason: "invalid-request", message: "matter_open needs a non-empty summary" };
      }
      if (!take(agent)) {
        audit(agent, op, "declined", "rate", summary.length);
        return { ok: false, reason: "rate-limit", message: "too many matters opened from this deployment recently — wait and retry" };
      }
      const out = await call(`/api/packs/internal/matters/${enc(packId)}/${enc(agentId)}/open`, {
        method: "POST",
        body: {
          summary: summary.slice(0, 2000),
          ...(typeof args.visitor_hint === "string" && args.visitor_hint.trim()
            ? { visitor_hint: args.visitor_hint.trim().slice(0, 300) }
            : {}),
        },
      });
      audit(agent, op, out.ok ? "opened" : "failed", out.ok ? null : out.reason, summary.length);
      return out.ok ? { ok: true, id: out.id, status: out.status } : out;
    }
    if (op === "status") {
      const out = await call(`/api/packs/internal/matters/${enc(packId)}/${enc(agentId)}`);
      audit(agent, op, out.ok ? "listed" : "failed", out.ok ? null : out.reason, null);
      if (!out.ok) return out;
      const matters = (out.matters ?? []).map((m) => ({
        id: m.id,
        summary: m.summary,
        status: m.status,
        visitorHint: m.visitorHint,
        updatedAt: m.updatedAt,
      }));
      return { ok: true, matters };
    }
    if (op === "read") {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!/^mt_[A-Za-z0-9_-]{1,64}$/.test(id)) {
        return { ok: false, reason: "invalid-request", message: "matter_read needs the mt_… matter id" };
      }
      const out = await call(`/api/packs/internal/matters/${enc(packId)}/${enc(agentId)}/${enc(id)}`);
      audit(agent, op, out.ok ? "read" : "failed", out.ok ? null : out.reason, null);
      return out.ok ? { ok: true, matter: out.matter } : out;
    }
    return { ok: false, reason: "unknown-op", message: `unknown matter op '${op}'` };
  };

  return { handle };
}
