// Fleet template manifest parsing + validation (agent-fleet-templates).
//
// A pack's optional `fleet` section IS the template. This module is the single
// parser/validator for it: shape gates (members/ref tree/cadence/targets),
// cycle rejection over parentRef edges, cron sanity, the optional
// `orchestration` section (validated by the SAME pure validator the live
// write face uses — server/fleet-orchestration.js — over the template member
// set), and the normalization every consumer (pack pre-validation,
// provisioner, exporter round-trip) shares. Packs WITHOUT a fleet section are
// plain packs — every entry point short-circuits on absence and behaves
// exactly as before (D1/D2 risk note).

import cronParser from "cron-parser";
// Pure leaf module (zero imports of its own) — importing it here keeps this
// file gateway-safe (no task-engine module graph rides along).
import { validateOrchestration } from "./fleet-orchestration.js";

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

export const TEMPLATE_TARGET_KINDS = ["pack-preset", "existing-persona", "existing-cluster", "existing-a2a", "tool", "bot"];

// Template target kind → live-fleet targetKind. The orchestration validator
// speaks the LIVE member vocabulary (persona/cluster/a2a/tool/bot), so the
// template's members are projected through this map before validation — the
// member REFS stand in for the not-yet-minted member ids (design D3: same
// validator, member set swapped for the template's).
const TARGET_KIND_TO_MEMBER_KIND = {
  "pack-preset": "persona",
  "existing-persona": "persona",
  "existing-cluster": "cluster",
  "existing-a2a": "a2a",
  tool: "tool",
  bot: "bot",
};

// The live face's 'server::tool' contract (server/tool-turn.js owns the
// canonical regex; this local mirror keeps this module gateway-pure — the
// canonical module pulls chat-history along).
const TOOL_TARGET_SHAPE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)::([A-Za-z0-9][A-Za-z0-9._-]*)$/;
export const TEMPLATE_MEMBER_LIMIT = 50;

// Display-locale overlay shape (add-pack-locale-tracks D5) — same locale-tag
// rule as the pack manifest overlay (lib/pack-manifest.js LOCALE_KEY_RE).
const LOCALE_KEY_RE = /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
// Overlay values are display text (a template name, a post title, a slot
// label) — a generous single cap keeps abuse out without policing wording.
const LOCALE_DISPLAY_CHARS = 200;
const displayOverride = (v) => typeof v === "string" && !!v.trim() && v.length <= LOCALE_DISPLAY_CHARS;

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
    if (target.kind === "tool" && !TOOL_TARGET_SHAPE_RE.test(target.id)) {
      // Shape gate only (mirrors the live face's 'server::tool' contract);
      // whether the server is routable stays an instantiation-time fact.
      return { ok: false, error: `member '${ref}' tool target.id must be 'server::tool' (got '${target.id}')` };
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
      // Tool posts (add-tool-posts): the cadence prompt IS the tool's
      // arguments — a JSON object, deterministically (mirror of the live
      // write face's toolCadenceError; kept local for gateway purity).
      if (target.kind === "tool") {
        try {
          const parsed = JSON.parse(c.promptTemplate);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        } catch {
          return { ok: false, error: `member '${ref}' is a tool post — its cadence.promptTemplate must be a JSON object (the tool's arguments)` };
        }
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

  // Display locale overlay (add-pack-locale-tracks D5): `fleet.i18n` carries
  // secondary-language text for the template's DISPLAY fields only — name,
  // member titles, KPI slot labels. Structure (members/cadence/kpiSlots keys/
  // orchestration edges) is untouched, and content-layer text (promptTemplate,
  // persona) may never ride here. Built-in templates keep their nameKey/
  // titleKey/labelKey mechanism — the two channels coexist, never merge.
  if (section.i18n !== undefined) {
    const i18n = section.i18n;
    if (!i18n || typeof i18n !== "object" || Array.isArray(i18n)) {
      return { ok: false, error: "fleet.i18n must be an object mapping locale tags to display-field overrides" };
    }
    const locales = Object.keys(i18n);
    if (locales.length === 0) {
      return { ok: false, error: "fleet.i18n must carry at least one locale block (omit the key instead)" };
    }
    for (const locale of locales) {
      if (!LOCALE_KEY_RE.test(locale)) {
        return { ok: false, error: `fleet.i18n locale '${locale}' must be a lower-case BCP-47 tag` };
      }
      if (locale === "zh" || locale.startsWith("zh-")) {
        return { ok: false, error: `fleet.i18n may not declare '${locale}' — Chinese is the main track` };
      }
      const block = i18n[locale];
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return { ok: false, error: `fleet.i18n.${locale} must be an object of display-field overrides` };
      }
      for (const key of Object.keys(block)) {
        if (key !== "name" && key !== "members") {
          return { ok: false, error: `fleet.i18n.${locale} has unknown key '${key}' (only name, members)` };
        }
      }
      if (block.name !== undefined && !displayOverride(block.name)) {
        return { ok: false, error: `fleet.i18n.${locale}.name must be a non-empty string of at most ${LOCALE_DISPLAY_CHARS} characters` };
      }
      if (block.members === undefined) continue;
      if (!block.members || typeof block.members !== "object" || Array.isArray(block.members)) {
        return { ok: false, error: `fleet.i18n.${locale}.members must be an object mapping member refs to overrides` };
      }
      for (const [ref, ov] of Object.entries(block.members)) {
        const member = byRef.get(ref);
        if (!member) {
          return { ok: false, error: `fleet.i18n.${locale}.members references '${ref}', which the template does not declare` };
        }
        if (!ov || typeof ov !== "object" || Array.isArray(ov)) {
          return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'] must be an object of { title, kpiSlots }` };
        }
        for (const key of Object.keys(ov)) {
          if (key !== "title" && key !== "kpiSlots") {
            return {
              ok: false,
              error: `fleet.i18n.${locale}.members['${ref}'] has unknown key '${key}' (only title, kpiSlots — cadence/promptTemplate are content and not localizable)`,
            };
          }
        }
        if (ov.title !== undefined && !displayOverride(ov.title)) {
          return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].title must be a non-empty string of at most ${LOCALE_DISPLAY_CHARS} characters` };
        }
        if (ov.kpiSlots === undefined) continue;
        if (!ov.kpiSlots || typeof ov.kpiSlots !== "object" || Array.isArray(ov.kpiSlots)) {
          return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots must be an object mapping slot keys to { label }` };
        }
        const slotKeys = new Set((member.kpiSlots ?? []).map((s) => s?.key).filter((k) => typeof k === "string"));
        for (const [slotKey, slotOv] of Object.entries(ov.kpiSlots)) {
          if (!slotKeys.has(slotKey)) {
            return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots references '${slotKey}', which member '${ref}' does not declare` };
          }
          if (!slotOv || typeof slotOv !== "object" || Array.isArray(slotOv)) {
            return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots['${slotKey}'] must be an object of { label }` };
          }
          for (const key of Object.keys(slotOv)) {
            if (key !== "label") {
              return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots['${slotKey}'] has unknown key '${key}' (only label)` };
            }
          }
          if (slotOv.label !== undefined && !displayOverride(slotOv.label)) {
            return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots['${slotKey}'].label must be a non-empty string of at most ${LOCALE_DISPLAY_CHARS} characters` };
          }
        }
      }
    }
  }

  // Orchestration section (add-mixed-fleet-packs D3): the SAME validator the
  // live write face uses, with the template members projected into the live
  // member vocabulary (ref stands in for the future member id) — one source,
  // the member set swapped. Present-but-null passes trivially (the live face
  // treats null as "explicitly no edges"); ABSENT short-circuits entirely so
  // the section-less parse output stays byte-identical.
  if (section.orchestration !== undefined) {
    const projected = pending.map((m) => ({ id: m.ref, targetKind: TARGET_KIND_TO_MEMBER_KIND[m.target.kind] }));
    const check = validateOrchestration({ members: projected, orchestration: section.orchestration });
    if (!check.ok) {
      return {
        ok: false,
        error: `fleet.orchestration: ${check.errors[0].error}`,
        errors: check.errors,
      };
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
      ...(section.orchestration !== undefined ? { orchestration: section.orchestration } : {}),
    },
  };
}

// The export whitelist (3.3): the ONLY fields an exported manifest carries.
// Reports, decisions, sessions, owners, credentials never enter this shape.
// The live orchestration section survives verbatim (spec: 导出保留现役编导
// 段) — its edges already speak member ids, and the export's refs ARE those
// ids, so the section re-parses as a template unchanged.
export function exportFleetToTemplate(fleet, members) {
  const memberFor = (targetKind) =>
    targetKind === "cluster"
      ? "existing-cluster"
      : targetKind === "a2a"
        ? "existing-a2a"
        : targetKind === "tool" || targetKind === "bot"
          ? targetKind
          : "existing-persona";
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
      ...(fleet.orchestration ? { orchestration: fleet.orchestration } : {}),
    },
  };
}
