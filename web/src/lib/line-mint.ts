// line-mint.ts — browser-side silent mint for line operation-MCP credentials
// (add-line-credential-refs, design D2).
//
// The platform server NEVER mints ID tokens: wire/lex verify the Logto
// signature with their own SPA client_id as audience, so the token must come
// from each line's own Logto app — which only a browser with the shared Logto
// session can drive. Flow per line:
//
//   1. GET the line's public auth/config (client_id + scopes — no hardcoding).
//   2. Open {issuer}/oidc/auth (PKCE + prompt=none, redirect = the line's own
//      SPA callback) in a popup; poll the popup's location for ?code=.
//      consent_required/login_required on first ever use → reopen WITHOUT
//      prompt=none once (same-session SSO makes it one click); afterwards it
//      stays silent.
//   3. POST code→token at {issuer}/oidc/token (PKCE verifier), take id_token.
//   4. POST it to /api/lines/:line/credential — server stores per user.
//
// Nothing persists in the browser: the token goes straight to the backend.

const POLL_MS = 400;
const WAIT_MS = 3 * 60 * 1000;
const POPUP_FEATURES = "width=520,height=640";

interface LineAuthConfig {
  issuer: string;
  client_id: string;
  scopes: string[];
}

interface LineMintTarget {
  line: "wire-customer" | "lex" | "wanxing-caller";
  configUrl: string;
  // The redirect registered on that line's SPA client (must match exactly).
  redirectUri: string;
}

export const LINE_TARGETS: Record<"wire-customer" | "lex", LineMintTarget> = {
  "wire-customer": {
    line: "wire-customer",
    configUrl: "https://wire.finddatatech.cloud/api/console/auth/config",
    redirectUri: "https://wire.finddatatech.cloud/console/callback",
  },
  lex: {
    line: "lex",
    configUrl: "https://lex.finddatatech.cloud/api/console/auth/config",
    // lex SPA callback — same shape as wire (console SPA convention).
    redirectUri: "https://lex.finddatatech.cloud/console/callback",
  },
};

const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function pkce() {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function authConfig(target: LineMintTarget): Promise<LineAuthConfig> {
  const res = await fetch(target.configUrl);
  if (!res.ok) throw new Error(`该线的鉴权配置不可读（HTTP ${res.status}）`);
  const doc = await res.json();
  if (!doc?.configured || !doc?.client_id || !doc?.issuer) {
    throw new Error("该线未配置 Logto 登录");
  }
  return { issuer: doc.issuer, client_id: doc.client_id, scopes: doc.scopes ?? ["openid", "profile", "email"] };
}

// Open the authorize URL in a popup and read the final ?code= off its URL
// (same-browser cross-origin navigation URLs are readable from the opener).
async function authorizeForCode(
  authorizeUrl: string,
  redirectUri: string,
): Promise<{ code: string; closedSilently: boolean }> {
  const popup = window.open(authorizeUrl, "line-mint", POPUP_FEATURES);
  if (!popup) throw new Error("弹窗被拦截——请允许本站弹窗后重试");
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (popup.closed) return { code: "", closedSilently: true };
    try {
      const href = popup.location.href;
      if (href.startsWith(redirectUri)) {
        const url = new URL(href);
        const code = url.searchParams.get("code") ?? "";
        const error = url.searchParams.get("error");
        popup.close();
        if (error) throw new Error(`授权未完成：${error}`);
        if (code) return { code, closedSilently: false };
      }
    } catch {
      // cross-origin while navigating — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  popup.close();
  throw new Error("等待授权超时");
}

async function exchangeForIdToken(
  issuer: string,
  clientId: string,
  verifier: string,
  redirectUri: string,
  code: string,
): Promise<string> {
  const res = await fetch(`${issuer}/oidc/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token 端点拒绝（HTTP ${res.status}）`);
  const doc = await res.json().catch(() => ({}));
  const idToken = doc?.id_token;
  if (typeof idToken !== "string" || !idToken) throw new Error("token 端点未返回 id_token");
  return idToken;
}

async function postToPlatform(line: string, idToken: string): Promise<void> {
  const res = await fetch(`/api/lines/${line}/credential`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: idToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `存储凭据失败（HTTP ${res.status}）`);
  }
}

// Mint + store for one ID-token line. silentOnly = never open an interactive
// window (used by background refresh sweeps).
export async function mintLineCredential(
  target: LineMintTarget,
  opts: { silentOnly?: boolean } = {},
): Promise<{ connected: boolean }> {
  const cfg = await authConfig(target);
  const { verifier, challenge } = await pkce();
  const state = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const scope = cfg.scopes.filter((s) => s !== "offline_access").join(" ");

  const buildUrl = (silent: boolean) =>
    `${cfg.issuer}/oidc/auth?${new URLSearchParams({
      client_id: cfg.client_id,
      response_type: "code",
      scope,
      redirect_uri: target.redirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(silent ? { prompt: "none" } : {}),
    }).toString()}`;

  let code = "";
  try {
    const r = await authorizeForCode(buildUrl(true), target.redirectUri);
    code = r.code;
  } catch (e) {
    if (opts.silentOnly) throw e;
  }
  if (!code) {
    // First-ever use: the line's client needs one interactive consent for this
    // user; the shared Logto session makes it a one-click pass. Afterwards
    // prompt=none stays silent forever.
    const r = await authorizeForCode(buildUrl(false), target.redirectUri);
    code = r.code;
  }
  if (!code) return { connected: false };

  const idToken = await exchangeForIdToken(cfg.issuer, cfg.client_id, verifier, target.redirectUri, code);
  await postToPlatform(target.line, idToken);
  return { connected: true };
}
