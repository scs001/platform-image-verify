// ── Full-mode tool scope (full-mode-tool-scope B1/B2) ────────────────────────
//
// The tool face full mode composes from the installed packs. Pure: the caller
// hands in the durable `installed_packs` snapshots at every composition, so a
// pack install/upgrade/uninstall re-derives automatically and nothing is
// persisted as a materialized allowlist.
//
// Safety valve (B2): an UNDECLARED reference (legacy pack), an empty
// declaration, or an explicit `fullSurface` marker contributes the server's
// WHOLE surface — the server is absent from the returned map, which is exactly
// "no filter for it". A server no pack references is absent too. The result is
// null when nothing is narrowed, which keeps the pre-change composition
// byte-identical.

const FULL = Symbol("full-surface");

export function deriveFullModeToolScope(installedPacks, fullSurfaceServers = []) {
  const byServer = new Map();
  for (const pack of Array.isArray(installedPacks) ? installedPacks : []) {
    for (const ref of pack?.manifest?.mcpServers ?? []) {
      const server = ref?.registryName;
      if (typeof server !== "string" || !server) continue;
      const declared = Array.isArray(ref.allowTools)
        ? ref.allowTools.filter((t) => typeof t === "string" && t)
        : [];
      if (ref.fullSurface === true || declared.length === 0) {
        byServer.set(server, FULL);
        continue;
      }
      if (byServer.get(server) === FULL) continue;
      const set = byServer.get(server) ?? new Set();
      for (const tool of declared) set.add(tool);
      byServer.set(server, set);
    }
  }
  for (const server of Array.isArray(fullSurfaceServers) ? fullSurfaceServers : []) {
    if (typeof server === "string" && server) byServer.set(server, FULL);
  }
  const out = {};
  for (const [server, value] of byServer) {
    // FULL and an (unreachable) empty set both mean "no filter": never emit
    // `{server: []}`, which would hide the server's entire tool surface.
    if (value === FULL || value.size === 0) continue;
    out[server] = [...value];
  }
  return Object.keys(out).length > 0 ? out : null;
}

// A custom preset's focused face (B4/D4): a declared per-server list narrows
// to exactly those names; an absent one inherits the full-mode union for that
// server; a server nobody narrows stays absent (= full surface). The user's
// override removes the server regardless — the marker outranks every mode.
export function customPresetToolScope(mcpServers, declaredTools, fullModeUnion, fullSurfaceServers = []) {
  const overridden = new Set(Array.isArray(fullSurfaceServers) ? fullSurfaceServers : []);
  const out = {};
  for (const server of Array.isArray(mcpServers) ? mcpServers : []) {
    if (typeof server !== "string" || !server || overridden.has(server)) continue;
    const declared = Array.isArray(declaredTools?.[server])
      ? [...new Set(declaredTools[server].filter((t) => typeof t === "string" && t))]
      : [];
    if (declared.length > 0) {
      out[server] = declared;
    } else if (Array.isArray(fullModeUnion?.[server]) && fullModeUnion[server].length > 0) {
      out[server] = [...fullModeUnion[server]];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
