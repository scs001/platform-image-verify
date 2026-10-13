// Search relay wiring resolution (add-websearch-settings).
//
// The relay pair (URL + token) has two configuration layers, resolved
// stored → env:
//   1. deployment_config rows `websearchUrl` / `websearchToken` — set from
//      Settings → Network search (admin-gated), the user-facing layer;
//   2. process env SEARCH_RELAY_URL / SEARCH_RELAY_TOKEN — the deployment
//      layer (GitOps), the pre-change behavior and the fallback.
//
// One resolver serves both consumers: the config routes (read/write/test) and
// dsh-profile's envRefs resolution (what actually lands in a cell patch).
// Tokens are write-only at the API surface — maskToken() is the only shape a
// token may take in a response.

const URL_KEY = "websearchUrl";
const TOKEN_KEY = "websearchToken";

// Resolve the effective relay pair. dbReady=false (no DB) degrades to env-only,
// exactly the pre-change behavior. Returns { url, token, source } where each
// source is "stored" | "env" | null.
export async function resolveWebsearchRelay(db) {
  let storedUrl = null;
  let storedToken = null;
  if (db?.isDbReady?.()) {
    try {
      storedUrl = db.getDeploymentConfig(URL_KEY);
      storedToken = db.getDeploymentConfig(TOKEN_KEY);
    } catch { /* unreadable store degrades to env */ }
  }
  const envUrl = (process.env.SEARCH_RELAY_URL || "").trim() || null;
  const envToken = (process.env.SEARCH_RELAY_TOKEN || "").trim() || null;
  const url = storedUrl || envUrl;
  const token = storedToken || envToken;
  return {
    url,
    token,
    source: {
      url: storedUrl ? "stored" : envUrl ? "env" : null,
      token: storedToken ? "stored" : envToken ? "env" : null,
    },
  };
}

// The ONLY token representation an API response may carry: presence + last 4.
// Short values (<=4 chars) still expose only the tail — the hint's job is
// recognition, not recovery.
export function maskToken(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  return token.length <= 4 ? token : `…${token.slice(-4)}`;
}
