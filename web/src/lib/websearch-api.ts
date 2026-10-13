// Thin client for the Network-search settings endpoints
// (add-websearch-settings). Mirrors the overlay-api style: one function per
// endpoint, `json`-shaped errors surfaced as Error(message).

export interface WebsearchConfig {
  url: string;
  hasToken: boolean;
  tokenHint: string | null;
  source: { url: "stored" | "env" | null; token: "stored" | "env" | null };
}

export type WebsearchTestState = "ok" | "auth-rejected" | "upstream-degraded" | "unreachable" | "invalid-url";

export interface WebsearchTestResult {
  state: WebsearchTestState;
  detail?: string;
}

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export function fetchWebsearchConfig(): Promise<WebsearchConfig> {
  return fetch("/api/config/websearch", { credentials: "same-origin" }).then(jsonOrThrow);
}

// Body semantics: absent field = untouched, "" = clear (fall back to env),
// non-empty = store. The token VALUE never comes back — only hint + presence.
export function saveWebsearchConfig(body: { url?: string; token?: string }): Promise<WebsearchConfig & { ok: true }> {
  return fetch("/api/config/websearch", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }).then(jsonOrThrow);
}

// Dry-run connectivity probe; form values (when given) are used for THIS
// request only and never persisted.
export function testWebsearchRelay(input: { url?: string; token?: string }): Promise<WebsearchTestResult> {
  return fetch("/api/config/websearch/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  }).then(jsonOrThrow);
}
