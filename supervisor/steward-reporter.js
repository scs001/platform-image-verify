// ── Steward uplink client (add-cell-lifecycle 4.3) ─────────────────────────
//
// presence/manifest reporting to the gateway's cell-report door. Contract:
//   explicit-off by default  — the reporter only exists once the user has
//     paired (pair file present = explicitly opted in, consent line ③ at
//     install time names payloads individually)
//   degrade-open             — platform unreachable ⇒ bounded ring buffer or
//     drop, never a stall, never a modal
//   401 self-destruct        — the console revoked this pairing: burn the
//     local identity (key+token+pair file) and go dark; a re-pair is a fresh
//     bind code, by design (see cell-lifecycle destroy protocol)

import fs from "node:fs";
import path from "node:path";
import { STEWARD_PROTOCOL_VERSION } from "../lib/cell-lifecycle.js";
import { readCronJobs, cellJobsFile } from "../lib/cell-lifecycle.js";
import { refreshStewardToken } from "./steward-identity.js";

const PAIR_FILE = "steward-pair.json";
const BUF_MAX = 100;

export function readPairFile(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, PAIR_FILE), "utf8")); } catch { return null; }
}

export function createStewardReporter({
  steward,
  dataDir,
  storage,
  appVersion = "0.0.0",
  tickMs = 60_000,
  fetchImpl = null,
  manifestFn = null,
}) {
  const pair = readPairFile(dataDir);
  const state = {
    token: pair?.token ?? null,
    deviceId: pair?.deviceId ?? null,
    gatewayUrl: pair?.gatewayUrl ?? null,
    email: pair?.email ?? null,
    buffer: [],
  };
  let timer = null;
  let running = false;
  const doFetch = fetchImpl ?? defaultFetch;

  async function defaultFetch(url, { method = "POST", headers = {}, body }) {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  function noteReport(ok) {
    const row = steward.registry.get(steward.cellId);
    if (row) steward.registry.put({ ...row, lastReportAt: ok ? Date.now() : row.lastReportAt ?? null });
  }

  async function postOnce(kind, payload) {
    if (!state.token) return { skipped: "no-token" };
    const res = await doFetch(`${state.gatewayUrl}/api/gateway/cell-report`, {
      headers: { authorization: `Bearer ${state.token}` },
      body: { kind, payload },
    });
    if (res.status === 401) {
      const refreshed = await refreshStewardToken({ gatewayUrl: state.gatewayUrl, deviceId: state.deviceId, storage }).catch(() => null);
      if (refreshed) {
        state.token = refreshed;
        fs.writeFileSync(path.join(dataDir, PAIR_FILE), JSON.stringify({ ...state, token: refreshed }, null, 2), { mode: 0o600 });
        const retry = await doFetch(`${state.gatewayUrl}/api/gateway/cell-report`, {
          headers: { authorization: `Bearer ${state.token}` },
          body: { kind, payload },
        });
        if (retry.status !== 401) return { accepted: retry.status === 202, retried: true };
      }
      // Second 401: pairing is dead — self-destruct (spec 5.1 channel ③).
      await selfDestruct();
      return { dead: true };
    }
    return { accepted: res.status === 202 };
  }

  async function selfDestruct() {
    console.warn("[steward-reporter] server revoked this pairing (401) — burning local identity and going dark");
    try { await storage.remove(); } catch { /* */ }
    try { fs.rmSync(path.join(dataDir, PAIR_FILE), { force: true }); } catch { /* */ }
    state.token = null;
    stopReporter_();
  }

  async function tick() {
    if (state.buffer.length > 0) {
      const head = state.buffer[0];
      const out = await postOnce(head.kind, head.payload);
      if (out.accepted || out.retried || out.dead) {
        if (!out.dead) state.buffer.shift();
        else state.buffer.length = 0;
      } else {
        // Platform down: keep shape, drop the oldest when at cap (degrade-open).
        noteReport(false);
        if (state.buffer.length >= BUF_MAX) state.buffer.shift();
        return;
      }
    }
    // manifestFn is synchronous by design (reads the cell's own stores); a
    // sync throw must reach tick's catch as a rejection, not a TypeError on
    // `.catch` of a plain value — the silent-dead-uplink bug (smoke-caught).
    let base = null;
    if (manifestFn) {
      try { base = await manifestFn(); } catch { base = null; }
    }
    if (!base) base = defaultManifest();
    const presence = { state: steward.running ? "running" : "suspended", os: process.platform, appVersion, protocolVersion: STEWARD_PROTOCOL_VERSION, at: Date.now() };
    await postOnce("presence", presence);
    const manifest = {
      fleetCount: base.fleetCount ?? 0,
      memberCount: base.memberCount ?? 0,
      enabledTaskCount: base.enabledTaskCount ?? 0,
      labels: base.labels ?? [],
      at: Date.now(),
    };
    const out = await postOnce("manifest", manifest);
    if (!out.accepted && !out.dead && !out.retried) {
      if (state.buffer.length < BUF_MAX) state.buffer.push({ kind: "manifest", payload: manifest });
      noteReport(false);
    } else {
      noteReport(true);
    }
  }

  function defaultManifest() {
    const jobs = readCronJobs(cellJobsFile(dataDir));
    return { enabledTaskCount: jobs.filter((j) => j?.cron && !j?.paused).length, fleetCount: 0, memberCount: 0, labels: [] };
  }

  function stopReporter_() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    enabled: Boolean(state.token),
    state,
    start() {
      if (running || !state.token) return;
      running = true;
      timer = setInterval(() => void tick().catch(() => {}), tickMs);
      timer.unref?.();
      void tick().catch(() => {});
    },
    stop: stopReporter_,
    tick,
    selfDestruct,
  };
}
