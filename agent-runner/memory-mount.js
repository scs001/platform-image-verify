// Mount-row builders for the fleet memory MCP server (add-fleet-memory-v1):
// one dsh-mcp-client loader row (verbatim mcpEntry http branch) and one ACP
// SDK wire row (headers as an ARRAY of {name,value} — see acpMcpServers).
// Pure builders on purpose: testable without a manager or a network.

// The memory coordinate of one member entry (add-memory-scopes-and-cluster-
// sharing): metadata.agentId is THE coordinate — the display name is not (a
// rename must not change the namespace); the name stays as a fallback for
// descriptors minted before agentId rode the registry metadata.
export function memoryNamespaceFor(entry) {
  const packId = entry?.metadata?.packId;
  const agentId = entry?.metadata?.agentId ?? entry?.name;
  if (!packId || !agentId) return null;
  return `d/${packId}/${agentId}`;
}

// The pack-shared namespace a pod token mounts (2 segments — fd-memory mints
// the pod family from this shape).
export function podMemoryNamespace(packId) {
  return packId ? `d/${packId}` : null;
}

export function dshMemoryMount(url, token) {
  return {
    id: "mcp-fd-memory",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "fd-memory",
      failOnStartupError: false,
      transport: "streamable-http",
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  };
}

export function acpMemoryMount(url, token) {
  return {
    type: "http",
    name: "fd-memory",
    url,
    headers: token ? [{ name: "Authorization", value: `Bearer ${token}` }] : [],
  };
}
