#!/usr/bin/env node
// ── Dual-read window comparator (add-supply-store-unification 3.4) ───────────
//
// Single-execution body for the 24h dual-read window (scheduled run): pull the
// spine read-only projection AND the legacy registry API in full, align rows by
// primary key, and diff every field (tool_list / metadata deep-compared).
// Drift means a registration edit landed on exactly one side of the window.
//
//   SUPPLY_STORE_BASE=https://… SUPPLY_STORE_PROJECTION_TOKEN=… \
//   REGISTRY_URL=https://mcp… MARKET_REGISTRY_TOKEN=… \
//   node scripts/supply-store-dual-read.mjs
//
// Exit codes: 0 = no drift, 1 = drift, 2 = usage/connection error.
//
// Comparison contract, with the two asymmetries DECLARED (never silent):
//   · SPINE_ONLY_FIELDS — created_at / updated_at / updated_by are stamped by
//     the spine write gate and do not exist on the legacy side. Skipped.
//   · REGISTRY_UNAVAILABLE_FIELDS — `groups`: the registry list API cannot
//     carry group metadata (bridge header comment; the migration injects it
//     from registry-groups.json). Skipped, printed once per run. If a future
//     registry build starts returning it, remove the field from this set.
//   · is_enabled: spine rows carry the SQLite INTEGER (1/0), registry rows a
//     JSON boolean — normalized to boolean on both sides before comparing.
//   · Registry-side fields outside the spine contract (health_status, status,
//     mcp_endpoint, registered_at, … — registry runtime state, not
//     registration rows) are listed once as informational, not drift.
//   · Shape-gap guard: a contract field absent (undefined) on 100% of registry
//     rows is excluded from per-row drift and reported once as a shape gap
//     (suspected API shape deviation to verify), so a structural read gap
//     cannot cry wolf over the whole 24h window. A field present on some rows
//     still compares normally; null (explicit) is a value, not absence.

import { isDeepStrictEqual } from "node:util";

import {
  RegistryReadError,
  fetchAllRegistryPages,
  registryToken,
  resolveRegistryBase,
  skillEntryName,
} from "./lib/supply-registry-read.mjs";

class UsageError extends Error {}
class ConnectionError extends Error {}

// Declared skip sets (see header). Extending/changing them is a deliberate,
// reviewed decision — that is why they are constants and not flags.
const SPINE_ONLY_FIELDS = ["created_at", "updated_at", "updated_by"];
const REGISTRY_UNAVAILABLE_FIELDS = ["groups"];

const MCP_FIELDS = [
  "id", "display_name", "description", "proxy_pass_url", "num_tools", "tool_list",
  "tags", "license", "provider_organization", "deployment", "metadata",
  "visibility", "groups", "is_enabled",
];
const SKILL_FIELDS = [
  "name", "display_name", "description", "repository_url", "author", "version",
  "tags", "license", "metadata", "visibility", "groups", "is_enabled",
];

// Registry row → spine-shaped row (field names aligned; the mapping is the
// migration's, kept 1:1 — see supply-store-migrate.mjs for the derivations).
// mcp_endpoint / sse_endpoint ride the same promotion the migrator applies:
// document top level on the registry side, inside metadata on the spine side
// (compare them where they land, never skip — they are the consumer-facing
// endpoint truth, standardize-mcp-public-endpoints).
function normalizeRegistryMcp(row) {
  const promoted = {};
  if (typeof row.mcp_endpoint === "string" && row.mcp_endpoint) promoted.mcp_endpoint = row.mcp_endpoint;
  if (typeof row.sse_endpoint === "string" && row.sse_endpoint) promoted.sse_endpoint = row.sse_endpoint;
  return {
    id: typeof row.path === "string" && row.path ? row.path : (typeof row._id === "string" ? row._id : null),
    display_name: row.display_name,
    description: row.description,
    proxy_pass_url: row.proxy_pass_url,
    num_tools: row.num_tools,
    tool_list: row.tool_list,
    tags: row.tags,
    license: row.license,
    provider_organization: row.provider_organization,
    deployment: row.deployment,
    metadata: Object.keys(promoted).length > 0 ? { ...promoted, ...(row.metadata ?? {}) } : row.metadata,
    visibility: row.visibility,
    groups: undefined, // REGISTRY_UNAVAILABLE_FIELDS — never carries a value here
    is_enabled: row.is_enabled,
    __raw: row,
  };
}

function normalizeRegistrySkill(row) {
  return {
    name: skillEntryName(row) || null,
    display_name: row.name, // registry skill `name` is the display name
    description: row.description,
    repository_url: row.repository_url,
    author: row.author,
    version: row.version,
    tags: row.tags,
    license: row.license,
    metadata: row.metadata,
    visibility: row.visibility,
    groups: undefined, // REGISTRY_UNAVAILABLE_FIELDS
    is_enabled: row.is_enabled,
    __raw: row,
  };
}

function normEnabled(v) {
  return v === 1 || v === true;
}

function normValue(v) {
  return v === undefined ? null : v;
}

function valuesDiffer(field, a, b) {
  if (field === "is_enabled") return normEnabled(a) !== normEnabled(b);
  return !isDeepStrictEqual(normValue(a), normValue(b));
}

function show(v) {
  return JSON.stringify(v === undefined ? null : v);
}

async function pullProjection({ base, token, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${base}/api/supply-store/projection`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new ConnectionError(`spine projection ${base} unreachable: ${err.message}`);
  }
  if (!res.ok) {
    let code = null;
    try { code = JSON.parse(await res.text())?.code ?? null; } catch { /* non-JSON body */ }
    throw new ConnectionError(`spine projection HTTP ${res.status}${code ? ` ${code}` : ""}`);
  }
  return res.json();
}

async function run() {
  const fetchImpl = globalThis.fetch;
  const registryBase = resolveRegistryBase();
  const registryTok = registryToken();
  const spineBase = (process.env.SUPPLY_STORE_BASE || "").trim().replace(/\/+$/, "");
  if (!spineBase) throw new UsageError("SUPPLY_STORE_BASE is required (spine gateway base)");
  const projectionToken = (process.env.SUPPLY_STORE_PROJECTION_TOKEN || "").trim();
  if (!projectionToken) throw new UsageError("SUPPLY_STORE_PROJECTION_TOKEN is required");

  const projection = await pullProjection({ base: spineBase, token: projectionToken, fetchImpl });
  const [serversRead, skillsRead] = await Promise.all([
    fetchAllRegistryPages({ fetchImpl, base: registryBase, token: registryTok, path: "/api/servers" }),
    fetchAllRegistryPages({ fetchImpl, base: registryBase, token: registryTok, path: "/api/skills" }),
  ]);

  const lines = [];
  lines.push(
    `[supply-store-dual-read] spine=${spineBase} registry=${registryBase} ` +
      `projection asOf=${projection.asOf ?? "?"} ` +
      `(spine: mcp ${(projection.mcpServers ?? []).length}/skills ${(projection.skills ?? []).length}; registry: mcp ${serversRead.items.length}/skills ${skillsRead.items.length})`,
  );

  const compareSpecies = ({ label, spineRows, registryRows, spineKeyOf, fields }) => {
    const normRegistry = registryRows.map((row) => (label === "skills" ? normalizeRegistrySkill(row) : normalizeRegistryMcp(row)));

    // Compare candidates: the spine contract field list plus anything the
    // spine rows actually carry (a newly added spine column enters the diff
    // visibly instead of being silently ignored), minus the two DECLARED skip
    // sets. Shape gaps: candidates the registry side never carries at all.
    const candidateFields = new Set(fields);
    for (const r of spineRows) {
      for (const k of Object.keys(r)) candidateFields.add(k);
    }
    const skipped = new Set([...SPINE_ONLY_FIELDS, ...REGISTRY_UNAVAILABLE_FIELDS]);
    const shapeGaps = [];
    for (const f of candidateFields) {
      if (skipped.has(f)) continue;
      const carried = normRegistry.some((r) => r[f] !== undefined);
      if (normRegistry.length > 0 && !carried) shapeGaps.push(f);
    }
    const compareFields = [...candidateFields].filter((f) => !skipped.has(f) && !shapeGaps.includes(f));

    const registryByKey = new Map();
    for (const r of normRegistry) {
      const key = spineKeyOf(r);
      if (key != null && !registryByKey.has(key)) registryByKey.set(key, r);
    }
    const spineKeys = new Set(spineRows.map(spineKeyOf));
    const registryKeys = new Set([...registryByKey.keys()]);

    const drift = [];
    for (const key of spineKeys) {
      if (!registryKeys.has(key)) {
        drift.push({ key, field: null, spine: "(row present)", registry: "(absent)" });
      }
    }
    for (const key of registryKeys) {
      if (!spineKeys.has(key)) {
        drift.push({ key, field: null, spine: "(absent)", registry: "(row present)" });
      }
    }
    for (const [key, reg] of registryByKey) {
      if (!spineKeys.has(key)) continue;
      const spineRow = spineRows.find((r) => spineKeyOf(r) === key);
      for (const f of compareFields) {
        if (valuesDiffer(f, spineRow[f], reg[f])) {
          drift.push({ key, field: f, spine: spineRow[f], registry: reg[f] });
        }
      }
    }

    // Registry-side fields outside the spine contract: informational only.
    const extraFields = new Map();
    for (const r of normRegistry) {
      for (const k of Object.keys(r.__raw ?? {})) {
        if (!fields.includes(k) && k !== "path" && k !== "_id" && k !== "name") {
          extraFields.set(k, (extraFields.get(k) ?? 0) + 1);
        }
      }
    }

    lines.push(`── ${label} (${spineRows.length} spine / ${registryByKey.size} registry aligned) ──`);
    for (const d of drift) {
      lines.push(
        d.field
          ? `  DRIFT ${label} ${d.key} ${d.field}: spine=${show(d.spine)} registry=${show(d.registry)}`
          : `  DRIFT ${label} ${d.key}: spine=${d.spine} / registry=${d.registry}`,
      );
    }
    if (REGISTRY_UNAVAILABLE_FIELDS.filter((f) => fields.includes(f)).length > 0) {
      lines.push(`  skipped (declared): ${REGISTRY_UNAVAILABLE_FIELDS.join(", ")} — registry list API cannot carry group metadata (registry-groups.json provenance)`);
    }
    if (shapeGaps.length > 0) {
      lines.push(`  shape-gap (not drift; verify registry API shape): ${shapeGaps.join(", ")} — absent on all ${normRegistry.length} registry rows`);
    }
    if (extraFields.size > 0) {
      lines.push(
        `  registry-side fields outside the spine contract (informational): ` +
          [...extraFields.entries()].map(([f, n]) => `${f} ×${n}`).join(", "),
      );
    }
    return drift;
  };

  const drift = [
    ...compareSpecies({
      label: "mcp_servers",
      spineRows: projection.mcpServers ?? [],
      registryRows: serversRead.items,
      spineKeyOf: (r) => r.id,
      fields: MCP_FIELDS,
    }),
    ...compareSpecies({
      label: "skills",
      spineRows: projection.skills ?? [],
      registryRows: skillsRead.items,
      spineKeyOf: (r) => r.name,
      fields: SKILL_FIELDS,
    }),
  ];

  if (drift.length === 0) {
    lines.push(`dual-read: ${(projection.mcpServers ?? []).length + (projection.skills ?? []).length} spine rows compared, 0 drift`);
  } else {
    lines.push(`dual-read: ${drift.length} drift line(s) — investigate which side of the window moved`);
  }
  console.log(lines.join("\n"));
  return drift.length === 0 ? 0 : 1;
}

try {
  process.exit(await run());
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`[supply-store-dual-read] usage: ${err.message}`);
    process.exit(2);
  }
  if (err instanceof RegistryReadError || err instanceof ConnectionError) {
    console.error(`[supply-store-dual-read] connection: ${err.message}`);
    process.exit(2);
  }
  console.error(`[supply-store-dual-read] fatal: ${err?.stack ?? err}`);
  process.exit(2);
}
