// ── sub2api admin/billing client (add-agent-platform-ops D1) ─────────────────
//
// The platform's single door into the sub2api billing plane (ADR-0011). Live
// facts baked into the shapes (0.2.7, probed 2026-10-02):
//   • envelope {code:0, message, data} — nonzero code is a failure;
//   • x-api-key: admin-… authenticates /api/v1/admin/*;
//   • NO admin-side key creation exists — keys are minted on the USER panel
//     route POST /api/v1/user/keys under that user's JWT, so the platform
//     holds each deployer sub2api account's password (generated, stored in
//     the deployment-key records, never logged);
//   • manual recharge = POST /api/v1/admin/users/:id/balance with an
//     Idempotency-Key header (no redeem-code endpoint in 0.2.7).
// Every call takes an injectable fetchImpl; without SUB2API_ADMIN_KEY the
// client reports degraded() and callers fall back to the pre-③ behavior.

import { randomBytes } from "node:crypto";

const DEFAULT_BASE = process.env.SUB2API_BASE_URL || "http://127.0.0.1:32080";

function slugify(email) {
  return String(email || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "user";
}

export function createSub2apiClient({ baseUrl = DEFAULT_BASE, adminKey = process.env.SUB2API_ADMIN_KEY || "", fetchImpl = null } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const doFetch = fetchImpl ?? ((path, init = {}) => fetch(base + path, init));
  const degraded = () => !adminKey;

  async function call(path, { method = "GET", body, headers = {} } = {}) {
    const res = await doFetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(adminKey ? { "x-api-key": adminKey } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let doc = null;
    try {
      doc = await res.json();
    } catch { /* non-JSON error body */ }
    if (!res.ok || (doc && typeof doc.code === "number" && doc.code !== 0)) {
      const message = doc?.message || `sub2api ${method} ${path} failed (${res.status})`;
      throw Object.assign(new Error(message), { status: res.ok ? 502 : res.status, body: doc });
    }
    return doc?.data ?? doc;
  }

  // The user-panel route needs the user's own JWT (admin key is not accepted).
  async function callAsUser(email, password, path, { method = "POST", body } = {}) {
    const login = await doFetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const ld = await login.json().catch(() => null);
    const jwt = ld?.data?.access_token || ld?.access_token || "";
    if (!login.ok || !jwt) {
      throw Object.assign(new Error(`sub2api user login failed for ${email} (${login.status})`), { status: 502 });
    }
    const res = await doFetch(path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const doc = await res.json().catch(() => null);
    if (!res.ok || (doc && typeof doc.code === "number" && doc.code !== 0)) {
      throw Object.assign(new Error(doc?.message || `sub2api user ${method} ${path} failed (${res.status})`), { status: res.ok ? 502 : res.status });
    }
    return doc?.data ?? doc;
  }

  return {
    degraded,

    // Startup/ops self-check: the admin key must list users.
    async selfCheck() {
      if (degraded()) return { ok: false, reason: "SUB2API_ADMIN_KEY not configured" };
      try {
        await call("/api/v1/admin/users?page=1&page_size=1");
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },

    // Deterministic DEDICATED deployer account. The email is derived
    // (paas-deployer+<slug>@) so it can never collide with the user's own
    // gateway account — a same-email pre-existing account would leave the
    // platform without the password (0.2.7 has no admin reset), silently
    // disabling key minting (live finding 2026-10-02: keyRef null).
    async ensureDeployerUser(email, { domain = process.env.SUB2API_DEPLOYER_DOMAIN || "deployers.finddatatech.cloud" } = {}) {
      const derived = `paas-deployer+${slugify(email)}@${domain}`;
      const username = `paas-${slugify(email)}`;
      const listed = await call(`/api/v1/admin/users?search=${encodeURIComponent(derived)}&page=1&page_size=50`);
      const hit = (listed?.items ?? []).find((u) => u.email === derived);
      if (hit) return { userId: hit.id, username, password: null, sub2apiEmail: derived, existed: true };
      const password = randomBytes(16).toString("hex");
      const created = await call("/api/v1/admin/users", {
        method: "POST",
        body: { email: derived, username, password, role: "user" },
      });
      return { userId: created?.id, username, password, sub2apiEmail: derived, existed: false };
    },

    // Mint one per-agent key under the deployer's account: quota (USD) plus
    // the 5h/1d/7d spending windows. The plaintext key is returned ONCE — the
    // caller stores it; sub2api keeps only its hash.
    async mintAgentKey({ email, password, name, quotaUsd, rl5hUsd, rl1dUsd, rl7dUsd, groupId = null }) {
      const data = await callAsUser(email, password, "/api/v1/keys", {
        method: "POST",
        body: {
          name,
          ...(quotaUsd != null ? { quota: Number(quotaUsd) } : {}),
          ...(rl5hUsd != null ? { rate_limit_5h: Number(rl5hUsd) } : {}),
          ...(rl1dUsd != null ? { rate_limit_1d: Number(rl1dUsd) } : {}),
          ...(rl7dUsd != null ? { rate_limit_7d: Number(rl7dUsd) } : {}),
          ...(groupId != null ? { group_id: groupId } : {}),
        },
      });
      const key = data?.key ?? data?.api_key ?? "";
      if (!key) throw new Error("sub2api minted a key but returned no value");
      return { keyId: data?.id ?? null, key };
    },

    async readUser(userId) {
      const u = await call(`/api/v1/admin/users/${userId}`);
      return { balance: Number(u?.balance ?? 0), status: u?.status ?? null, email: u?.email ?? null };
    },

    // Day-one recharge (operator manual): Idempotency-Key guarded. The live
    // body is UpdateBalanceRequest {balance, operation} (probed 2026-10-02:
    // both fields required; operation "add" credits the amount).
    async adjustBalance({ userId, amountUsd, operation = "add", idempotencyKey }) {
      return call(`/api/v1/admin/users/${userId}/balance`, {
        method: "POST",
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
        body: { balance: Number(amountUsd), operation },
      });
    },
  };
}
