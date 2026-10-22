// ── cell memory mount (add-memory-federation-v1) ─────────────────────────────
//
// The cell-side federation client: when CELL_MEMORY_ENABLED=1 and both the
// platform token and fleet URL are configured, every profile write appends the
// fd-memory MCP row to the mcp patch and a discipline line to the persona.
// The person token is minted per owner on first touch and cached on disk under
// the cell data root — one mint per user, restart-stable.
//
// Fail-open by contract: any failure (mint, URL missing, disk) leaves the
// composition byte-identical to the memory-off baseline.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
// Single-source discipline text (fix-memory-capture-p0 D6): the same string
// the fleet runner injects, imported from the repo root so the two surfaces
// can never drift (bilingual zh + en by decision).
import { MEMORY_DISCIPLINE } from "./memory-discipline.js";

export { MEMORY_DISCIPLINE };

export function cellMemoryConfig(env = process.env) {
  const enabled = env.CELL_MEMORY_ENABLED === "1";
  const url = String(env.CELL_MEMORY_URL || "").replace(/\/+$/, "");
  const platformToken = String(env.CELL_MEMORY_PLATFORM_TOKEN || "");
  const dataRoot = String(env.CELL_MEMORY_DATA || "");
  return enabled && url && platformToken && dataRoot ? { url, platformToken, dataRoot } : null;
}

function cachePath(dataRoot, ownerEmail) {
  const safe = String(ownerEmail || "unknown").replace(/[^a-zA-Z0-9@._-]/g, "_");
  return join(dataRoot, "cell-memory-tokens", `${safe}.json`);
}

export async function personTokenFor(cfg, ownerEmail, fetchImpl = fetch) {
  const p = cachePath(cfg.dataRoot, ownerEmail);
  try {
    const cached = JSON.parse(readFileSync(p, "utf8"));
    if (cached?.token && cached?.namespace === `u/${ownerEmail}`) return cached.token;
  } catch { /* miss → mint */ }
  const res = await fetchImpl(`${cfg.url}/admin/mint`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.platformToken}` },
    body: JSON.stringify({ namespace: `u/${ownerEmail}`, label: `cell:${ownerEmail}` }),
  });
  if (!res.ok) throw new Error(`person mint HTTP ${res.status}`);
  const { token } = await res.json();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ token, namespace: `u/${ownerEmail}`, mintedAt: new Date().toISOString() }), { mode: 0o600 });
  return token;
}

// The dsh-mcp-client loader row (http branch), verbatim mcpEntry shape.
export function memoryMcpEntry(url, token) {
  return {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url: `${url}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}

// Compose helper: returns { mcpEntry, discipline } or null (fail-open).
export async function cellMemoryMount(env, ownerEmail, fetchImpl = fetch) {
  const cfg = cellMemoryConfig(env);
  if (!cfg || !ownerEmail) return null;
  try {
    const token = await personTokenFor(cfg, ownerEmail, fetchImpl);
    return { mcpEntry: memoryMcpEntry(cfg.url, token), discipline: MEMORY_DISCIPLINE };
  } catch (e) {
    console.warn(`[cell-memory] mount skipped (fail-open): ${e?.message || e}`);
    return null;
  }
}
