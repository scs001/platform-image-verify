// Fleet template manifest parsing + validation (agent-fleet-templates).
//
// A pack's optional `fleet` section IS the template. This module is the single
// parser/validator for it: shape gates (members/ref tree/cadence/targets),
// cycle rejection over parentRef edges, cron sanity, and the normalization
// every consumer (pack pre-validation, provisioner, exporter round-trip)
// shares. Packs WITHOUT a fleet section are plain packs — every entry point
// short-circuits on absence and behaves exactly as before (D1/D2 risk note).

import cronParser from "cron-parser";

// Minimal cron check (the engine's own parser, applied standalone): this
// module is also imported by the GATEWAY process (pack pre-validation), so it
// must not pull the task engine's module graph along.
function validateCron(expr, tz) {
  try {
    cronParser.parseExpression(expr, { tz: tz || undefined });
    return null;
  } catch {
    return `invalid cron expression: ${expr}`;
  }
}

export const TEMPLATE_TARGET_KINDS = ["pack-preset", "existing-persona", "existing-cluster", "existing-a2a"];
export const TEMPLATE_MEMBER_LIMIT = 50;

// Parse + validate a manifest's fleet section. Returns
// { ok: true, template } | { ok: false, error } — never throws.
export function parseFleetTemplate(manifest) {
  if (!manifest || typeof manifest !== "object") return { ok: false, error: "manifest must be an object" };
  const section = manifest.fleet;
  if (section === undefined || section === null) return { ok: false, error: "no fleet section" };
  if (typeof section !== "object" || Array.isArray(section)) {
    return { ok: false, error: "fleet section must be an object" };
  }
  const { name, nameKey, cover, members, requires } = section;
  const display = name ?? nameKey;
  if (typeof display !== "string" || !display.trim()) {
    return { ok: false, error: "fleet.name (or nameKey) is required" };
  }
  if (!Array.isArray(members) || members.length === 0) {
    return { ok: false, error: "fleet.members must be a non-empty array" };
  }
  if (members.length > TEMPLATE_MEMBER_LIMIT) {
    return { ok: false, error: `fleet.members is capped at ${TEMPLATE_MEMBER_LIMIT}` };
  }

  const seenRefs = new Set();
  const pending = [];
  for (const m of members) {
    if (!m || typeof m !== "object") return { ok: false, error: "each member must be an object" };
    const ref = m.ref;
    if (typeof ref !== "string" || !ref.trim()) return { ok: false, error: "each member needs a ref" };
    if (seenRefs.has(ref)) return { ok: false, error: `duplicate member ref '${ref}'` };
    seenRefs.add(ref);
    const title = m.title ?? m.titleKey;
    if (typeof title !== "string" || !title.trim()) {
      return { ok: false, error: `member '${ref}' needs a title (or titleKey)` };
    }
    const target = m.target;
    if (!target || typeof target !== "object") return { ok: false, error: `member '${ref}' needs a target` };
    if (!TEMPLATE_TARGET_KINDS.includes(target.kind)) {
      return { ok: false, error: `member '${ref}' target.kind must be one of ${TEMPLATE_TARGET_KINDS.join(", ")}` };
    }
    if (target.kind === "pack-preset") {
      if (typeof target.packId !== "string" || !target.packId.trim() || typeof target.presetId !== "string" || !target.presetId.trim()) {
        return { ok: false, error: `member '${ref}' pack-preset target needs packId and presetId` };
      }
    } else if (typeof target.id !== "string" || !target.id.trim()) {
      return { ok: false, error: `member '${ref}' ${target.kind} target needs an id` };
    }
    if (m.kpiSlots !== undefined) {
      if (!Array.isArray(m.kpiSlots) || m.kpiSlots.length > 8) {
        return { ok: false, error: `member '${ref}' kpiSlots must be an array of at most 8` };
      }
      for (const slot of m.kpiSlots) {
        const label = slot?.label ?? slot?.labelKey;
        if (typeof slot?.key !== "string" || !slot.key.trim() || typeof label !== "string" || !label.trim()) {
          return { ok: false, error: `member '${ref}' kpiSlots need key and label` };
        }
      }
    }
    if (m.cadence !== undefined && m.cadence !== null) {
      const c = m.cadence;
      if (typeof c !== "object" || typeof c.cron !== "string") {
        return { ok: false, error: `member '${ref}' cadence must be {cron, tz?, promptTemplate}` };
      }
      const invalid = validateCron(c.cron, c.tz ?? null);
      if (invalid) return { ok: false, error: `member '${ref}': ${invalid}` };
      if (typeof c.promptTemplate !== "string" || !c.promptTemplate.trim()) {
        return { ok: false, error: `member '${ref}' cadence needs a promptTemplate` };
      }
    }
    pending.push(m);
  }

  // parentRef edges: must name known refs, must not form a cycle (walk up with
  // a visited guard — same contract as the runtime's post-tree).
  const byRef = new Map(pending.map((m) => [m.ref, m]));
  for (const m of pending) {
    if (m.parentRef === undefined || m.parentRef === null) continue;
    if (typeof m.parentRef !== "string" || !byRef.has(m.parentRef)) {
      return { ok: false, error: `member '${m.ref}' parentRef names no member` };
    }
    let cursor = m.parentRef;
    const walked = new Set();
    while (cursor != null) {
      if (cursor === m.ref || walked.has(cursor)) {
        return { ok: false, error: `member '${m.ref}' parentRef chain forms a cycle` };
      }
      walked.add(cursor);
      cursor = byRef.get(cursor)?.parentRef ?? null;
    }
  }

  if (requires !== undefined && requires !== null) {
    if (!Array.isArray(requires)) return { ok: false, error: "fleet.requires must be an array" };
    for (const r of requires) {
      if (!r || typeof r.name !== "string" || !r.name.trim()) {
        return { ok: false, error: "each require needs a name" };
      }
    }
  }

  return {
    ok: true,
    template: {
      name: String(display).trim(),
      ...(cover ? { cover: String(cover) } : {}),
      members: pending.map((m) => ({
        ref: m.ref,
        title: String(m.title ?? m.titleKey).trim(),
        parentRef: m.parentRef ?? null,
        target: m.target,
        kpiSlots: (m.kpiSlots ?? []).map((s) => ({ ...s, label: String(s.label ?? s.labelKey).trim() })),
        cadence: m.cadence ?? null,
      })),
      requires: (requires ?? []).map((r) => ({ kind: r.kind ?? "a2a", name: String(r.name).trim(), optional: r.optional === true })),
    },
  };
}

// The export whitelist (3.3): the ONLY fields an exported manifest carries.
// Reports, decisions, sessions, owners, credentials never enter this shape.
export function exportFleetToTemplate(fleet, members) {
  const memberFor = (targetKind) =>
    targetKind === "cluster" ? "existing-cluster" : targetKind === "a2a" ? "existing-a2a" : "existing-persona";
  return {
    fleet: {
      name: fleet.name,
      members: members.map((m) => ({
        ref: m.id,
        title: m.title,
        parentRef: members.find((x) => x.id === m.parentId)?.id ?? null,
        target: { kind: memberFor(m.targetKind), id: m.targetId },
        kpiSlots: m.kpiSlots ?? [],
        ...(m.cadence
          ? { cadence: { cron: m.cadence.cron, tz: m.cadence.tz ?? null, promptTemplate: m.cadence.promptTemplate } }
          : {}),
      })),
      requires: [],
    },
  };
}
