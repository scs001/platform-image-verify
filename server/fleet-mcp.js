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
import { deputyToolErrorText, decisionResolveErrorText } from "./fleet-mcp-hints.js";

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
      "Dispatch a self-contained task to ANOTHER post of YOUR cluster (集群派发, supervisor pattern). Async by construction: this returns immediately, the target post runs its turn, and the summary arrives in YOUR next turn — never wait. " +
      "Only pairs your cluster's orchestration allows (a declared dispatch edge, or supervisor mode). Refused: cross-cluster, self, array posts, depth>0 turns, over the per-post/per-cluster caps.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target post ref (memberId) within the same cluster." },
        brief: { type: "string", description: "Self-contained task brief (≤4000 chars) — the target may know nothing about this conversation." },
      },
      required: ["to", "brief"],
    },
  },
  {
    name: "decision_queue",
    description:
      "常务岗（决策代理）专用：读取本舰队 route=deputy 的待裁队列。每项带来源岗位、近期报数摘要与主人过往同类判例。" +
      "非本舰队常务岗调用会被服务端拒绝（403）。读之前先看 policy：它给出可委托的类别、严重度上限与今日裁决预算。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "decision_resolve",
    description:
      "常务岗裁决一条待裁项。kind=approve 需给 choice（必须是该项 options 里的 value）；kind=reject 需给 note。" +
      "必须附 evidence（依据：引用判例或说明理由，≤2000 字）。越出委托授权（类别/严重度/预算）时服务端拒绝并提示转主人。" +
      "amend（改批）是主人专属，这里不支持。",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Decision item id from decision_queue." },
        kind: { type: "string", enum: ["approve", "reject"] },
        choice: { type: "string", description: "Required for approve: one of the item's option values." },
        note: { type: "string", description: "Required for reject (the reason); optional note for approve." },
        evidence: { type: "string", description: "Your reasoning: which precedent or fact supports this ruling (≤2000 chars)." },
      },
      required: ["itemId", "kind", "evidence"],
    },
  },
  {
    name: "decision_escalate_to_owner",
    description:
      "常务岗判不了时向上升级：把该条目转回主人队列并附你的分析。强判比不判糟——" +
      "遇到超授权、事实不足、或需要主人偏好/价值观的问题，用这个而不是硬裁。",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Decision item id from decision_queue." },
        analysis: { type: "string", description: "What you found, why you can't rule, and what you recommend (≤2000 chars)." },
      },
      required: ["itemId", "analysis"],
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

// ── deputy bridge (add-deputy-decision-delegate) ─────────────────────────────
//
// 委托裁决的授权闸在服务端（/api/fleets/deputy/*）：这里只负责调用与把拒因
// 原样交回模型——"被服务端拒绝就转主人"是提示词里的行为要求，而权限本身由
// 服务端的逐项校验保证。

async function bridgePost(path, body) {
  const res = await fetch(`${bridgeOrigin()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function toolDecisionQueue() {
  const { ok, status, data } = await bridgePost("/api/fleets/deputy/queue", {});
  if (!ok) {
    const msg = data.error || `decision_queue failed (${status})`;
    return errOut(deputyToolErrorText(msg, status));
  }
  const q = data.queue ?? [];
  if (q.length === 0) {
    return textOut(
      `No deputy-routed items pending in fleet 「${data.fleet?.name ?? ""}」. ` +
        `Policy: delegable categories ${JSON.stringify(data.policy?.routes ?? {})}, ` +
        `max severity ${data.policy?.maxSeverity}, daily budget ${data.policy?.dailyBudget}.`,
    );
  }
  const lines = [
    `Deputy queue for fleet 「${data.fleet?.name ?? ""}」 — ${q.length} item(s).`,
    `Policy: max severity ${data.policy?.maxSeverity}; daily budget ${data.policy?.dailyBudget}; routes ${JSON.stringify(data.policy?.routes ?? {})}.`,
    "",
  ];
  for (const it of q) {
    lines.push(`### ${it.id}  [${it.severity}] ${it.category ?? "(uncategorised)"}${it.escalations ? ` · escalated ×${it.escalations}` : ""}`);
    lines.push(`Q: ${it.question}`);
    lines.push(`options: ${(it.options ?? []).map((o) => `${o.value}=${o.label}`).join(" | ")}`);
    if (it.member?.title) lines.push(`post: ${it.member.title}${it.member.status ? ` (${it.member.status})` : ""}`);
    if (it.recentReport) lines.push(`latest report: ${it.recentReport}`);
    if (it.precedents?.length) {
      for (const p of it.precedents) {
        lines.push(
          `precedent ${p.id}: "${String(p.question).slice(0, 80)}" → owner ${
            p.resolution?.kind === "reject" ? "rejected" : `approved ${p.resolution?.choice ?? ""}`
          }${p.resolution?.note ? ` (note: ${String(p.resolution.note).slice(0, 80)})` : ""}`,
        );
      }
    }
    lines.push("");
  }
  lines.push(
    "Rule what the mandate covers (cite a precedent in `evidence`); escalate to the owner what it doesn't. " +
      "A server refusal is the mandate talking — escalate rather than retry.",
  );
  return textOut(lines.join("\n"));
}

async function toolDecisionResolve({ itemId, kind, choice, note, evidence }) {
  const { ok, status, data } = await bridgePost("/api/fleets/deputy/resolve", {
    itemId,
    kind,
    choice,
    note,
    evidence,
  });
  if (!ok) {
    const msg = data.error || `decision_resolve failed (${status})`;
    return errOut(decisionResolveErrorText(msg, status));
  }
  const d = data.decision ?? {};
  const label = d.options?.find((o) => o.value === d.resolution?.choice)?.label ?? d.resolution?.choice ?? "";
  return textOut(
    `Ruled ${d.id}: ${d.state}${label ? ` — ${label}` : ""}. ` +
      `Delivery rides the post's next turn (or the owner's execute-now). ` +
      `Record what you did and why in memory so the owner can audit it later.`,
  );
}

async function toolDecisionEscalateToOwner({ itemId, analysis }) {
  const { ok, status, data } = await bridgePost("/api/fleets/deputy/escalate-to-owner", { itemId, analysis });
  if (!ok) {
    const msg = data.error || `decision_escalate_to_owner failed (${status})`;
    return errOut(deputyToolErrorText(msg, status));
  }
  return textOut(
    `Escalated ${itemId} to the owner with your analysis. It now counts in the owner's queue. ` +
      `Write a one-line entry to memory (what you found + why you couldn't rule) so the owner sees it there too.`,
  );
}

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
      case "decision_queue": return await toolDecisionQueue();
      case "decision_resolve": return await toolDecisionResolve(args);
      case "decision_escalate_to_owner": return await toolDecisionEscalateToOwner(args);
      default: return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
