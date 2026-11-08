// Deployment-scoped connector bindings (add-deployment-binding-grant).
//
// The interactive path mints a binding from the user's own connector account:
// the account token is the parent, and the binding token is an attenuated
// child (connector-grants.mintBindingToken). That path needs a person present.
//
// A served agent has no person at runtime, so the mint has to happen at DEPLOY
// time, by the deployer, and the token has to live somewhere the runtime can
// reach without a session. `deployment_secrets` is exactly that seat: the value
// stays platform-side and only an opaque reference rides the descriptor to the
// runner. This module is the bridge between the two — mint with the deployer's
// account, record as a deployment secret.
//
// Deliberately NOT done here: relaxing the connector's "service tokens cannot
// mint PATs" rule. That rule is right — a service identity does not own what it
// would mint — and deployment-time minting keeps the parent a real person.

import * as db from "./db.js";
import * as grants from "./connector-grants.js";

/** Prefix that marks a deployment secret as ours. Secrets are user-namespaced. */
export const DEPLOYMENT_BINDING_PREFIX = "connector_binding_";

/**
 * Deployment secret name for a binding key. Secret names are `[a-z0-9_]{1,32}`
 * (SECRET_NAME_RE), so the key is folded into that alphabet and truncated —
 * consults `deploymentBindingKey()` to read it back rather than parsing.
 */
export function deploymentBindingSecretName(bindingKey) {
  const folded = String(bindingKey)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const room = 32 - DEPLOYMENT_BINDING_PREFIX.length;
  return `${DEPLOYMENT_BINDING_PREFIX}${folded.slice(0, room) || "binding"}`;
}

/**
 * Which declared bindings a deployment should carry a token for.
 *
 * The state matrix is the binding ledger's, not a local opinion: only
 * `satisfied` rows are mintable, `optional` rows are the user's choice, and the
 * three "cannot answer" states (`missing`, `unwired`, `undetermined`) are
 * skipped rather than guessed at. `deprecated` is history.
 */
export function mintableBindings({ email, packId }) {
  const rows = db.listConnectorBindingLedger(email, packId);
  return rows
    .filter((row) => !row.optional && row.status === "satisfied")
    .map((row) => ({ bindingKey: row.bindingKey, provider: row.provider, operations: row.operations ?? [] }));
}

/**
 * Mint one deployment binding and record it as a deployment secret.
 *
 * Idempotent per (pack, agent, key): re-recording rotates the stored value, and
 * the caller is expected to have revoked the previous token first (redeploying
 * must not leave two live tokens for one binding).
 */
export async function mintDeploymentBinding({ email, packId, agentId, bindingKey, provider, operations, record, fetchImpl = fetch }) {
  const minted = await grants.mintBindingToken({
    email,
    packId,
    bindingKey,
    provider,
    operations,
    fetchImpl,
  });
  if (!minted.ok) return { ok: false, bindingKey, code: minted.code ?? "mint_failed" };
  const name = deploymentBindingSecretName(bindingKey);
  record({
    packId,
    agentId,
    name,
    // The reference is what the descriptor carries; the token never does.
    secretRef: `sec_${packId}_${agentId}_${name}`,
    secretValue: minted.token,
    deployer: email,
  });
  return { ok: true, bindingKey, name, patId: minted.patId ?? null };
}

/**
 * Mint every mintable binding for the agents being deployed.
 *
 * Never throws and never fails the deploy: a pack that cannot get a binding
 * token still deploys (the binding surface reports it as unresolved), which is
 * the same posture install takes — a capability gap must not block shipping.
 * Failures are returned so the deploy surface can name them.
 */
export async function mintDeploymentBindings({ email, packId, agentIds, record, fetchImpl = fetch }) {
  const mintable = mintableBindings({ email, packId });
  const granted = [];
  const failed = [];
  for (const agentId of agentIds) {
    for (const binding of mintable) {
      const result = await mintDeploymentBinding({
        email,
        packId,
        agentId,
        bindingKey: binding.bindingKey,
        provider: binding.provider,
        operations: binding.operations,
        record,
        fetchImpl,
      });
      (result.ok ? granted : failed).push({ agentId, ...result });
    }
  }
  return { granted, failed, skipped: db.listConnectorBindingLedger(email, packId).length - mintable.length };
}
