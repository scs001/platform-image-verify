// ── Fleet machines store (add-unified-fleet-console) ────────────────────────
//
// Platform-level state for the unified machine console, one JSON file at the
// gateway / single-process data root — the SAME convention as mp-bindings.json
// (atomic temp+rename, serialized mutations): platform state must exist ahead
// of any cell and cannot live in a cell's SQL store (hosted topology: each
// cell owns its database; the gateway process never reaches into it).
//
// Per paired steward device (keyed by deviceId, the steward token's `did`):
//   lastSeenAt        latest presence/manifest/detail arrival (roster liveness
//                     is derived from THIS, never from the sister-repo ingest)
//   presence          latest presence payload (whitelisted shape)
//   detail            latest cell_detail snapshot (whitelisted shape, per-device
//                     overwrite) + divergenceStreak recomputed on each write
//   desired           { version, entries } — the cloud-authored deployment
//                     expectation this machine pulls; version increments on
//                     every edit so the machine can tell "changed" from "same"
//
// Divergence counts ONLY cloud-desired entries missing from the machine's
// detail — manual local entries diverging from the desired set is the
// local-manual-wins design working as intended, never an alarm.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createFleetMachinesStore({ file, now = Date.now }) {
  let machines = {}; // deviceId -> row

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      machines = raw.machines ?? {};
    } catch {
      // Missing or unreadable file: start empty (first boot, or corrupt file).
      machines = {};
    }
  }

  let flushing = Promise.resolve();
  function persist() {
    flushing = flushing.then(async () => {
      const raw = { machines };
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(raw, null, 2));
      await rename(tmp, file);
    });
    return flushing;
  }

  function get(deviceId) {
    return machines[String(deviceId)] ?? null;
  }

  // Every steward door arrival lands here: liveness is a side effect of
  // reporting, never a separate probe.
  function touch(deviceId, { ownerEmail, presence = null }) {
    const key = String(deviceId);
    const row = machines[key] ?? { ownerEmail: null, lastSeenAt: null, presence: null, detail: null, divergenceStreak: 0, desired: null };
    if (ownerEmail) row.ownerEmail = ownerEmail;
    row.lastSeenAt = now();
    if (presence) row.presence = presence;
    machines[key] = row;
    return row;
  }

  function recomputeDivergence(row) {
    const desired = row.desired;
    const detail = row.detail;
    if (!desired || !Array.isArray(desired.entries) || desired.entries.length === 0) return 0;
    if (!detail || !Array.isArray(detail.deployments)) return 0;
    const liveKeys = new Set(
      detail.deployments.filter((d) => d?.enabled).map((d) => `${d.packId}/${d.agentId}`),
    );
    const missing = desired.entries.filter(
      (e) => e?.enabled !== false && !liveKeys.has(`${e.packId}/${e.agentId}`),
    );
    return missing.length === 0 ? 0 : (row.divergenceStreak ?? 0) + 1;
  }

  function recordDetail(deviceId, detail) {
    const key = String(deviceId);
    const row = machines[key];
    if (!row) return null;
    row.detail = detail;
    row.divergenceStreak = recomputeDivergence(row);
    machines[key] = row;
    return row;
  }

  // The cloud-authored expectation is the ONE piece of this store that cannot
  // self-heal: liveness and detail both arrive again on the next steward beat,
  // but a desired set only exists because a human edited it. Losing it to a
  // gateway restart (hosted pods roll constantly) silently reverts every
  // machine to "no expectation" and the next merge deletes its cloud rows —
  // so these two mutations write through. Callers that must answer only after
  // durability await `flush`.
  function recordDesired(deviceId, entries, { ownerEmail = null } = {}) {
    const key = String(deviceId);
    const row = machines[key] ?? { ownerEmail: null, lastSeenAt: null, presence: null, detail: null, divergenceStreak: 0, desired: null };
    if (ownerEmail) row.ownerEmail = ownerEmail;
    const prev = row.desired?.version ?? 0;
    row.desired = { version: prev + 1, entries, at: now() };
    machines[key] = row;
    void persist();
    return row;
  }

  function clearDesired(deviceId) {
    const row = machines[String(deviceId)];
    if (!row) return null;
    row.desired = null;
    row.divergenceStreak = 0;
    machines[String(deviceId)] = row;
    void persist();
    return row;
  }

  function list() {
    return Object.entries(machines).map(([deviceId, row]) => ({ deviceId, ...row }));
  }

  return {
    load,
    get: (deviceId) => get(deviceId),
    touch,
    recordDetail,
    recordDesired,
    clearDesired,
    list,
    get flush() {
      return flushing;
    },
    persist,
  };
}
