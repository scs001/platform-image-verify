// credential-refs.js — the credentialRef dispatch table (add-connector-credentials, design D1).
//
// `credentialRef` is a system-managed marker a server config carries instead of
// an embedded secret; the effective-profile writer resolves it to the current
// user's stored credential for that ref name at every write. This module is the
// name → resolver registry so a third ref registers here instead of forking the
// orchestration in dsh-profile/dsh-events/overlay.
//
// Every entry must satisfy the registry contract used by the three consumers:
//   refName            the literal `credentialRef` value
//   isRef(config)      does this config carry our ref?
//   liveToken(email)   the injectable token or null (= omit the server)
//   markInvalid(email) 401 handler: true when state changed (= re-apply once)
//   staleEvent         the WS event clients refresh on after invalidation
//
// registry-credentials stays the module of record for its ref (its exports are
// unchanged and still imported directly elsewhere); this table only forwards.

import * as registryCredentials from "./registry-credentials.js";
import * as connectorCredentials from "./connector-credentials.js";
import * as facetMarketCredentials from "./facet-market-credentials.js";
import * as lineCredentials from "./line-credentials.js";
import * as paperTradingCredentials from "./paper-trading-credentials.js";
import * as ciyuanAccountCredentials from "./ciyuan-account-credentials.js";
// Wire line tool hosting: the vendored tool_risk snapshot is a generated,
// import-only module (safe from cycles) — derive the server set from it rather
// than hand-editing the snapshot. The registry's public API does not surface
// metadata.credential_ref, so the credential dispatch derives the ref from tool
// hosting instead: any market entry of these names installs with — and its
// sessions inject — the USER's wire-customer ID token. A wgk- key (the
// incumbent registry credential) only speaks the wire data plane; every
// control-plane read in these servers 401s (real-machine acceptance 10-21).
import { WIRE_TOOL_RISK } from "./lib/wire-tool-risk.js";
import * as chatwootCredentials from "./chatwoot-credentials.js";
const WIRE_LINE_SERVERS = new Set(Object.values(WIRE_TOOL_RISK).map((w) => w.server));

const REFS = new Map(
  [
    {
      refName: registryCredentials.REGISTRY_CREDENTIAL_REF,
      isRef: registryCredentials.isRegistryRef,
      liveToken: registryCredentials.liveToken,
      markInvalid: registryCredentials.markStale,
      staleEvent: "registry_credential_stale",
    },
    {
      refName: connectorCredentials.CONNECTOR_CREDENTIAL_REF,
      isRef: connectorCredentials.isConnectorRef,
      liveToken: connectorCredentials.liveToken,
      markInvalid: connectorCredentials.markInvalid,
      staleEvent: "connector_credential_stale",
    },
    {
      refName: facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF,
      isRef: facetMarketCredentials.isFacetMarketRef,
      liveToken: facetMarketCredentials.liveToken,
      markInvalid: facetMarketCredentials.markInvalid,
      staleEvent: "facet_market_credential_stale",
    },
    {
      refName: paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF,
      isRef: paperTradingCredentials.isPaperTradingRef,
      liveToken: paperTradingCredentials.liveToken,
      markInvalid: paperTradingCredentials.markInvalid,
      staleEvent: "paper_trading_credential_stale",
    },
    {
      refName: lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF,
      isRef: lineCredentials.isWireCustomerRef,
      liveToken: (email) => lineCredentials.liveToken(email, "wire-customer"),
      markInvalid: (email) => lineCredentials.markInvalid(email, "wire-customer"),
      // Refresh-first on 401 (add-line-credential-renewal D4): server-side
      // recovery attempt before invalidation.
      renewOn401: (email) => lineCredentials.renewOn401(email, "wire-customer"),
      staleEvent: "line_credential_stale",
      // Install-gate fields (fix-wire-install-gate D1): the gate must judge
      // liveness by THIS ref's own resolver — falling through to the registry
      // check refused wire-line installs for customers whose registry was
      // never connected (2026-10-24, wire-tester2). Same resolution the
      // profile writer applies, so "connected" = the install will inject.
      connected: (email) => Boolean(lineCredentials.liveToken(email, "wire-customer")),
      missingReason: "connect your wire line first — no live wire credential",
    },
    {
      refName: lineCredentials.LEX_CREDENTIAL_REF,
      isRef: lineCredentials.isLexRef,
      liveToken: (email) => lineCredentials.liveToken(email, "lex"),
      markInvalid: (email) => lineCredentials.markInvalid(email, "lex"),
      renewOn401: (email) => lineCredentials.renewOn401(email, "lex"),
      staleEvent: "line_credential_stale",
      connected: (email) => Boolean(lineCredentials.liveToken(email, "lex")),
      missingReason: "connect your lex line first — no live lex credential",
    },
    {
      // ciyuan-account-lane (design D5): the wanxing-caller ref is served by the
      // user's bound 词元 account key first, a legacy pasted caller key second —
      // one key for the model lane and the operations MCP alike.
      refName: lineCredentials.WANXING_CALLER_CREDENTIAL_REF,
      isRef: lineCredentials.isWanxingCallerRef,
      liveToken: (email) => ciyuanAccountCredentials.liveToken(email),
      markInvalid: (email) => ciyuanAccountCredentials.markStale(email),
      staleEvent: "line_credential_stale",
      connected: (email) => Boolean(ciyuanAccountCredentials.liveToken(email)),
      missingReason: "connect your Wanxing caller key first — no live caller credential",
    },
    {
      // add-crm-desk-pack-embed: the merchant's own Chatwoot token — cell patch
      // env (credentialEnv) and the gated send execution alike. Paste family.
      refName: chatwootCredentials.CHATWOOT_CREDENTIAL_REF,
      isRef: chatwootCredentials.isChatwootRef,
      liveToken: (email) => chatwootCredentials.liveToken(email),
      markInvalid: (email) => chatwootCredentials.markInvalid(email),
      staleEvent: "chatwoot_credential_stale",
    },
  ].map((entry) => [entry.refName, entry]),
);

export function knownRef(name) {
  return REFS.has(name);
}

// ── Install-path dispatch (add-facet-market-credentials D4; hoisted here when
// the second consumer appeared — add-paper-trading-credentials) ─────────────
// Which 壹座-side credentialRef a registry entry's install must wire and
// require: the registering line declares it via metadata.credential_ref
// (mapped onto entry.credentialRef by registry-bridge); absent = the
// incumbent registry credential. Consumed by BOTH install paths — the pack
// install (pack-store) and the market card install (routes/extensions) —
// which is why it lives on the dispatch table, not in one consumer.

export function credentialRefForEntry(entry) {
  if (entry?.credentialRef) return entry.credentialRef;
  if (entry?.name && WIRE_LINE_SERVERS.has(entry.name)) {
    return lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF;
  }
  return registryCredentials.REGISTRY_CREDENTIAL_REF;
}

export function credentialConnected(refName, email) {
  // Table-first (fix-wire-install-gate D1): an entry that declares `connected`
  // is judged by its own resolver — a line ref falling through to the registry
  // check refused installs for the wrong missing credential. Entries without
  // the field keep the legacy chain below, byte-identical.
  const entry = REFS.get(refName);
  if (typeof entry?.connected === "function") return entry.connected(email);
  if (refName === facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF) {
    return facetMarketCredentials.status(email).connected;
  }
  if (refName === chatwootCredentials.CHATWOOT_CREDENTIAL_REF) {
    return chatwootCredentials.status(email).connected;
  }
  if (refName === paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF) {
    return paperTradingCredentials.status(email).connected;
  }
  return registryCredentials.status(email).connected;
}

// Human-readable "what to connect" for a refused install, per ref (the 409
// body's reason; the UI turns it into the connect-card pointer).
export function credentialMissingReason(refName) {
  const entry = REFS.get(refName);
  if (typeof entry?.missingReason === "string") return entry.missingReason;
  if (refName === facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF) {
    return "pair the facet market first — no live market credential";
  }
  if (refName === chatwootCredentials.CHATWOOT_CREDENTIAL_REF) {
    return "connect your Chatwoot account first — no live Chatwoot credential";
  }
  if (refName === paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF) {
    return "connect the paper-trading service first — no live paper-trading credential";
  }
  return "connect the MCP market first — no live registry credential";
}

// Where the connect card for a ref lives (connection-center): the Settings
// connections section, on the ref's own panel. Consumed by both install paths
// alongside credentialMissingReason so the UI can deep-link the exact card.
export function connectPathForRef(refName) {
  return `/settings/connections?panel=${connectPanelForRef(refName)}`;
}
// The connect panel id for a ref name (chat-connect-guidance consumes this
// to point failed tool calls at the right card without parsing the path).
export function connectPanelForRef(refName) {
  return KNOWN_CONNECT_PANELS.get(refName) ?? "registry";
}
const KNOWN_CONNECT_PANELS = new Map([
  [registryCredentials.REGISTRY_CREDENTIAL_REF, "registry"],
  [facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF, "facet-market"],
  [paperTradingCredentials.PAPER_TRADING_CREDENTIAL_REF, "paper-trading"],
  ["wire-customer", "line-wire-customer"],
  ["lex", "line-lex"],
  ["wanxing-caller", "ciyuan-account"],
  [chatwootCredentials.CHATWOOT_CREDENTIAL_REF, "chatwoot"],
]);

// The registry entry for a config's `credentialRef`, or null for an absent or
// unknown ref name — callers decide what an unknown name means (the profile
// writer omits the server; a hand-entered config is rejected outright).
export function refFor(config) {
  const name = config?.credentialRef;
  return typeof name === "string" ? REFS.get(name) ?? null : null;
}

export function isCredentialRef(config) {
  return Boolean(config?.credentialRef);
}

// Resolve one ref NAME for one user — the same resolution the profile writer
// applies per server, for callers that hold a name instead of a server config
// (action preflight and the action executor, add-line-boards-and-action-gate).
// A name the table does not list falls back to the line-credentials store so a
// registered action can name any ref the platform stores (wanxing-deployer is
// preflight-only today and lives there alone).
export function liveTokenForRef(refName, email) {
  if (typeof refName !== "string" || !refName) return null;
  const entry = REFS.get(refName);
  if (entry) return entry.liveToken(email) || null;
  return lineCredentials.liveToken(email, refName) || null;
}

// The 401 handler for a ref name; true when state changed (= re-apply once).
export function invalidateRef(refName, email) {
  if (typeof refName !== "string" || !refName) return false;
  const entry = REFS.get(refName);
  if (entry) return Boolean(entry.markInvalid(email));
  return Boolean(lineCredentials.markInvalid(email, refName));
}

// Resolve every ref-carrying config in `servers` for `email`: returns a new
// object where each carried server either gained an Authorization header or was
// dropped, plus per-ref diagnostics for the omission warnings. Grouped by ref
// so one warning line covers all servers of the same ref (the registry shape).
export function resolveCredentials(servers, email) {
  const out = { ...servers };
  const omitted = [];
  const injected = [];
  try {
    for (const entry of REFS.values()) {
      const names = Object.entries(servers)
        .filter(([, config]) => entry.isRef(config))
        .map(([name]) => name);
      if (names.length === 0) continue;
      const token = entry.liveToken(email);
      if (token) {
        for (const name of names) {
          out[name] = {
            ...out[name],
            headers: { ...(out[name].headers || {}), Authorization: `Bearer ${token}` },
          };
        }
        injected.push({ ref: entry.refName, names });
      } else {
        for (const name of names) delete out[name];
        omitted.push({ ref: entry.refName, names });
      }
    }
  } catch (e) {
    // A resolver blowing up must never pass its servers through unauthenticated:
    // drop every ref-carrying server and report the failure as one omission.
    for (const [name, config] of Object.entries(servers)) {
      if (isCredentialRef(config)) delete out[name];
    }
    omitted.length = 0;
    injected.length = 0;
    return { servers: out, omitted, injected, error: e?.message || String(e) };
  }
  return { servers: out, omitted, injected };
}
