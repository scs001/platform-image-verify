// Mount-row builders for the fleet memory MCP server (add-fleet-memory-v1):
// one dsh-mcp-client loader row (verbatim mcpEntry http branch) and one ACP
// SDK wire row (headers as an ARRAY of {name,value} — see acpMcpServers).
// Pure builders on purpose: testable without a manager or a network.

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
