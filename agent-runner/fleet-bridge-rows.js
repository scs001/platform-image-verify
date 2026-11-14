// ── The bridge's MCP row shape, with no dependencies ─────────────────────────
//
// Lives in its own module so BOTH consumers can import it without dragging the
// satellite host (and the MCP SDK behind it) into every `manager.js` import:
// the composer builds rows through this, and `fleet-bridge.js` starts the host
// those rows point at. One shape, one place — a second inlined copy is how the
// row and the endpoint drift apart silently.
//
// Deliberately carries NO identity: one patch serves every home in the pack, so
// an env-borne member id here would sign other members' work. Identity arrives
// per turn as `turn_token`.
//
// The bridge mount base + the runner's bearer ride in `headers`, not in the
// satellite's env: `fleet`/`fleet-architect` are SHARED satellites (one child
// per cell serves every runtime), and a secret in that child's env is readable
// by every member's process — `scripts/test-mcp-satellite-sharing.mjs` fails on
// exactly that shape. Headers are per-request, which is also the shape the
// identity channel already uses.
//
// `failOnStartupError: false` matches `mcpEntry()` in compose.js on purpose:
// visibility does NOT come from making composition fail (that would turn a
// crash of one loopback host into every home refusing to start). It comes from
// the boot-time probe + `<homeRoot>/.fleet-bridge-status.json`, plus the child
// returning the door's 401/503 verbatim at call time.

export const FLEET_BRIDGE_SERVERS = Object.freeze(["fleet", "fleet-architect"]);

export function fleetBridgeMcpRows(origin, { token = "" } = {}) {
  if (!origin) return [];
  return FLEET_BRIDGE_SERVERS.map((serverName) => ({
    id: `mcp-${serverName}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName,
      failOnStartupError: false,
      transport: "streamable-http",
      url: `${origin}/${serverName}/mcp`,
      headers: {
        // The host turns these into the reserved `__fleetBridge` argument per
        // request; the child never reads a secret from its own environment.
        "x-fleet-bridge-base": String(origin).replace(/\/+$/, ""),
        ...(token ? { "x-fleet-bridge-token": token } : {}),
      },
    },
  }));
}
