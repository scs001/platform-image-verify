// ── Pack locale tracks resolver (add-pack-locale-tracks) ────────────────────
//
// The ONE place locale resolution lives, shared by the gateway market read
// faces (list summary / detail) and the cell's installed-pack faces, so no
// client ever re-implements the strategy.
//
// Model (design D1/D2): the base display fields of a pack manifest ARE the
// Chinese main track. An optional top-level `i18n` block carries secondary-
// language overrides; a request for a locale renders the override when the
// block declares that field, and falls back to the zh base otherwise. There is
// no cross-locale fallback chain — zh is the only fallback endpoint. A manifest
// without an `i18n` block therefore projects to itself, byte-identical.
//
// Zero-dependency leaf (same discipline as lib/rhythm.js, server/fleet-
// orchestration.js): this module is imported by the gateway process, so it
// must not pull any module graph along.

// Locale tags we accept and normalize to their primary subtag. Mirrors the
// publish gate's LOCALE_KEY_RE shape (lib/pack-manifest.js) — lowercase
// BCP-47, primary subtag first.
const LOCALE_TAG_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

// Normalize a locale tag to the form overlays are keyed by: lowercase, and
// `zh*` collapses to plain `zh` (Chinese is the base track — `i18n['zh-CN']`
// is never a legal overlay key, so the base fields serve it). Returns null for
// anything that is not tag-shaped.
export function normalizeLocale(tag) {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim().toLowerCase();
  if (!LOCALE_TAG_RE.test(trimmed)) return null;
  const primary = trimmed.split("-")[0];
  return primary === "zh" ? "zh" : trimmed;
}

// First tag of an Accept-Language header, crudely: no q-value ranking (the
// market API's precision does not warrant the complexity — an explicit
// `locale` parameter is the exact channel). Returns null when nothing usable.
export function localeFromAcceptLanguage(header) {
  if (typeof header !== "string" || !header.trim()) return null;
  const first = header.split(",")[0].replace(/;.*$/, "").trim();
  return normalizeLocale(first);
}

// The resolution priority (design D2): explicit request locale, then the
// Accept-Language header, then `zh`. Always returns a usable tag.
export function resolveLocale({ locale, acceptLanguage } = {}) {
  return normalizeLocale(locale) || localeFromAcceptLanguage(acceptLanguage) || "zh";
}

// Look up one locale block in a manifest's overlay, tolerant of a primary-
// subtag request (`en-US` finds the `en` block) but never of a zh request
// (zh renders the base fields).
function localeBlockAt(map, locale) {
  if (!map || typeof map !== "object" || Array.isArray(map) || locale === "zh") return null;
  const block = map[locale];
  if (block && typeof block === "object" && !Array.isArray(block)) return block;
  const primary = locale.split("-")[0];
  if (primary !== locale) {
    const fallbackBlock = map[primary];
    if (fallbackBlock && typeof fallbackBlock === "object" && !Array.isArray(fallbackBlock)) return fallbackBlock;
  }
  return null;
}

function overlayFor(manifest, locale) {
  const overlay = manifest && typeof manifest === "object" ? manifest.i18n : null;
  return localeBlockAt(overlay, locale);
}

// The fleet template's overlay lives INSIDE the fleet section (design D5) —
// display fields only (template name, member titles, KPI slot labels); the
// template's structure is never localized.
function fleetOverlayFor(manifest, locale) {
  const fleet = manifest && typeof manifest === "object" ? manifest.fleet : null;
  if (!fleet || typeof fleet !== "object") return null;
  return localeBlockAt(fleet.i18n, locale);
}

// A single display field under one locale: the override when it is a non-empty
// string, else the zh base. Exported for callers projecting ad-hoc fields.
export function pickLocalized(base, override, locale) {
  if (locale === "zh") return base;
  return typeof override === "string" && override.trim() ? override : base;
}

// Project a manifest for display in `locale`: a copy whose covered base fields
// carry the locale text. Untouched manifests (no overlay, or a zh request)
// return the SAME object — the byte-identical default path. The `i18n` block
// itself rides along unchanged so author tools can render the multi-locale
// source (design D2).
export function projectManifestForLocale(manifest, locale) {
  const tag = normalizeLocale(locale) || "zh";
  const block = overlayFor(manifest, tag);
  const fleetBlock = fleetOverlayFor(manifest, tag);
  if (!block && !fleetBlock) return manifest;

  const out = { ...manifest };

  if (block) {
    for (const key of ["name", "description", "notes"]) {
      if (block[key] !== undefined) out[key] = pickLocalized(manifest[key], block[key], tag);
    }
  }

  // Usage guide: the overlay covers the whole three-step group or nothing
  // (publish gate). Project per covered step defensively anyway.
  if (block && block.guide && typeof block.guide === "object" && Array.isArray(manifest.guide?.steps)) {
    const steps = block.guide.steps;
    out.guide = {
      ...manifest.guide,
      steps: manifest.guide.steps.map((st, i) => {
        const ov = Array.isArray(steps) ? steps[i] : null;
        if (!ov || typeof ov !== "object") return st;
        const next = { ...st };
        for (const k of ["title", "body"]) {
          if (ov[k] !== undefined) next[k] = pickLocalized(st[k], ov[k], tag);
        }
        return next;
      }),
    };
  }

  if (block && block.skills && Array.isArray(manifest.skills)) {
    out.skills = manifest.skills.map((s) => {
      const ov = s && typeof s.name === "string" ? block.skills[s.name] : null;
      if (!ov || typeof ov !== "object" || ov.description === undefined) return s;
      return { ...s, description: pickLocalized(s.description, ov.description, tag) };
    });
  }

  if (block && block.agents && Array.isArray(manifest.agents)) {
    out.agents = manifest.agents.map((a) => {
      const ov = a && typeof a.id === "string" ? block.agents[a.id] : null;
      if (!ov || typeof ov !== "object") return a;
      const next = { ...a };
      if (ov.name !== undefined) next.name = pickLocalized(a.name, ov.name, tag);
      const cardOv = ov.serving && typeof ov.serving === "object" ? ov.serving.card : null;
      if (cardOv && typeof cardOv === "object" && a.serving && typeof a.serving.card === "object") {
        const card = { ...a.serving.card };
        if (cardOv.name !== undefined) card.name = pickLocalized(a.serving.card.name, cardOv.name, tag);
        if (cardOv.description !== undefined) card.description = pickLocalized(a.serving.card.description, cardOv.description, tag);
        if (cardOv.skills && Array.isArray(a.serving.card.skills)) {
          card.skills = a.serving.card.skills.map((cs) => {
            const csOv = cs && typeof cs.id === "string" ? cardOv.skills[cs.id] : null;
            if (!csOv || typeof csOv !== "object") return cs;
            const nextCs = { ...cs };
            if (csOv.name !== undefined) nextCs.name = pickLocalized(cs.name, csOv.name, tag);
            if (csOv.description !== undefined) nextCs.description = pickLocalized(cs.description, csOv.description, tag);
            return nextCs;
          });
        }
        next.serving = { ...a.serving, card };
      }
      return next;
    });
  }

  if (block && block.bots && Array.isArray(manifest.bots)) {
    out.bots = manifest.bots.map((b) => {
      const ov = b && typeof b.id === "string" ? block.bots[b.id] : null;
      if (!ov || typeof ov !== "object") return b;
      const next = { ...b };
      if (ov.name !== undefined) next.name = pickLocalized(b.name, ov.name, tag);
      if (ov.description !== undefined) next.description = pickLocalized(b.description, ov.description, tag);
      return next;
    });
  }

  if (block && block.cluster && manifest.cluster && typeof manifest.cluster === "object") {
    const next = { ...manifest.cluster };
    for (const k of ["name", "description"]) {
      if (block.cluster[k] !== undefined) next[k] = pickLocalized(manifest.cluster[k], block.cluster[k], tag);
    }
    out.cluster = next;
  }

  // Fleet template display fields (D5): fleet.i18n → { name?, members: {
  // <ref>: { title?, kpiSlots: { <slotKey>: { label? } } } } }. Structure is
  // never localized; uncovered members and slots fall back to their zh base.
  if (fleetBlock && Array.isArray(manifest.fleet.members)) {
    const fleet = { ...manifest.fleet };
    if (fleetBlock.name !== undefined) fleet.name = pickLocalized(manifest.fleet.name, fleetBlock.name, tag);
    const memberOverrides = fleetBlock.members && typeof fleetBlock.members === "object" && !Array.isArray(fleetBlock.members)
      ? fleetBlock.members
      : null;
    if (memberOverrides) {
      fleet.members = manifest.fleet.members.map((m) => {
        const ov = m && typeof m.ref === "string" ? memberOverrides[m.ref] : null;
        if (!ov || typeof ov !== "object" || Array.isArray(ov)) return m;
        const next = { ...m };
        if (ov.title !== undefined) next.title = pickLocalized(m.title, ov.title, tag);
        const slotOverrides = ov.kpiSlots && typeof ov.kpiSlots === "object" && !Array.isArray(ov.kpiSlots) ? ov.kpiSlots : null;
        if (slotOverrides && Array.isArray(m.kpiSlots)) {
          next.kpiSlots = m.kpiSlots.map((s) => {
            const sOv = s && typeof s.key === "string" ? slotOverrides[s.key] : null;
            if (!sOv || typeof sOv !== "object" || sOv.label === undefined) return s;
            return { ...s, label: pickLocalized(s.label, sOv.label, tag) };
          });
        }
        return next;
      });
    }
    out.fleet = fleet;
  }

  return out;
}

// Overlay a locale onto a market SUMMARY row (name/description come from the
// denormalized zh columns, the manifest from the version): returns the summary
// unchanged for zh, unreadable manifests, or manifests without a matching
// block, so non-locale callers keep their exact shape. Shares the projection
// with every other read face — the one place the strategy lives.
export function applyLocaleToSummary(summary, manifest, locale) {
  const tag = normalizeLocale(locale) || "zh";
  if (tag === "zh" || !manifest || typeof manifest !== "object") return summary;
  const projected = projectManifestForLocale(manifest, tag);
  if (projected === manifest) return summary;
  return {
    ...summary,
    ...(typeof projected.name === "string" && projected.name.trim() ? { name: projected.name } : {}),
    ...(typeof projected.description === "string" ? { description: projected.description } : {}),
  };
}

// Project a list of pack-like records ({ name, manifest }) for one request:
// installed-pack cards on the cell and any other record list use the same
// rules as the market. zh (or absent) returns the SAME array untouched.
export function projectPackList(packs, { locale, acceptLanguage } = {}) {
  const tag = resolveLocale({ locale, acceptLanguage });
  if (tag === "zh" || !Array.isArray(packs) || packs.length === 0) return packs;
  return packs.map((p) => {
    if (!p || typeof p !== "object" || !p.manifest || typeof p.manifest !== "object") return p;
    const projected = projectManifestForLocale(p.manifest, tag);
    if (projected === p.manifest) return p;
    return {
      ...p,
      ...(typeof projected.name === "string" && projected.name.trim() ? { name: projected.name } : {}),
      manifest: projected,
    };
  });
}