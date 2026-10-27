// ── Steward reporting door (add-cell-lifecycle 4.2) ─────────────────────────
//
// The ONE endpoint a steward-kind device credential may open (spec
// device-pairing-auth delta): posting `cell_presence` / `cell_manifest`
// events. The payload is whitelisted BY SHAPE — content fields are absent
// from the whitelist's type space, so prompts, sessions and tool args never
// reach the relay. Relay target is the same 萬星 ingest the gateway's own
// cell-sampler uses; without FLEET_INGEST_* set the door accepts-and-drops
// (202) — degrade-open: reporting never blocks a cell.

import crypto from "node:crypto";

const PRESENCE_FIELDS = new Set(["state", "os", "appVersion", "protocolVersion", "at"]);
const MANIFEST_FIELDS = new Set(["fleetCount", "memberCount", "enabledTaskCount", "labels", "at"]);
const LABELS_MAX = 32;
const LABEL_MAX_CHARS = 64;

function shapeWhitelisted(payload, allowed) {
  const out = {};
  for (const key of allowed) {
    if (payload?.[key] == null) continue;
    out[key] = payload[key];
  }
  if (out.labels != null) {
    out.labels = Array.isArray(out.labels)
      ? out.labels.filter((v) => typeof v === "string").slice(0, LABELS_MAX).map((v) => v.slice(0, LABEL_MAX_CHARS))
      : [];
  }
  return out;
}

export function createCellReportDoor({ appAuth, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const baseUrl = String(env.FLEET_INGEST_URL || "").trim().replace(/\/+$/, "");
  const relayToken = String(env.FLEET_INGEST_TOKEN || "").trim();
  const relayOn = Boolean(baseUrl && relayToken);

  async function handle(req, res) {
    const bearer = String(req.headers.authorization || "").startsWith("Bearer ")
      ? String(req.headers.authorization).slice(7)
      : null;
    const who = bearer ? appAuth.stewardFromToken(bearer) : null;
    if (!who) return res.status(401).json({ error: "steward credential required" });

    const kind = req.body?.kind;
    if (!["presence", "manifest"].includes(kind)) {
      return res.status(400).json({ error: "kind must be one of presence|manifest" });
    }
    const allowed = kind === "presence" ? PRESENCE_FIELDS : MANIFEST_FIELDS;
    const payload = shapeWhitelisted(req.body?.payload ?? {}, allowed);
    if (kind === "presence" && typeof payload.state !== "string") {
      return res.status(400).json({ error: "presence.payload.state is required" });
    }
    if (kind === "manifest") {
      for (const k of ["fleetCount", "memberCount", "enabledTaskCount"]) {
        if (payload[k] != null && !Number.isFinite(payload[k])) {
          return res.status(400).json({ error: `manifest.payload.${k} must be a number` });
        }
      }
    }

    const event = {
      id: crypto.randomUUID(),
      source: "cell-steward",
      agent: `cell-steward:${who.did}`,
      kind: `cell_${kind}`,
      ts: now(),
      payload,
    };
    let relayed = false;
    if (relayOn) {
      try {
        const r = await fetchImpl(`${baseUrl}/ingest`, {
          method: "POST",
          headers: { authorization: `Bearer ${relayToken}`, "content-type": "application/json" },
          body: JSON.stringify({ events: [event] }),
          signal: AbortSignal.timeout(5000),
        });
        relayed = r.ok;
        if (!r.ok) console.warn(`[cell-report] ingest answered ${r.status} — dropping one ${kind} event`);
      } catch (e) {
        console.warn(`[cell-report] ingest relay failed (degrade-open, event dropped): ${e?.message || e}`);
      }
    }
    return res.status(202).json({ accepted: true, relayed });
  }

  return { handle, relayOn };
}
