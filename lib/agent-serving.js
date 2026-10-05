// ── Agent serving deploy library (openspec: add-a2a-agent-serving, D3/D4) ───
//
// Composes registry-native assets for a pack role that carries a serving
// contract and pushes them to the mcp-gateway-registry:
//   • each of the role's skills → a registry skill entry under
//     `packs/<packId>/<skill>` with group visibility (the registry is already
//     the skills distribution plane; the runner pulls content from there);
//   • the role → ONE registry agent entry (supported_protocol "a2a") whose
//     `metadata` carries only the small deployment descriptor — persona,
//     MCP references, skill paths, contract echo. The full manifest and skill
//     bodies never ride in the agent entry (design D3: no size blowups).
//
// The registered `url` is the runner backend; once the registry's A2A reverse
// proxy is enabled (ops precondition 1.5) the registry stores it as the proxy
// backend and advertises the gateway route instead.
//
// `fetchImpl(path, init)` receives registry-relative paths so tests can stub
// the wire without a server; the default impl prefixes REGISTRY_URL.

const EFFECTIVE_WITHIN_SECS = 300; // runner poll interval bound (design D4)

// ── Deployment secrets (add-deployment-secrets D1/D2/D6) ────────────────────
// The shape + display rules for deployer-provided, per-agent named secrets,
// shared by the two enforcement points the same way validateRhythm is: the
// deploy gate (gateway/packs.js validates and stores) and the runner's
// composition anchor (agent-runner/compose.js re-checks before pinning).
// Names are short lowercase identifiers — YAML-safe and namespaced away from
// the credentials file's uppercase provider refs (LLM_API_KEY, …).
export const SECRET_NAME_RE = /^[a-z0-9_]{1,32}$/;
export const SECRET_LIMITS = { perAgent: 4, valueBytes: 8 * 1024 };

// What a log line, audit record, or deploy surface may show for one secret
// (design D6): the reference's head plus the value's last four — but only
// when the value is long enough that four characters identify rather than
// disclose. The full value never appears outside the internal fetch route.
export function maskSecretRef(ref, value = "") {
  const head = String(ref ?? "ws_").slice(0, 8);
  const v = String(value ?? "");
  return v.length >= 8 ? `${head}…${v.slice(-4)}` : `${head}…`;
}

// The registry's A2A reverse proxy (1.30.0, #1734) maps /agent/{path}/** onto
// the registered URL's ORIGIN and drops its path — one agent per origin. A
// multi-tenant runner therefore serves each agent on its own port, assigned
// deterministically from the agent key so the deploy side (which registers
// the URL) and the runner (which binds the listener) agree without talking.
export function agentPortFor(agentKey, { base = 8791, span = 32 } = {}) {
  let h = 0;
  for (const ch of String(agentKey)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return base + (h % span);
}

function pick(fetchImpl, registryUrl, token) {
  if (fetchImpl) return fetchImpl;
  const base = String(registryUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("deployToRegistry: registryUrl (or fetchImpl) is required");
  return (path, init = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
}

async function registryCall(doFetch, method, path, body) {
  const res = await doFetch(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`registry ${method} ${path} failed (${res.status}): ${JSON.stringify(detail).slice(0, 400)}`), {
      status: 502,
    });
  }
  return res.json().catch(() => ({}));
}

// Upsert: PUT the canonical path; create via POST when it does not exist yet.
async function upsert(doFetch, putPath, postPath, payload) {
  const put = await doFetch(putPath, { method: "PUT", body: JSON.stringify(payload) });
  if (put.ok) return put.json().catch(() => ({}));
  if (put.status === 404) return registryCall(doFetch, "POST", postPath, payload);
  const detail = await put.json().catch(() => ({}));
  throw Object.assign(
    new Error(`registry PUT ${putPath} failed (${put.status}): ${JSON.stringify(detail).slice(0, 400)}`),
    { status: 502 },
  );
}

export function listServingAgents(manifest) {
  return (manifest?.agents ?? []).filter((a) => a?.serving !== undefined);
}

// The role's effective skill subset: its declaration, else the whole pack's.
function roleSkills(manifest, agent) {
  const declared = agent?.resources?.skills;
  if (Array.isArray(declared)) {
    const byName = new Map((manifest.skills ?? []).map((s) => [s.name, s]));
    return declared.map((name) => byName.get(name)).filter(Boolean);
  }
  return manifest.skills ?? [];
}

function roleMcp(manifest, agent) {
  const declared = agent?.resources?.mcpServers;
  if (Array.isArray(declared)) {
    const byName = new Map((manifest.mcpServers ?? []).map((m) => [m.registryName, m]));
    return declared.map((name) => byName.get(name)?.registryName ?? name);
  }
  return (manifest.mcpServers ?? []).map((m) => m.registryName);
}

// Compose the AgentCard fields for the registry entry: manual card fields
// override; absent fields derive from the role's display identity. v1 always
// streams (the adapter implements message/stream), so streaming is forced on.
export function composeAgentCard(manifest, agent) {
  const card = agent.serving?.card ?? {};
  const tags = [...new Set([...(manifest.tags ?? []), ...(agent.tags ?? [])])].slice(0, 10);
  return {
    name: card.name ?? agent.name,
    description: card.description ?? `${manifest.name} · ${manifest.description || agent.name}`,
    tags,
    capabilities: { streaming: true, ...(card.capabilities ?? {}) },
    skills: card.skills ?? [],
  };
}

// Named notification channels are administrator-bound rows (bot_channels); the
// deployer may only reference one. The rule is the channel admin route's own
// (server/routes/bots.js) — same shape definition, two enforcement points.
export const NOTIFY_CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// The small deployment descriptor the runner materializes from (metadata).
// `rhythmOverride` (add-agent-residency D7): the deployer's rhythm override —
// effective immediately, the manifest default ignored when present. `null`
// means "clear back to none", `undefined` means "no override given".
// `budgetOverride` (add-serving-budgets D2): the deployer's per-agent turn
// budget in minutes — the contract's declaration ignored when present; `null`
// means "clear back to the contract (else absent)", `undefined` means "no
// override given".
// `notifyChannel` (add-agent-notifications D2): the deployer's notification
// channel binding for this agent — a string binds, `null`/`undefined` leave
// the field absent (unbound / explicitly unbound; the deploy route resolves
// the omitted-means-keep semantics before calling here).
// `workspace` (facet-mcp-foundation-v1 3.1): the contract's data-workspace
// declaration — the runner materializes a private `<home>/data` volume for it
// (SQLite and other GB-scale durable data, separate from the state files) and
// exports AGENT_DATA_DIR (+ AGENT_DATA_QUOTA_MB when quotaMb is declared) to
// the child. Emitted only when enabled — absent keeps the legacy layout.
export function composeDescriptor({ packId, version, manifest, agent, skillPaths, rhythmOverride, budgetOverride, notifyChannel, billingKeyRef, secretRefs }) {
  const paths = skillPaths ?? roleSkills(manifest, agent).map((s) => `packs/${packId}/${s.name}`);
  const descriptor = {
    protocol: "a2a",
    packId,
    packVersion: version,
    agentId: agent.id,
    agentName: agent.name,
    persona: agent.persona,
    skills: paths,
    mcpServers: roleMcp(manifest, agent),
  };
  const rhythm = rhythmOverride !== undefined ? rhythmOverride : agent.serving?.rhythm;
  if (rhythm) descriptor.effective_rhythm = rhythm;
  // Notification binding: the channel NAME only — the destination lives in the
  // platform's admin-managed channel table, and the runner forwards addressed
  // to this name. Absent = the deployment can be asked to notify nobody yet.
  if (notifyChannel != null) descriptor.notify_channel = notifyChannel;
  // Effective turn budget: override → contract declaration → absent (the
  // runner's deployment default applies). The descriptor records the
  // effective value only — pure duration, never runtime configuration.
  const budget = budgetOverride != null ? budgetOverride : agent.serving?.budget?.turnMinutes;
  if (budget != null) descriptor.effective_budget_minutes = budget;
  // Billing key REFERENCE only (add-agent-platform-ops): the value lives in
  // the platform's store and reaches the runner over the authenticated
  // internal route — the registry never sees a secret.
  if (billingKeyRef != null) descriptor.billing_key_ref = billingKeyRef;
  // Deployment secrets (add-deployment-secrets D2): the same discipline —
  // per-name opaque references only, values stay platform-side.
  if (secretRefs != null && Object.keys(secretRefs).length > 0) descriptor.secret_refs = secretRefs;
  // Data workspace (facet-mcp-foundation-v1 3.1): the effective declaration
  // only — enabled is the sole trigger (the runner re-checks before it
  // materializes anything); a malformed quotaMb is dropped here rather than
  // propagated, so the registry never carries a half-valid bound.
  const workspace = agent.serving?.workspace;
  if (workspace?.enabled === true) {
    descriptor.workspace = { enabled: true };
    if (Number.isInteger(workspace.quotaMb) && workspace.quotaMb > 0) descriptor.workspace.quotaMb = workspace.quotaMb;
  }
  return descriptor;
}

// Pause/resume a deployed agent (add-agent-residency D5): the registry entry's
// metadata is the single source of truth — the runner polls it (the same ≤5min
// propagation plane as deploy) and answers callers with an explicit paused
// error. GET-merge-PUT so the write carries whatever else the entry holds;
// the registry has no partial-metadata endpoint in the versions we run.
export async function setAgentPaused({ registryUrl, token, fetchImpl, agentPath, paused }) {
  const doFetch = pick(fetchImpl, registryUrl, token);
  const res = await doFetch(`/api/agents${agentPath}`);
  if (!res.ok) {
    throw Object.assign(new Error(`registry GET ${agentPath} failed (${res.status})`), { status: 502 });
  }
  const entry = await res.json();
  if (!entry || typeof entry !== "object") {
    throw Object.assign(new Error(`registry entry ${agentPath} unreadable`), { status: 502 });
  }
  entry.metadata = { ...(entry.metadata ?? {}), paused: paused === true };
  if (!paused) delete entry.metadata.paused;
  await upsert(doFetch, `/api/agents${agentPath}`, "/api/agents/register", entry);
  return { agentPath, paused: paused === true };
}

// The notify_channel the live entry already carries, or null. This is what
// makes the deploy request's omitted case mean KEEP (add-agent-notifications
// D2, rhythms' 省略=保留): the descriptor is the binding's only store, so the
// carry-forward reads it back from the entry being replaced. 404 = no entry
// yet (fresh deploy → unbound); any other failure refuses the deploy — a
// binding silently dropped on an unrelated redeploy is the failure mode this
// read exists to prevent.
async function readExistingNotifyChannel(doFetch, agentPath) {
  const res = await doFetch(`/api/agents${agentPath}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error(`registry GET ${agentPath} failed (${res.status}): ${JSON.stringify(detail).slice(0, 200)}`),
      { status: 502 },
    );
  }
  const entry = await res.json().catch(() => null);
  const channel = entry?.metadata?.notify_channel;
  return typeof channel === "string" && channel ? channel : null;
}

export async function deployToRegistry({
  packId,
  version,
  manifest,
  runnerBaseUrl,
  packsPublicBase,
  registryUrl,
  token,
  fetchImpl,
  rhythmOverrides = {},
  budgetOverrides = {},
  notifyChannels = {},
  billingKeys = {},
  secretRefs = {},
  skillGroups = String(process.env.AGENT_SERVING_SKILL_GROUPS || "pack-deployers")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
}) {
  if (!manifest?.name || !packId || !Number.isInteger(Number(version))) {
    throw Object.assign(new Error("packId, version, and manifest are required"), { status: 400 });
  }
  if (!runnerBaseUrl) throw Object.assign(new Error("runnerBaseUrl is required (AGENT_SERVING_RUNNER_URL)"), { status: 500 });
  // The registry fetches skill_md_url ANONYMOUSLY at registration (live
  // finding 2026-09-30): pack skills need a publicly-readable raw-md URL,
  // served by the pack gateway's public route (gateway/packs.js). The same
  // body is synthesized WITH frontmatter there — the registry parses it for
  // metadata, the inline skill_md_content we also send is the storage truth.
  if (!packsPublicBase) throw Object.assign(new Error("packsPublicBase is required (AGENT_SERVING_PACKS_URL — the pack gateway's public origin)"), { status: 500 });

  const serving = listServingAgents(manifest);
  if (serving.length === 0) {
    const ids = (manifest.agents ?? []).map((a) => a?.id).filter(Boolean).join(", ") || "(no agents)";
    throw Object.assign(
      new Error(`no agent in this pack carries a serving contract — nothing to deploy (agents: ${ids})`),
      { status: 400 },
    );
  }

  const doFetch = pick(fetchImpl, registryUrl, token);
  const deployed = [];
  // The registry stores skills under a NAME-derived path (the pack-scoped
  // path we send is advisory — live finding 2026-09-30). The descriptor must
  // reference the ACTUAL stored path, which the upsert response carries.
  const actualSkillPath = new Map();

  for (const agent of serving) {
    for (const skill of roleSkills(manifest, agent)) {
      // Skills are keyed by NAME registry-wide (the pack-scoped path is
      // advisory): resolve the ACTUAL stored path by name first, so an
      // in-place upgrade PUTs the row it means to update instead of falling
      // through to POST and hitting the name conflict.
      let putPath = `/api/skills/packs/${packId}/${skill.name}`;
      try {
        const byName = await doFetch(`/api/skills/${encodeURIComponent(skill.name)}`);
        if (byName.ok) {
          const doc = await byName.json();
          // The stored path carries the /skills/ prefix; the API route adds
          // it — strip it, or the PUT targets /api/skills/skills/<name>.
          if (doc?.path) putPath = `/api/skills/${String(doc.path).replace(/^\/+skills\//, "")}`;
        }
      } catch { /* lookup miss → pack-path upsert below */ }
      const stored = await upsert(
        doFetch,
        putPath,
        "/api/skills",
        {
          path: `packs/${packId}/${skill.name}`,
          name: skill.name,
          description: skill.description,
          skill_md_url: `${String(packsPublicBase).replace(/\/+$/, "")}/api/packs/${packId}/versions/${version}/skills/${skill.name}.md`,
          skill_md_content: skill.content,
          visibility: "group",
          allowed_groups: skillGroups,
        },
      );
      actualSkillPath.set(skill.name, String(stored?.path ?? `packs/${packId}/${skill.name}`).replace(/^\/+skills\//, ""));
    }

    const path = `/packs/${packId}/${agent.id}`;
    const card = composeAgentCard(manifest, agent);
    // Notification binding (add-agent-notifications D2), deploy-request
    // three-state: an explicit channel binds, explicit null unbinds, and an
    // OMITTED agent keeps whatever the live entry already carries (read back
    // here, since the descriptor replaced by this deploy is its only store).
    const notifyChannel = Object.prototype.hasOwnProperty.call(notifyChannels, agent.id)
      ? notifyChannels[agent.id]
      : await readExistingNotifyChannel(doFetch, path);
    const descriptor = composeDescriptor({
      packId,
      version,
      manifest,
      agent,
      skillPaths: roleSkills(manifest, agent).map((s) => actualSkillPath.get(s.name) ?? `packs/${packId}/${s.name}`),
      rhythmOverride: Object.prototype.hasOwnProperty.call(rhythmOverrides, agent.id)
        ? rhythmOverrides[agent.id]
        : undefined,
      budgetOverride: Object.prototype.hasOwnProperty.call(budgetOverrides, agent.id)
        ? budgetOverrides[agent.id]
        : undefined,
      notifyChannel: notifyChannel ?? undefined,
      billingKeyRef: Object.prototype.hasOwnProperty.call(billingKeys, agent.id) ? billingKeys[agent.id] : undefined,
      secretRefs: Object.prototype.hasOwnProperty.call(secretRefs, agent.id) ? secretRefs[agent.id] : undefined,
    });
    const origin = new URL(runnerBaseUrl); // per-agent port (see agentPortFor)
    const payload = {
      path,
      name: card.name,
      description: card.description,
      url: `${origin.protocol}//${origin.hostname}:${agentPortFor(path)}`, // one agent per origin (registry #1734)
      version: String(version),
      provider: { organization: "paas-pack", url: registryUrl || undefined },
      capabilities: card.capabilities,
      streaming: true,
      skills: card.skills,
      tags: card.tags,
      supported_protocol: "a2a",
      default_input_modes: ["text"],
      default_output_modes: ["text"],
      preferred_transport: "jsonrpc",
      // Private packs deploy privately on the registry (openspec:
      // pack-visibility) — discovery hides them from everyone else.
      visibility: manifest.visibility === "private" ? "private" : "public",
      metadata: descriptor,
    };
    await upsert(doFetch, `/api/agents${path}`, "/api/agents/register", payload);
    // The registry's registration security scan FETCHES the backend card; the
    // runner hasn't polled the new entry yet, so the scan fails and DISABLES
    // the agent (live finding 2026-09-30) — the runner's list filter would
    // then never see it (chicken-and-egg). Re-enable right after the upsert:
    // the scan's disable lands during the register call, so this wins.
    try {
      await doFetch(`/api/agents${path}/toggle?enabled=true`, { method: "POST" });
    } catch { /* keep going — the ops flow can toggle manually */ }
    deployed.push({ agentId: agent.id, agentPath: path, skills: descriptor.skills, card });
  }

  return {
    deployed,
    agentPath: deployed[0]?.agentPath,
    skills: [...new Set([...actualSkillPath.values()])],
    effectiveWithinSecs: EFFECTIVE_WITHIN_SECS,
  };
}
