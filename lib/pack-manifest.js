// ── Pack manifest content model (openspec: add-pack-marketplace) ─────────────
//
// The single definition of what a pack manifest may contain, shared by the
// two places that must enforce the same rules: the gateway's publish endpoint
// (creators gate + validation before anything is stored) and the cell's
// install endpoint (defense in depth — the manifest arrives via the browser
// per design D8, so the cell re-validates before materializing).
//
// The v1 content boundary lives here: MCP entries are registry-name
// references only (no endpoints or commands — a pack can never introduce a
// server the operator has not registered), and agent entries are persona-only
// (no baseUrl/model/credentials — pack agents run as local personas on the
// subscriber's runtime).

// Design D11 defaults; callers may override via env for ops/testing.
export const PACK_LIMITS = {
  maxSkills: 10,
  maxSkillBodyChars: 64 * 1024,
  maxAgents: 3,
  maxMcpRefs: 5,
  maxTags: 10,
  maxTagChars: 24,
  maxNameChars: 80,
  maxDescriptionChars: 2000,
  maxPersonaChars: 16 * 1024,
};

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Keys a pack MCP entry must NOT carry — anything endpoint- or command-shaped
// would break the v1 security boundary.
const MCP_FORBIDDEN_KEYS = ["url", "command", "args", "env", "headers", "config", "configTemplate"];

// Keys a pack agent entry must NOT carry — pack agents are local personas,
// never a forwarded endpoint.
const AGENT_FORBIDDEN_KEYS = ["baseUrl", "model", "apiKey", "apiKeyEnv", "local", "url"];

function fail(errors, error, entry) {
  errors.push(entry ? { error, entry } : { error });
}

// Validate a pack manifest. Returns an array of { error, entry? } — empty
// means valid. `entry` names the offending item so the editor can point at it.
export function validatePackManifest(manifest, limits = PACK_LIMITS) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ error: "manifest must be an object" }];
  }

  const name = manifest.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > limits.maxNameChars) {
    fail(errors, `name must be a non-empty string of at most ${limits.maxNameChars} characters`);
  }

  if (manifest.description != null && (typeof manifest.description !== "string" || manifest.description.length > limits.maxDescriptionChars)) {
    fail(errors, `description must be a string of at most ${limits.maxDescriptionChars} characters`);
  }

  const tags = manifest.tags ?? [];
  if (!Array.isArray(tags) || tags.length > limits.maxTags) {
    fail(errors, `tags must be an array of at most ${limits.maxTags} strings`);
  } else {
    tags.forEach((t, i) => {
      if (typeof t !== "string" || !t.trim() || t.trim().length > limits.maxTagChars) {
        fail(errors, `tag ${i + 1} must be a non-empty string of at most ${limits.maxTagChars} characters`, `tags[${i}]`);
      }
    });
  }

  const skills = manifest.skills ?? [];
  if (!Array.isArray(skills) || skills.length > limits.maxSkills) {
    fail(errors, `skills must be an array of at most ${limits.maxSkills} entries`);
  } else {
    const seen = new Set();
    skills.forEach((s, i) => {
      const entry = `skills[${i}]`;
      if (!s || typeof s !== "object") {
        fail(errors, "skill entry must be an object", entry);
        return;
      }
      if (typeof s.name !== "string" || !NAME_RE.test(s.name)) {
        fail(errors, "skill name must match [A-Za-z0-9._-], 1-64 chars", entry);
      } else if (seen.has(s.name)) {
        fail(errors, `duplicate skill name '${s.name}'`, entry);
      } else {
        seen.add(s.name);
      }
      if (typeof s.description !== "string" || !s.description.trim() || s.description.length > 300) {
        fail(errors, "skill description must be a non-empty string of at most 300 characters", entry);
      }
      if (typeof s.content !== "string" || !s.content.trim() || s.content.length > limits.maxSkillBodyChars) {
        fail(errors, `skill content must be a non-empty string of at most ${limits.maxSkillBodyChars} characters`, entry);
      }
    });
  }

  const mcpServers = manifest.mcpServers ?? [];
  if (!Array.isArray(mcpServers) || mcpServers.length > limits.maxMcpRefs) {
    fail(errors, `mcpServers must be an array of at most ${limits.maxMcpRefs} entries`);
  } else {
    mcpServers.forEach((m, i) => {
      const entry = `mcpServers[${i}]`;
      if (!m || typeof m !== "object") {
        fail(errors, "MCP entry must be an object", entry);
        return;
      }
      const forbidden = MCP_FORBIDDEN_KEYS.filter((k) => m[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `MCP entries may only reference registry servers (found forbidden key(s): ${forbidden.join(", ")})`, entry);
        return;
      }
      if (typeof m.registryName !== "string" || !NAME_RE.test(m.registryName)) {
        fail(errors, "MCP entry needs a registryName matching [A-Za-z0-9._-], 1-64 chars", entry);
      }
      if (m.requiredGroup != null && (typeof m.requiredGroup !== "string" || !m.requiredGroup.trim() || m.requiredGroup.length > 64)) {
        fail(errors, "MCP entry requiredGroup must be a non-empty string of at most 64 characters", entry);
      }
    });
  }

  const agents = manifest.agents ?? [];
  if (!Array.isArray(agents) || agents.length > limits.maxAgents) {
    fail(errors, `agents must be an array of at most ${limits.maxAgents} entries`);
  } else {
    const seen = new Set();
    agents.forEach((a, i) => {
      const entry = `agents[${i}]`;
      if (!a || typeof a !== "object") {
        fail(errors, "agent entry must be an object", entry);
        return;
      }
      const forbidden = AGENT_FORBIDDEN_KEYS.filter((k) => a[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `agent entries are persona-only (found forbidden key(s): ${forbidden.join(", ")})`, entry);
        return;
      }
      if (typeof a.id !== "string" || !NAME_RE.test(a.id)) {
        fail(errors, "agent id must match [A-Za-z0-9._-], 1-64 chars", entry);
      } else if (seen.has(a.id)) {
        fail(errors, `duplicate agent id '${a.id}'`, entry);
      } else {
        seen.add(a.id);
      }
      if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 60) {
        fail(errors, "agent name must be a non-empty string of at most 60 characters", entry);
      }
      if (typeof a.persona !== "string" || !a.persona.trim() || a.persona.length > limits.maxPersonaChars) {
        fail(errors, `agent persona must be a non-empty string of at most ${limits.maxPersonaChars} characters`, entry);
      }
    });
  }

  const partCount = (Array.isArray(skills) ? skills.length : 0)
    + (Array.isArray(mcpServers) ? mcpServers.length : 0)
    + (Array.isArray(agents) ? agents.length : 0);
  if (partCount === 0) fail(errors, "a pack must contain at least one skill, MCP reference, or agent");

  return errors;
}
