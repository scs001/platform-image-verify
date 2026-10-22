// chatwoot-credentials.js — per-user Chatwoot BYOK credential
// (add-crm-desk-pack-embed task 2.1).
//
// Paste semantics like the connector family: the user pastes their own
// Chatwoot API token (tool face + gated send execution); 401 flips stale,
// re-saving recovers. The optional login email/password ride the same row and
// serve exactly one purpose — the embed's server-side sign-in (crm-desk-embed).
// Secrets live only here, in the owner's cell patch (token), and in the
// embed's in-process session map — never in logs, pack content, or shared
// config. DB unavailable degrades to "unconnected".

import * as db from "./db.js";
import { ownerKey } from "./registry-credentials.js";

export const CHATWOOT_CREDENTIAL_REF = "chatwoot";

const UNCONNECTED = { connected: false, stale: false, hasLoginCredentials: false };

// NOT an HTTP-header ref (add-crm-desk-pack-embed): the chatwoot entry is
// stdio and resolves through credentialEnv in toMcpClientEntry — it must never
// be claimed by resolveCredentials' Authorization-injection path, which would
// (a) bolt an HTTP header onto a stdio config and (b) DELETE the entry for the
// machine owner, killing the deployment-env fallback. The REFS dispatch row
// still serves liveToken/markInvalid via knownRef lookups.
export function isChatwootRef(_config) {
  return false;
}

export function status(email) {
  const row = db.getChatwootCredential(ownerKey(email));
  if (!row) return { ...UNCONNECTED };
  return {
    connected: !row.stale && Boolean(row.token),
    stale: !!row.stale,
    hasLoginCredentials: Boolean(row.loginEmail && row.loginPassword),
  };
}

// Shape validation lives in the route; this layer accepts non-empty strings.
// Re-saving always clears stale (the fresh paste is the recovery path).
export function store({ email, token, loginEmail = null, loginPassword = null }) {
  if (typeof token !== "string" || !token.trim()) return status(email);
  return db.setChatwootCredential({
    email: ownerKey(email),
    token: token.trim(),
    loginEmail: loginEmail?.trim() || null,
    loginPassword: loginPassword || null,
  }) ? status(email) : { ...UNCONNECTED };
}

export function disconnect(email) {
  return db.clearChatwootCredential(ownerKey(email));
}

// 401 from a chatwoot tool or the embed's sign-in: flip stale (re-paste to
// recover). Returns true when state changed.
export function markInvalid(email) {
  return db.markChatwootCredentialStale(ownerKey(email));
}

// The token to inject into the cell patch / action child env, or null when
// there is none usable (unconnected or stale).
export function liveToken(email) {
  const row = db.getChatwootCredential(ownerKey(email));
  if (!row || row.stale) return null;
  return row.token || null;
}

// The embed's sign-in pair, or null unless BOTH parts are present.
export function loginCredentials(email) {
  const row = db.getChatwootCredential(ownerKey(email));
  if (!row?.loginEmail || !row?.loginPassword) return null;
  return { email: row.loginEmail, password: row.loginPassword };
}
