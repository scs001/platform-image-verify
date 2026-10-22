// ── Fleet MCP server (stdio) ─────────────────────────────────────────────────
//
// Exposes the fleet report tool to the dsh agent as `report_status` — declared
// in mcp.json as the `fleet` server and mounted through dsh-mcp-client as
// mcp__fleet__report_status, available to every persona preset. Like the cron
// MCP child it is a thin client: attribution, slot alignment, flood control
// and storage all live in the platform server process, reached over the
// /api/fleets/report loopback bridge (loopback is its credential — server/
// auth.js). The tool cannot name a post: the server resolves the post from
// the current turn's execution context, so one agent can only ever report
// for the post it is actually running as.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// The stdio channel IS the protocol: stdout must carry JSON-RPC and nothing
// else.
console.log = (...args) => console.error(...args);

function bridgeOrigin() {
  if (process.env.FLEET_MCP_URL) return process.env.FLEET_MCP_URL.replace(/\/$/, "");
  const raw = process.env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${process.env.PORT || 3000}`;
}

const TOOLS = [
  {
    name: "report_status",
    description:
      "File this post's status report (for fleet members only — 报数). Call it at the end of a patrol/task turn, or whenever your numbers changed materially. " +
      "Metrics are keyed by YOUR POST's declared KPI slot keys (unknown keys are kept in the report details but do not reach the card). " +
      "`summary` is required. `delta` on a metric is your own annotation only — the system computes trends itself. " +
      "Rate limit: 3 reports per window (half your cadence period, 10 minutes minimum).",
    inputSchema: {
      type: "object",
      properties: {
        metrics: {
          type: "object",
          description:
            "Slot-keyed values: { <slotKey>: { value: string|number, delta?: string } }. Use the slot keys declared for your post.",
          additionalProperties: {
            type: "object",
            properties: {
              value: { type: ["string", "number"], description: "The slot's current value." },
              delta: { type: "string", description: "Optional self-annotation (display-only note)." },
            },
            required: ["value"],
          },
        },
        resources: {
          type: "array",
          description: "Managed resources this post owns (name/kind/url).",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string", description: "e.g. shop / repo / account / module" },
              url: { type: "string" },
            },
          },
        },
        blockers: {
          type: "array",
          description: "Things blocking this post right now (short strings).",
          items: { type: "string" },
        },
        summary: { type: "string", description: "Required human-readable summary of this report." },
      },
      required: ["summary"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function toolReport({ metrics, resources, blockers, summary }) {
  const res = await fetch(`${bridgeOrigin()}/api/fleets/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ metrics, resources, blockers, summary }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return errOut(data.error || `report failed (${res.status})`);

  const lines = [
    `Report filed for post 「${data.memberTitle}」 (fleet 「${data.fleetName}」).`,
    `- slots accepted: ${data.slotsAccepted.length ? data.slotsAccepted.join(", ") : "(none)"}`,
  ];
  if (data.slotsUnrecognized?.length) {
    lines.push(
      `- UNRECOGNIZED slot keys (kept in details, not shown on the card — re-check your post's declared slots): ${data.slotsUnrecognized.join(", ")}`,
    );
  }
  lines.push(`- window resets at: ${new Date(data.windowResetsAt).toISOString()}`);
  return textOut(lines.join("\n"));
}

const server = new Server({ name: "fleet", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "report_status": return await toolReport(args);
      default: return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
