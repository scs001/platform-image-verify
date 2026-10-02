// ── Registry caller-group assignment (add-agent-platform-ops D5, C-lite) ────
//
// After a user connects the MCP market (their personal registry credential is
// stored), the platform assigns their REGISTRY account the invoke-only caller
// group — the personal credential then passes the A2A invoke gate with
// per-user attribution (ADR-0013's C-lite settlement; the auth server's
// IDP_USER_GROUP_FALLBACK covers Logto users, probed 2026-10-02).
//
// Username resolution: the registry keys user-groups by username; our minted
// users surface by email in the admin listing, so match on email (fallback:
// the paas-<slug> derivation). Idempotent; failures log but never block the
// connect flow — the credential still serves market MCP.

import { ownerKey } from "./registry-credentials.js";

const CALLER_GROUP = process.env.REGISTRY_CALLER_GROUP || "paas-agent-callers";

function slugify(email) {
  return String(email || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "user";
}

// Ensure the connecting user's registry account carries the caller group.
// `doFetch(path, init)` receives registry-relative paths; the admin token is
// attached by the caller's wrapper (keeps this module credential-free).
export async function assignCallerGroup({ email, adminFetch, log = console }) {
  if (!email) return { ok: false, reason: "no email" };
  try {
    // Resolve the registry username by email from the user-group listing.
    const listRes = await adminFetch("/api/iam/user-groups", { method: "GET" });
    const doc = await listRes.json().catch(() => null);
    const rows = doc?.groups ?? doc?.items ?? doc ?? [];
    const hit = Array.isArray(rows)
      ? rows.find((r) => r?.email === email || r?.username === `paas-${slugify(email)}`)
      : null;
    const username = hit?.username ?? `paas-${slugify(email)}`;
    const res = await adminFetch(`/api/iam/user-groups/${encodeURIComponent(username)}`, {
      method: "PATCH",
      body: { add: [CALLER_GROUP] },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      log.warn(`[caller-group] assignment failed for ${email}: ${res.status} ${detail.slice(0, 120)}`);
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: true, username, group: CALLER_GROUP };
  } catch (e) {
    log.warn(`[caller-group] assignment error for ${email}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// The default adminFetch over the market registry bridge.
export function marketAdminFetch({ registryUrl, token, fetchImpl = null } = {}) {
  const base = String(registryUrl || "").replace(/\/+$/, "");
  const doFetch = fetchImpl ?? ((p, init = {}) => fetch(base + p, init));
  return (p, init = {}) =>
    doFetch(p, {
      ...init,
      headers: {
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
}

export { ownerKey, CALLER_GROUP };
