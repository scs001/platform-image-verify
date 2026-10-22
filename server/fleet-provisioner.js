// Fleet template provisioner (agent-fleet-templates).
//
// Pure orchestration over the existing single-writer surfaces — fleets-db,
// catalog, clusters store, reconcile — never a direct write into another
// module's storage. Contract (design D3/D4/D5):
//   dedup  : a live fleet from the same pack for the same owner returns as-is
//   resolve: per-post target resolution with per-post degradation — a missing
//            incumbent still gets its POST (vacant, listed in `missing`)
//   paused : the fleet is created all-paused; materialized tasks park too;
//            the owner starts it explicitly (install never auto-runs)
import { parseFleetTemplate } from "./fleet-template.js";

// deps: { db, resolveExisting({kind,id}) => boolean|object, rosterPresetId,
//         reconcile(fleetId), catalogAgentIds(): Set<string> }
export async function provisionFleetFromTemplate({
  packId,
  version,
  manifest,
  ownerEmail,
  deps,
  now = Date.now(),
}) {
  const parsed = parseFleetTemplate(manifest);
  if (!parsed.ok) return { ok: false, error: `invalid fleet template: ${parsed.error}` };
  const template = parsed.template;

  // Dedup anchor (D5): same pack + same owner + still live → the existing
  // fleet is the answer; re-installing a pack must not mint a twin.
  const existing = deps.db.findFleetByTemplate(packId, ownerEmail);
  if (existing) return { ok: true, fleet: existing, deduped: true };

  const missing = [];
  const resolved = [];

  for (const m of template.members) {
    let targetKind = null;
    let targetId = null;
    let degraded = false;

    if (m.target.kind === "pack-preset") {
      // The pack's own agent, materialized by the install chain — resolve
      // against the live catalog by preset id.
      targetKind = "persona";
      targetId = m.target.presetId;
      if (!deps.catalogAgentIds().has(m.target.presetId)) {
        degraded = true;
      }
    } else if (m.target.kind === "existing-persona") {
      targetKind = "persona";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "persona", id: m.target.id });
    } else if (m.target.kind === "existing-cluster") {
      targetKind = "cluster";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "cluster", id: m.target.id });
    } else if (m.target.kind === "existing-a2a") {
      targetKind = "a2a";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "a2a", id: m.target.id });
    }

    if (degraded) {
      // The post is still created (vacant by targetRef resolution) — the
      // structure is the template's value; the incumbent can be staffed later.
      missing.push({ ref: m.ref, title: m.title, kind: m.target.kind });
    }
    resolved.push({
      member: m,
      targetKind: targetKind ?? "persona",
      targetId: targetId ?? m.target.id ?? m.ref,
    });
  }

  const fleet = deps.db.createFleet({
    id: `fleet_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: template.name,
    ownerEmail,
    // All-paused at birth INCLUDING the fleet layer: the cockpit shows the
    // 待启动 banner and the owner's start flips both layers (D3).
    state: "paused",
    sourceTemplate: { packId, version: version ?? null },
  });

  const idByRef = new Map();
  for (const r of resolved) {
    const id = `m_${now}_${Math.random().toString(36).slice(2, 8)}`;
    idByRef.set(r.member.ref, id);
  }
  for (const r of resolved) {
    deps.db.createMember({
      id: idByRef.get(r.member.ref),
      fleetId: fleet.id,
      title: r.member.title,
      parentId: r.member.parentRef ? (idByRef.get(r.member.parentRef) ?? null) : null,
      targetKind: r.targetKind,
      targetId: r.targetId,
      kpiSlots: r.member.kpiSlots ?? [],
      // ALL PAUSED at birth (D3): the owner reviews then starts the fleet.
      cadence: r.member.cadence ? { ...r.member.cadence, enabled: false } : null,
    });
  }

  // Converge the materialized tasks under the paused policy (they park).
  await deps.reconcile(fleet.id);

  return {
    ok: true,
    fleet,
    memberIdByRef: Object.fromEntries(idByRef),
    missing,
    pausedAtBirth: true,
  };
}
