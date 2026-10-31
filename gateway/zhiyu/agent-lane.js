// ── Zhiyu agent lane (add-zhiyu-room) ────────────────────────────────────────
//
// The room router's live dispatch lane: member seat → live deployment → one
// a2a turn against the deployment's runtime route through the registry
// proxy. Wire contract reuses the platform's a2a client verbatim (depth 0 —
// room routing is an internal conversation lane, not cross-agent delegation,
// so no X-Delegation-Depth header and none of its cycle-budget semantics).
// Seat ref convention: `${packId}:${agentId}` with onBehalfOf = deployer.

import { createHash } from "node:crypto";
import { runA2aTurn } from "../../server/a2a-client.js";

// Visitor scope derivation (add-matter-visitor-scope's convention: sha256 of
// the lane id, first 32 hex). For room turns the "visitor" is the ASKING
// member — a matter the facade opens from this turn binds to (room, asker),
// exactly like a facade visitor's scope binds to their conversation lane.
const scopeFor = (seed) => (typeof seed === "string" && seed ? createHash("sha256").update(seed).digest("hex").slice(0, 32) : null);

export function createZhiyuAgentLane({ bookings, registryUrl, registryToken, backendToken, packsInternalBase }) {
  const resolveDeployment = async (member) => {
    if (!bookings) return null;
    const [packId, agentId] = String(member.ref ?? "").split(":");
    if (!packId || !agentId) return null;
    const rows = await bookings.rows();
    return (
      rows.find(
        (d) => d.packId === packId && d.agentId === agentId && (!member.onBehalfOf || d.deployedBy === member.onBehalfOf),
      ) ?? null
    );
  };

  const callAgent = async (member, { text, contextId, onDelta, scopeSeed = null }) => {
    const dep = await resolveDeployment(member);
    if (!dep?.agentPath) throw new Error(`agent seat has no live deployment (${member.ref})`);
    if (!registryUrl()) throw new Error("agent serving registry not configured (AGENT_SERVING_REGISTRY_URL/REGISTRY_URL)");
    const controller = new AbortController();
    const scope = scopeFor(scopeSeed);
    return runA2aTurn(`${registryUrl()}/agent${dep.agentPath}/`, text, {
      contextId,
      depth: 0,
      gatewayToken: registryToken(),
      agentToken: backendToken(),
      onDelta,
      signal: controller.signal,
      ...(scope ? { metadata: { visitor_scope: scope } } : {}),
    });
  };

  // Per-answer settlement (group 7): hits the packs internal host-settle
  // route against the seat's deployment billing key. usage ids are
  // idempotency-keyed end-to-end, so a re-run of a turn's settle is safe.
  const settleTurn = async (member, { usageId, minutes }) => {
    const dep = await resolveDeployment(member);
    if (!dep) throw new Error(`agent seat has no live deployment (${member.ref})`);
    const r = await fetch(
      `${packsInternalBase()}/api/packs/internal/deployments/${encodeURIComponent(dep.packId)}/${encodeURIComponent(dep.agentId)}/host-settle`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${registryToken()}` },
        body: JSON.stringify({ usage_id: usageId, minutes }),
      },
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`host-settle HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    return r.json();
  };

  return { callAgent, resolveDeployment, settleTurn };
}
