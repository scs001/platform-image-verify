// ── Actions MCP server (add-line-boards-and-action-gate, task 6.1) ───────────
//
// Exposes the propose_action tool to dsh agents. It is a thin client over the
// /api/actions/propose loopback REST bridge. The child only names an action;
// everything a proposal needs — the user's email, preflight checks, risk tier —
// lives HERE in host configuration.
//
// The tool returns {proposalId, state:"pending", impact, risk, target, tier}.
// The model can then render a confirmation card; the user's approve/reject
// decisions are NOT part of this channel — they ride WS messages back to the
// cell and resolve through routes/actions.js.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

console.log = (...args) => console.error(...args);

function bridgeOrigin() {
  if (process.env.ACTIONS_MCP_URL) return process.env.ACTIONS_MCP_URL.replace(/\/$/, "");
  const raw = process.env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${process.env.PORT || 3000}`;
}

async function call(method, path, body) {
  const res = await fetch(`${bridgeOrigin()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

const TOOLS = [
  {
    name: "propose_action",
    description:
      "Propose an action that requires human confirmation before execution. " +
      "The proposal enters a pending state with a unique ID; the caller should " +
      "render a confirmation card showing the impact and risk tier. Approval " +
      "and rejection happen outside this channel via WebSocket messages.",
    inputSchema: {
      type: "object",
      required: ["actionId", "args"],
      properties: {
        actionId: {
          type: "string",
          description: "Registered action id (e.g., 'facet.pack.publish', 'wanxing.agent.deploy')",
        },
        args: {
          type: "object",
          description: "Action-specific arguments (opaque to the MCP layer)",
        },
      },
    },
  },
];

export async function createServer() {
  const server = new Server({ name: "actions-mcp", version: "0.1.0" }, { capabilities: {} });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "propose_action") {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }

    try {
      const { actionId, args: actionArgs } = args || {};
      if (!actionId || !actionArgs) {
        return { content: [{ type: "text", text: "actionId and args required" }], isError: true };
      }

      const result = await call("POST", "/api/actions/propose", { actionId, args: actionArgs });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              proposalId: result.proposalId,
              state: result.state,
              impact: result.impact,
              risk: result.risk,
              target: result.target,
              tier: result.tier,
            }),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: err.message || "propose_action failed" }], isError: true };
    }
  });

  return server;
}

async function run() {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((err) => {
  console.error("[actions-mcp] fatal:", err.message);
  process.exit(1);
});
