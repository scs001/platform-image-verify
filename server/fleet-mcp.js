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
  {
    name: "escalate",
    description:
      "Submit a decision request to the fleet owner (拍板). Use it when a choice exceeds your post's authority or budget: which option to take, whether to spend, " +
      "whether to stop. The owner approves/rejects/amends from the fleet decision queue; the result is delivered into your next turn (or immediately on execute-now). " +
      "suggestedDeadline is display-only — actual expiry follows the fleet's policy. Limits: per-post daily cap and a fleet-wide open queue cap.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The decision being asked (≤500 chars). Write it so the owner can decide without more context." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          description: "2–6 choices: [{value, label}]. `value` is the machine token, `label` the human text.",
          items: {
            type: "object",
            properties: {
              value: { type: "string" },
              label: { type: "string" },
            },
            required: ["value", "label"],
          },
        },
        severity: { type: "string", enum: ["low", "normal", "high"], description: "How urgently the owner should decide." },
        suggestedDeadline: { type: "string", description: "Human-readable suggestion only (e.g. '48 小时内'). Never triggers expiry." },
        recommendation: { type: "string", description: "The option value you recommend, if any." },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "dispatch_post",
    description:
      "Dispatch a self-contained task to ANOTHER post of YOUR fleet (舰队派发, supervisor pattern). Async by construction: this returns immediately, the target post runs its turn, and the summary arrives in YOUR next turn — never wait. " +
      "Only pairs your fleet's orchestration allows (a declared dispatch edge, or supervisor mode). Refused: cross-fleet, self, cluster posts, depth>0 turns, over the per-post/per-fleet caps.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target post ref (memberId) within the same fleet." },
        brief: { type: "string", description: "Self-contained task brief (≤4000 chars) — the target may know nothing about this conversation." },
      },
      required: ["to", "brief"],
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

async function toolEscalate({ question, options, severity, suggestedDeadline, recommendation }) {
  const res = await fetch(`${bridgeOrigin()}/api/fleets/escalate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, options, severity, suggestedDeadline, recommendation }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return errOut(data.error || `escalate failed (${res.status})`);
  return textOut(
    [
      `Decision request queued for the owner of fleet 「${data.fleetName ?? ""}」 from post 「${data.memberTitle}」.`,
      `- queue position: ${data.queuePosition}`,
      `- daily escalations left for this post: ${data.dailyRemaining}`,
      `Tell the user a decision is pending; the owner decides from the fleet queue and the result arrives in your next turn.`,
    ].join("\n"),
  );
}

const server = new Server({ name: "fleet", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

async function toolDispatch({ to, brief }) {
  const res = await fetch(`${bridgeOrigin()}/api/fleets/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, brief }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return errOut(data.error || `dispatch failed (${res.status})`);
  return textOut(
    `Dispatched to post 「${data.to.title}」 (${data.to.kind}).\n` +
      `- task id: ${data.taskId}\n` +
      `- async: the target's summary arrives in YOUR next turn — finish this turn normally.`,
  );
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "report_status": return await toolReport(args);
      case "escalate": return await toolEscalate(args);
      case "dispatch_post": return await toolDispatch(args);
      default: return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
