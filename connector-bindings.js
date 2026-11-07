// connector-bindings.js — resolve a pack's declared external-system bindings
// into per-user, per-binding facts (add-connector-bindings D2/D3).
//
// A binding says "this pack needs provider X, for these operation classes".
// Turning that into a state needs two kinds of facts and they come from
// different places:
//
//   The connector's catalog (does provider X exist, does it have read/write
//   actions) — asked over `catalog-coverage`, never copied or cached here.
//   The user's own connections (do they hold a connection for X) — asked over
//   `GET /api/tenant/connections` with their credential.
//
// The four states are therefore not interchangeable, and the distinction is the
// product: `missing` means the user has to connect something; `unwired` means
// the platform cannot serve that requirement yet; `stale` means the credential
// died; `undetermined` means we could not ask (that one is deliberately NOT
// `unwired` — an outage must not be reported as a capability gap).
//
// Resolution is idempotent: same inputs, same rows, and it never mints or
// re-mints a token (granting is a separate, user-confirmed step).

import { readFileSync } from "node:fs";
import path from "node:path";
import * as db from "./db.js";
import { ownerKey } from "./connector-credentials.js";

/** Resolution states. `deprecated` is ledger-only (a binding the pack dropped). */
export const BINDING_STATUS = Object.freeze({
  satisfied: "satisfied",
  missing: "missing",
  stale: "stale",
  unwired: "unwired",
  undetermined: "undetermined",
  deprecated: "deprecated",
});

export const DEFAULT_CONNECTOR_TIMEOUT_MS = 8000;

function mcpConfigPath() {
  return path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");
}

/**
 * The deployment's connector origin, from the operator baseline row in
 * mcp.json — same single source the credential routes use. null when the
 * deployment has no connector row (self-hosted without a connector).
 */
export function connectorOrigin() {
  try {
    const row = JSON.parse(readFileSync(mcpConfigPath(), "utf8")).mcpServers?.connector;
    return row && typeof row.url === "string" ? new URL(row.url).origin : null;
  } catch {
    return null;
  }
}

/**
 * Minimal read-only client over the connector's tenant routes. Only the two
 * introspection calls a resolution needs; nothing here mints, revokes, or
 * executes an action.
 */
export function createConnectorClient({ origin, token, fetchImpl = fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS }) {
  async function getJson(pathname) {
    // A refusing origin (DNS, ECONNREFUSED, the timeout abort) rejects the
    // promise, and the caller must see that as "we could not ask" — never as an
    // answer. Uncaught, it would escape the resolver and read as a crash.
    let response;
    try {
      response = await fetchImpl(`${origin}${pathname}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, code: "unavailable" };
    }
    if (response.status === 401) return { ok: false, code: "unauthorized" };
    if (response.status === 404) return { ok: false, code: "not_found" };
    if (!response.ok) return { ok: false, code: "unavailable" };
    try {
      return { ok: true, body: await response.json() };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  }

  return {
    origin,
    /** `{ operations: [{operation, covered, actionCount}], gaps }` or a failure code. */
    coverage(provider, operations) {
      const query = new URLSearchParams({ provider, operations: operations.join(",") });
      return getJson(`/api/tenant/catalog-coverage?${query.toString()}`);
    },
    /** `{ connections: [{service, connectionName, configured}] }` or a failure code. */
    connections() {
      return getJson("/api/tenant/connections");
    },
  };
}

/** The operation classes a declaration asks for, in catalog terms. */
export function declaredOperations(binding) {
  const classes = new Set();
  for (const operation of binding?.allowOperations ?? []) {
    const type = typeof operation === "string" ? operation : operation?.operationType;
    if (type) classes.add(String(type).trim());
  }
  return [...classes];
}

/** Candidates in preference order: the declared provider, then its alternatives. */
export function providerCandidates(binding) {
  return [binding?.provider, ...(binding?.alternativeProviders ?? [])]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
}

function bindingSlot(packId, bindingKey) {
  return `${packId}:${bindingKey}`;
}

function sameOperations(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** Provider or operation range changed: the granted token no longer describes it. */
function sameDeclaration(previous, resolved) {
  return previous.provider === resolved.provider && sameOperations(previous.operations, resolved.operations);
}

/** Nothing at all changed — not even the resolved state or the pack version. */
function sameResolvedRow(previous, resolved, packVersion) {
  return (
    previous.packVersion === packVersion &&
    previous.connectionId === resolved.connectionId &&
    previous.status === resolved.status &&
    previous.optional === resolved.optional
  );
}

/**
 * Resolve one declared binding into a ledger-shaped row (no persistence).
 *
 * @param {object} input
 * @param {string} input.email          identity (raw; owner-keyed here)
 * @param {string} input.packId
 * @param {string|null} input.packVersion
 * @param {object} input.binding        the pack's declaration
 * @param {object} input.client         createConnectorClient result (or null when unconfigured)
 */
export async function resolveBinding({ email, packId, binding, client }) {
  const key = ownerKey(email);
  const provider = String(binding?.provider ?? "").trim();
  const operations = declaredOperations(binding);
  const row = {
    email: key,
    packId,
    bindingKey: String(binding?.key ?? "").trim(),
    provider,
    operations,
    connectionId: null,
    connectionName: null,
    connectionVirtual: false,
    optional: !!binding?.optional,
    status: BINDING_STATUS.undetermined,
    reason: null,
  };

  // A declaration with only `allowActions` has no operation classes; the
  // classes are whatever the action rules imply, which only the catalog knows.
  // `catalog-coverage` without `operations` defaults to read,write, so an
  // action-only binding is qualified against both and refined on the first
  // grant. Keeping that explicit beats guessing here.
  const classes = operations.length > 0 ? operations : ["read", "write"];

  if (!key || !row.bindingKey || !provider) {
    return { ...row, status: BINDING_STATUS.undetermined, reason: "invalid_declaration" };
  }

  // No connector in this deployment: nothing can be resolved, and that is not
  // the same as "the user has no connection".
  if (!client) {
    return { ...row, reason: "connector_not_configured" };
  }

  const bindingRow = db.getConnectorBinding(key, bindingSlot(packId, row.bindingKey));
  if (bindingRow?.stale) {
    // A dead binding token is a *known* credential failure: report it as stale
    // rather than re-asking the catalog with a token that cannot authenticate.
    return { ...row, status: BINDING_STATUS.stale, reason: "binding_token_stale" };
  }

  // Catalog coverage, trying each candidate provider until one is wired.
  let unresolved = null;
  let resolvedProvider = null;
  for (const candidate of providerCandidates(binding)) {
    let coverage;
    try {
      coverage = await client.coverage(candidate, classes);
    } catch {
      // Same reasoning as in the client: an exception is silence, not a gap.
      return { ...row, status: BINDING_STATUS.undetermined, reason: "catalog_unreachable" };
    }
    if (coverage.ok) {
      const gaps = Array.isArray(coverage.body?.gaps) ? coverage.body.gaps : [];
      if (gaps.length === 0) {
        resolvedProvider = candidate;
        break;
      }
      // Known provider, insufficient surface: a capability gap, never `missing`.
      unresolved = unresolved ?? { status: BINDING_STATUS.unwired, reason: `catalog_gap:${gaps.join(",")}` };
      continue;
    }
    if (coverage.code === "unauthorized") {
      return { ...row, status: BINDING_STATUS.stale, reason: "credential_rejected" };
    }
    if (coverage.code === "not_found") {
      unresolved = unresolved ?? { status: BINDING_STATUS.unwired, reason: `unknown_provider:${candidate}` };
      continue;
    }
    // Timeout / 5xx / malformed body: we simply do not know.
    return { ...row, status: BINDING_STATUS.undetermined, reason: "catalog_unreachable" };
  }

  if (!resolvedProvider) {
    return { ...row, ...(unresolved ?? { status: BINDING_STATUS.undetermined, reason: "no_candidate" }) };
  }
  row.provider = resolvedProvider;

  // Local fact: does this identity hold a connection for that provider?
  let connections;
  try {
    connections = await client.connections();
  } catch {
    return { ...row, status: BINDING_STATUS.undetermined, reason: "connections_unreachable" };
  }
  if (!connections.ok) {
    if (connections.code === "unauthorized") {
      return { ...row, status: BINDING_STATUS.stale, reason: "credential_rejected" };
    }
    return { ...row, status: BINDING_STATUS.undetermined, reason: "connections_unreachable" };
  }
  const matches = (connections.body?.connections ?? []).filter(
    (connection) => connection?.service === resolvedProvider && connection?.configured !== false
  );
  if (matches.length === 0) {
    return { ...row, status: BINDING_STATUS.missing, reason: "no_connection" };
  }
  // Prefer the hinted connection name when the hint matches one of them.
  const hint = typeof binding?.connectionHint === "string" ? binding.connectionHint.trim() : "";
  const chosen = matches.find((connection) => connection.connectionName === hint) ?? matches[0];
  // The ledger records the connector's connection id (stable across renames).
  // The name and the virtual flag are transient: the status face needs them to
  // say "已连到 账套A" or "平台代管", but nothing keys off them.
  row.connectionId = chosen.id ?? chosen.connectionName ?? null;
  row.connectionName = chosen.connectionName ?? null;
  row.connectionVirtual = !!chosen.virtual;
  return { ...row, status: BINDING_STATUS.satisfied, reason: null };
}

/**
 * Resolve every binding a pack declares and write the ledger.
 *
 * Declaration changes are detected per binding key: a different provider or a
 * different operation set means the previous grant no longer describes what the
 * pack needs, so the binding token is dropped (the caller must ask the user to
 * grant again) and the row is rebuilt. A binding key the pack no longer
 * declares is marked `deprecated` — its token is left alone, because silently
 * revoking on upgrade would break a running session with no user action.
 *
 * Idempotent: an unchanged binding writes nothing, so a second resolution
 * leaves the ledger byte-for-byte identical (updated_at included).
 */
export async function resolvePack({ email, packId, packVersion = null, bindings = [], client = null }) {
  const key = ownerKey(email);
  const rows = [];
  for (const binding of bindings) {
    const resolved = await resolveBinding({ email: key, packId, binding, client });
    const slot = bindingSlot(packId, resolved.bindingKey);
    const previous = db.getConnectorBindingLedgerRow(key, packId, resolved.bindingKey);
    const declarationChanged = !!previous && !sameDeclaration(previous, resolved);
    if (declarationChanged) {
      // Old token describes the old declaration; keeping it would authorize a
      // surface the pack no longer asks for (or fail the new one silently).
      db.deleteConnectorBinding(key, slot);
      // And the old grant time must not outlive the grant: a row that says
      // "granted at T" with no token behind it is a lie to the status face.
      db.deleteConnectorBindingLedgerRow(key, packId, resolved.bindingKey);
    }
    const unchanged = !declarationChanged && previous && sameResolvedRow(previous, resolved, packVersion);
    const stored = unchanged
      ? previous
      : db.upsertConnectorBindingLedgerRow({
          email: key,
          packId,
          packVersion,
          bindingKey: resolved.bindingKey,
          provider: resolved.provider,
          operations: resolved.operations,
          connectionId: resolved.connectionId,
          status: resolved.status,
          optional: resolved.optional,
        });
    rows.push({ ...resolved, grantedAt: stored?.grantedAt ?? null });
  }

  // Keys the pack dropped become deprecated, not deleted.
  const declared = new Set(bindings.map((binding) => String(binding?.key ?? "").trim()));
  for (const previous of db.listConnectorBindingLedger(key, packId)) {
    if (declared.has(previous.bindingKey)) continue;
    if (previous.status === BINDING_STATUS.deprecated) continue;
    db.upsertConnectorBindingLedgerRow({
      email: key,
      packId,
      packVersion,
      bindingKey: previous.bindingKey,
      provider: previous.provider,
      operations: previous.operations,
      connectionId: previous.connectionId,
      status: BINDING_STATUS.deprecated,
      optional: previous.optional,
    });
  }

  return rows;
}

/** Ledger rows for one identity, optionally narrowed to one pack. Token-free. */
export function listBindings(email, packId = null) {
  return db.listConnectorBindingLedger(ownerKey(email), packId);
}

/**
 * Bindings a profile may inject: satisfied and backed by a live binding token.
 * A row without a token is not injectable (no grant yet), which is what keeps
 * "declared" from being mistaken for "authorized".
 */
export function injectableBindings(email, packId = null) {
  return listBindings(email, packId).filter((row) => {
    if (row.status !== BINDING_STATUS.satisfied) return false;
    const credential = db.getConnectorBinding(ownerKey(email), bindingSlot(row.packId, row.bindingKey));
    return credential && !credential.stale;
  });
}

/** The binding token a satisfied row injects, or null. */
export function liveBindingToken(email, packId, bindingKey) {
  const row = db.getConnectorBinding(ownerKey(email), bindingSlot(packId, bindingKey));
  return row && !row.stale ? row.token : null;
}

// ── Injection (add-connector-bindings D4: one track, per binding) ───────────
//
// A session's connector capability is a set of `connector:<slot>` MCP rows, one
// per authorized binding, each carrying its own scoped token. The slot is the
// binding's storage identity — `chat:explore` for the built-in, `<packId>:<key>`
// for a pack binding — so the row name is resolvable back to exactly one
// credential row without guessing (two packs may declare the same binding key).

export const CONNECTOR_BINDING_CREDENTIAL_REF = "connector-binding";
const BINDING_SERVER_PREFIX = "connector:";

/** The MCP server name for a binding slot. */
export function bindingServerName(slot) {
  return `${BINDING_SERVER_PREFIX}${slot}`;
}

/** The slot behind an MCP server name, or null when it is not a binding row. */
export function slotFromServerName(name) {
  return typeof name === "string" && name.startsWith(BINDING_SERVER_PREFIX)
    ? name.slice(BINDING_SERVER_PREFIX.length)
    : null;
}

/** The live token for a slot, by slot alone (injection + the 401 handler). */
export function liveTokenBySlot(email, slot) {
  const key = ownerKey(email);
  if (!key || !slot) return null;
  const row = db.getConnectorBinding(key, slot);
  return row && !row.stale ? row.token : null;
}

/**
 * Bindings this identity may inject right now, as `{slot, name, ...}` rows.
 *
 * Two sources, one rule ("a live token means authorized"):
 *   the built-in free-exploration binding, which has no ledger row (it belongs
 *   to no pack) — its token IS its authorization;
 *   pack bindings whose ledger row is `satisfied` — `missing`/`stale`/`unwired`
 *   must not inject, and `deprecated` must not either: a key the pack dropped
 *   keeps its token (so a running session is not broken mid-flight) but is no
 *   longer advertised.
 *
 * Pack bindings are additionally filtered by `installedPacks`: a pack that is no
 * longer installed must not keep a row, even if its ledger row lingers.
 */
export function injectionRows(email, { installedPacks = null } = {}) {
  const key = ownerKey(email);
  if (!key) return [];
  const live = new Map(
    db
      .listConnectorBindings(key)
      .filter((row) => !row.stale)
      .map((row) => [row.slot, row]),
  );
  const installed = installedPacks ? new Set(installedPacks) : null;
  const rows = [];

  for (const ledgerRow of db.listConnectorBindingLedger(key)) {
    if (ledgerRow.status !== BINDING_STATUS.satisfied) continue;
    if (installed && !installed.has(ledgerRow.packId)) continue;
    const slot = bindingSlot(ledgerRow.packId, ledgerRow.bindingKey);
    if (!live.has(slot)) continue;
    rows.push({
      slot,
      name: bindingServerName(slot),
      packId: ledgerRow.packId,
      bindingKey: ledgerRow.bindingKey,
      provider: ledgerRow.provider,
      operations: ledgerRow.operations,
      connectionId: ledgerRow.connectionId,
      builtin: false,
    });
  }

  const explore = live.get(db.CONNECTOR_EXPLORE_BINDING);
  if (explore) {
    rows.push({
      slot: db.CONNECTOR_EXPLORE_BINDING,
      name: bindingServerName(db.CONNECTOR_EXPLORE_BINDING),
      packId: null,
      bindingKey: db.CONNECTOR_EXPLORE_BINDING,
      provider: null,
      // Full authority, as granted before this change: the token's own scope is
      // the whole story, so there is no declared class list to report.
      operations: null,
      connectionId: null,
      builtin: true,
      purpose: explore.purpose ?? null,
    });
  }
  return rows;
}

/** Drop one binding's grant: the token row goes, the ledger row falls back. */
export function revokeBindingGrant(email, packId, bindingKey) {
  const key = ownerKey(email);
  const removed = db.deleteConnectorBinding(key, bindingSlot(packId, bindingKey));
  const previous = db.getConnectorBindingLedgerRow(key, packId, bindingKey);
  if (previous) {
    // The row must be rebuilt, not updated: `granted_at` upserts with COALESCE,
    // so a plain update would keep the old stamp and the status face would say
    // "granted at T" with no token behind it for the rest of the install.
    db.deleteConnectorBindingLedgerRow(key, packId, bindingKey);
    db.upsertConnectorBindingLedgerRow({
      email: key,
      packId,
      packVersion: previous.packVersion,
      bindingKey,
      provider: previous.provider,
      operations: previous.operations,
      connectionId: previous.connectionId,
      // Without a token the binding is back to "needs a grant"; the next
      // resolution decides between missing / unwired / satisfied.
      status: BINDING_STATUS.missing,
      optional: previous.optional,
    });
  }
  return removed;
}

/**
 * A 401 on an injected binding row: mark that binding stale. Returns true only
 * when the state actually changed, so the caller re-applies the profile once.
 */
export function markBindingInvalid(email, packId, bindingKey) {
  return db.markConnectorBindingStale(ownerKey(email), bindingSlot(packId, bindingKey));
}

/**
 * The same, addressed by slot — the 401 handler only knows the MCP server name
 * (`connector:<slot>`), and the slot identifies one binding even when two packs
 * declare the same key. Ledger rows keyed to that slot follow the credential
 * into `stale`, so the status face and the profile agree.
 */
export function markSlotInvalid(email, slot) {
  const key = ownerKey(email);
  if (!key || !slot) return false;
  const changed = db.markConnectorBindingStale(key, slot);
  if (!changed) return false;
  for (const row of db.listConnectorBindingLedger(key)) {
    if (bindingSlot(row.packId, row.bindingKey) !== slot) continue;
    if (row.status === BINDING_STATUS.deprecated) continue;
    db.upsertConnectorBindingLedgerRow({
      email: key,
      packId: row.packId,
      packVersion: row.packVersion,
      bindingKey: row.bindingKey,
      provider: row.provider,
      operations: row.operations,
      connectionId: row.connectionId,
      status: BINDING_STATUS.stale,
      optional: row.optional,
    });
  }
  return true;
}

export { bindingSlot };
