// ── Runner-side fleet bridge (add-fleet-bridge-endpoint-for-agent-runner 2.1) ─
//
// Why this exists: a fleet post running on an agent-runner pod could not reach
// its own fleet tools at all. Measured 2026-11-14 on the live runner: 19
// `mcp.patch.yml`, ZERO containing `fleet`; the cell's satellites listen on
// 127.0.0.1 only, and the platform bridge's trust is "loopback AND no
// x-forwarded-email" — a runner pod is neither. The row was not missing by
// accident, there was nothing for it to point at.
//
// What this module starts: ONE satellite host per runner pod (the same
// `createMcpSatelliteHost` the cell uses) serving the fleet MCP children at
// `/<name>/mcp`. Homes get plain streamable-http rows pointing at that loopback
// origin, which keeps `mcpEntry()` and the patch format unchanged.
//
// Identity deliberately does NOT live here. The runner hosts many homes per pod
// with one shared patch, so a member id in the child's env would make every
// home in the pack report as that member (that is a signature on someone else's
// work, not a weaker identity). The per-turn `turn_token` the platform writes
// into the round's prompt is the channel, and it is carrier-independent.
//
// Failure visibility (design 1.3): `failOnStartupError: false` turns "the row
// is there but the endpoint is dead" into "the tool is simply absent", which is
// indistinguishable from a pack that never declared it. So this module refuses
// to hand back a URL it could not prove: it probes the platform route first and
// records the outcome at `<homeRoot>/.fleet-bridge-status.json` — a fact
// something can fail on, instead of a log line nobody reads.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpSatelliteHost } from "../server/mcp-satellite-host.js";
import { FLEET_BRIDGE_SERVERS, fleetBridgeMcpRows } from "./fleet-bridge-rows.js";

export { fleetBridgeMcpRows };

export const FLEET_BRIDGE_STATUS_FILE = ".fleet-bridge-status.json";

// The satellites a runner-hosted post needs: the report/decision lane, plus the
// read-only architect face (fleet_list). Draft/apply are NOT mounted on the
// runner side, so the child's write verbs cannot be used even if the model asks.
export const RUNNER_FLEET_SATELLITES = FLEET_BRIDGE_SERVERS;

const SCRIPT_FOR = {
  fleet: "fleet-mcp.js",
  "fleet-architect": "fleet-architect-mcp.js",
};

export function fleetBridgeStatusPath(homeRoot) {
  return path.join(homeRoot, FLEET_BRIDGE_STATUS_FILE);
}

/** Record the outcome where a judge can read it. Never throws: status I/O must
 * not be able to take the runner down. */
export function recordFleetBridgeStatus(homeRoot, status, log = console) {
  try {
    writeFileSync(fleetBridgeStatusPath(homeRoot), `${JSON.stringify(status, null, 2)}\n`);
  } catch (err) {
    log.warn?.(`[agent-runner:fleet-bridge] status write failed: ${err?.message || err}`);
  }
  const how = status.state === "ok" ? "ready" : status.state;
  log.log?.(`[agent-runner:fleet-bridge] ${how}: ${status.reason ?? status.origin ?? ""}`);
  return status;
}

/**
 * Probe the runner-facing platform route with the SAME bearer the child will
 * use. A probe that only checked reachability would pass while the token is
 * wrong — which is exactly the failure that looks like "tools are missing".
 */
export async function probeRunnerFleetBridge({ url, token, fetchImpl = fetch, timeoutMs = 8_000 }) {
  const res = await fetchImpl(`${url}/api/runner-fleet/architect/fleets`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}${body?.error ? ` ${body.error}` : ""}`);
  }
  return true;
}

/**
 * Start the per-pod fleet bridge. Returns `{ origin, host, status }` where
 * `origin` is null unless the probe AND the host both succeeded — callers add
 * MCP rows only when `origin` is non-null.
 */
export async function startRunnerFleetBridge({
  url,
  token,
  homeRoot,
  log = console,
  fetchImpl = fetch,
  satellites = RUNNER_FLEET_SATELLITES,
} = {}) {
  const at = new Date().toISOString();
  const base = { url: url ?? null, at };
  if (!url || !token) {
    return {
      origin: null,
      host: null,
      status: recordFleetBridgeStatus(
        homeRoot,
        { ...base, state: "off", reason: "AGENT_RUNNER_FLEET_BRIDGE_URL/TOKEN not set" },
        log,
      ),
    };
  }
  try {
    await probeRunnerFleetBridge({ url, token, fetchImpl });
  } catch (err) {
    return {
      origin: null,
      host: null,
      status: recordFleetBridgeStatus(
        homeRoot,
        { ...base, state: "missing", reason: `probe failed: ${err?.message || err}` },
        log,
      ),
    };
  }
  const env = {
    ...process.env,
    FLEET_ARCHITECT_MCP_URL: String(url).replace(/\/+$/, ""),
    FLEET_MCP_BRIDGE_PREFIX: "/api/runner-fleet",
    FLEET_MCP_BRIDGE_TOKEN: token,
  };
  const specs = satellites
    .filter((name) => SCRIPT_FOR[name])
    .map((name) => ({
      name,
      // Same discipline as the cell wiring: pin our own binary, never PATH.
      command: process.execPath,
      args: [fileURLToPath(new URL(`../server/${SCRIPT_FOR[name]}`, import.meta.url))],
      env,
    }));
  const host = createMcpSatelliteHost({ satellites: specs, port: 0, logger: log });
  try {
    await host.start();
  } catch (err) {
    await host.stop().catch(() => {});
    return {
      origin: null,
      host: null,
      status: recordFleetBridgeStatus(
        homeRoot,
        { ...base, state: "missing", reason: `satellite host failed to start: ${err?.message || err}` },
        log,
      ),
    };
  }
  const origin = `http://127.0.0.1:${host.port}`;
  return {
    origin,
    // The rows carry this as a header (see fleet-bridge-rows.js); the child
    // reads it from the request, never from its env.
    token,
    host,
    status: recordFleetBridgeStatus(homeRoot, { ...base, state: "ok", origin }, log),
  };
}
