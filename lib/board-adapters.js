// ── Board adapters (add-line-boards-and-action-gate, task 8) ────────────────
//
// Interface for line boards: each board is a set of blocks that render the
// state of a product line. Data comes from server-side REST calls (no model).
// Each block can fail independently without breaking the whole page.
//
// Block types: metrics (single value), list (rows), timeline (events).
//
// Usage: GET /api/boards/:line returns { blocks: [...] } where each block
// has { id, type, title, data?, error? }.

import * as lineCredentials from "../line-credentials.js";
import { connectPathForRef } from "../credential-refs.js";

// Deployment switch for every board surface (add-wire-line-board D8). Default
// OFF: the sister change's migration plan promised this lever; the server
// route, /api/config projection and the web entry points all read it.
export function lineBoardsEnabled(env = process.env) {
  return env.LINE_BOARDS_ENABLED === "1";
}

// Kill switch for the copilot dock (add-line-boards-and-action-gate task 8.3).
// Default ON — the dock shipped before the lever existed, so the lever must
// not hide it on deployments that never set the variable; "0" is the only
// value that turns it off. Read per request like the boards switch.
export function copilotEnabled(env = process.env) {
  return env.COPILOT_ENABLED !== "0";
}

/**
 * Board adapter interface. Implementations return an array of blocks.
 */
export class BoardAdapter {
  constructor({ id, title, originUrl }) {
    this.id = id;
    this.title = title;
    this.originUrl = originUrl;
  }

  /**
   * Fetch all blocks for this board. Returns { blocks: [...] } or throws.
   * Each block may have an error field if it failed to load.
   */
  async fetchBlocks(_ctx) {
    throw new Error("Not implemented");
  }
}

/**
 * Facet board adapter (task 8.1).
 * Blocks organized by tab:
 *   - overview: metrics + recent_events
 *   - my-packs: list of user's published packs with actions
 *   - publish-history: timeline of version events
 */
export class FacetBoardAdapter extends BoardAdapter {
  async fetchBlocks(ctx) {
    const email = ctx?.email || null;
    if (!email) {
      return {
        blocks: [
          { id: "status", type: "metrics", title: "连接状态", data: { connected: false }, error: "未连接" },
        ],
      };
    }

    // TODO: implement real REST calls to facet-market API
    // For now, return placeholder data that matches the spec shape
    return {
      blocks: [
        {
          id: "overview_metrics",
          type: "metrics",
          title: "概览",
          data: { weeklyActivePacks: 0, totalInstalls: 0 },
        },
        {
          id: "my_packs",
          type: "list",
          title: "我的包",
          data: [], // TODO: fetch from /api/mypacks
          actions: [
            { id: "facet.pack.publish", label: "发布新包", args: {} },
            { id: "facet.pack.visibility", label: "管理可见性", args: {} },
          ],
        },
        {
          id: "recent_events",
          type: "timeline",
          title: "最近事件",
          data: [],
        },
        {
          id: "publish_history",
          type: "timeline",
          title: "发布记录",
          data: [],
        },
      ],
    };
  }
}

/**
 * Wanxing board adapter (task 9).
 * Blocks organized by tab:
 *   - fleet-summary: deployment count, active agents, recent turns/cost
 *   - missions: mission list with status/cost/progress
 *   - deployments: agent deployment list
 */
export class WanxingBoardAdapter extends BoardAdapter {
  async fetchBlocks(_ctx) {
    // TODO: implement real REST calls to wanxing facade
    return {
      blocks: [
        {
          id: "fleet_summary_metrics",
          type: "metrics",
          title: "舰队概况",
          data: { deployments: 0, activeAgents: 0, recentTurns: 0 },
        },
        {
          id: "missions",
          type: "list",
          title: "任务",
          data: [],
        },
        {
          id: "deployments",
          type: "list",
          title: "部署",
          data: [],
          actions: [
            { id: "wanxing.agent.deploy", label: "部署新 agent", args: {} },
            { id: "wanxing.agent.pause", label: "暂停 agent", args: {} },
          ],
        },
      ],
    };
  }
}

/**
 * Wire (柏讯) board adapter (add-wire-line-board, design D1) — the first
 * adapter that reads real upstream data.
 *
 * Connection truth is the user's wire-customer ID token (liveToken), not the
 * presence of an email. Every block is fetched from the customer-facing REST
 * with that bearer; blocks fail independently. A 401 from any block means the
 * token is dead: the credential cache is cleared (the browser re-mints on the
 * next visit), the remaining requests are aborted, and the whole board reports
 * "not connected / re-authorize" — never a stale-key "paste again" prompt.
 *
 * Blocks (ids carry the tab name the page filters on):
 *   overview_metrics   datasets / artifacts / demands counts (+ free-tier quota)
 *   datasets_list      GET /api/v1/datasets
 *   artifacts_list     GET /api/v1/artifacts   (row actions: publish / archive)
 *   demands_timeline   GET /api/v1/demands     (newest first)
 */
export const WIRE_ORIGIN = "https://wire.finddatatech.cloud";
export const WIRE_LINE_CREDENTIAL = lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF;

class UpstreamError extends Error {
  constructor(status, path, detail) {
    super(`wire ${path} → HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.path = path;
  }
}

export class WireBoardAdapter extends BoardAdapter {
  constructor({ id = "wire", title = "柏讯", originUrl = WIRE_ORIGIN, apiBase = null, deps = {} } = {}) {
    super({ id, title, originUrl });
    this.apiBase = String(apiBase || process.env.WIRE_API_BASE_URL || originUrl).replace(/\/+$/, "");
    this.deps = {
      fetch: (...a) => globalThis.fetch(...a),
      liveToken: lineCredentials.liveToken,
      markInvalid: lineCredentials.markInvalid,
      timeoutMs: 20_000,
      ...deps,
    };
  }

  consoleUrl(section) {
    return `${this.originUrl}/#/console/${section}`;
  }

  unconnected(reason) {
    const expired = reason === "expired";
    return {
      connected: false,
      reason,
      connectPath: connectPathForRef(WIRE_LINE_CREDENTIAL),
      blocks: [
        {
          id: "connection",
          type: "metrics",
          title: "连接状态",
          data: { connected: false },
          error: expired ? "柏讯登录已过期：重新进入连接页即可重新授权" : "未连接柏讯：请先在设置 → 连接中授权",
        },
      ],
    };
  }

  async fetchBlocks(ctx) {
    const email = String(ctx?.email || "").trim();
    const token = this.deps.liveToken(email, WIRE_LINE_CREDENTIAL);
    if (!token) return this.unconnected("not_connected");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    const get = async (path) => {
      let res;
      try {
        res = await this.deps.fetch(`${this.apiBase}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new UpstreamError(0, path, "aborted");
        throw new UpstreamError(0, path, err?.message || "unreachable");
      }
      if (res.status === 401) {
        // Token rejected upstream: nothing else on this board can succeed.
        controller.abort();
        throw new UpstreamError(401, path);
      }
      if (!res.ok) throw new UpstreamError(res.status, path, await safeText(res));
      return res.json();
    };

    const [datasets, artifacts, demands, quota] = await Promise.allSettled([
      get("/api/v1/datasets"),
      get("/api/v1/artifacts"),
      get("/api/v1/demands"),
      get("/api/v1/datasets/quota"),
    ]);
    clearTimeout(timer);

    if ([datasets, artifacts, demands, quota].some((r) => r.status === "rejected" && r.reason?.status === 401)) {
      this.deps.markInvalid(email, WIRE_LINE_CREDENTIAL);
      return this.unconnected("expired");
    }

    const rows = (r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : null);
    const dsRows = rows(datasets);
    const artRows = rows(artifacts);
    const dmRows = rows(demands);
    const quotaVal = quota.status === "fulfilled" && quota.value && typeof quota.value === "object" ? quota.value : null;

    const blocks = [];

    // Overview: counts from whatever list succeeded; name the ones that failed.
    const missing = [
      dsRows === null ? "数据集" : null,
      artRows === null ? "产物" : null,
      dmRows === null ? "需求单" : null,
    ].filter(Boolean);
    if (missing.length === 3) {
      blocks.push({ id: "overview_metrics", type: "metrics", title: "概览", error: blockError(datasets) });
    } else {
      const data = {};
      if (dsRows) data["数据集"] = dsRows.length;
      if (artRows) data["产物"] = artRows.length;
      if (dmRows) data["需求单"] = dmRows.length;
      if (quotaVal && quotaVal.max_datasets !== null && quotaVal.max_datasets !== undefined) {
        data["免费档配额"] = `${quotaVal.used_datasets ?? 0}/${quotaVal.max_datasets}`;
      }
      blocks.push({
        id: "overview_metrics",
        type: "metrics",
        title: "概览",
        data,
        href: this.consoleUrl("datasets"),
        ...(missing.length ? { partial: missing } : {}),
      });
    }

    blocks.push(
      dsRows
        ? {
            id: "datasets_list",
            type: "list",
            title: "我的数据",
            href: this.consoleUrl("datasets"),
            data: dsRows.map((d) => ({
              id: d.id,
              title: d.name ?? d.key ?? String(d.id),
              subtitle: [d.source_name || d.source_kind, d.connector_id ? `connector ${d.connector_id}` : null].filter(Boolean).join(" · "),
              badges: [d.storage_tier === "api" ? "免费档" : "引擎", `${d.row_count ?? 0} 行`],
              href: this.consoleUrl("datasets"),
            })),
            actions: [{ id: "wire.dataset.create", label: "新建数据集", args: {} }],
          }
        : { id: "datasets_list", type: "list", title: "我的数据", error: blockError(datasets), href: this.consoleUrl("datasets") },
    );

    blocks.push(
      artRows
        ? {
            id: "artifacts_list",
            type: "list",
            title: "产物",
            href: this.consoleUrl("artifacts"),
            data: artRows.map((a) => ({
              id: a.id,
              title: a.title ?? `#${a.id}`,
              subtitle: a.kind ?? "",
              badges: [a.status ?? "", `v${a.version ?? 1}`].filter(Boolean),
              href: this.consoleUrl("artifacts"),
              rowActions: artifactRowActions(a),
            })),
          }
        : { id: "artifacts_list", type: "list", title: "产物", error: blockError(artifacts), href: this.consoleUrl("artifacts") },
    );

    blocks.push(
      dmRows
        ? {
            id: "demands_timeline",
            type: "timeline",
            title: "需求单",
            href: this.consoleUrl("demands"),
            data: [...dmRows]
              .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
              .map((d) => ({
                id: d.id,
                code: d.code,
                status: d.status,
                text: `${d.code ?? `#${d.id}`} · ${d.status ?? ""} · ${d.title ?? d.intent ?? ""}`,
                created_at: d.created_at,
                href: this.consoleUrl("demands"),
              })),
            // A demand needs a title/intent the board cannot invent; the
            // compliance fields are user-typed at confirmation (userFilledArgs).
            links: [{ label: "去柏讯新建需求单", href: this.consoleUrl("demands/new") }],
          }
        : { id: "demands_timeline", type: "timeline", title: "需求单", error: blockError(demands), href: this.consoleUrl("demands") },
    );

    return { connected: true, blocks };
  }
}

function artifactRowActions(a) {
  const id = a?.id;
  if (id === undefined || id === null) return [];
  const status = String(a.status ?? "");
  const out = [];
  if (status === "draft") out.push({ id: "wire.artifact.publish", label: "发布", args: { artifact_id: id } });
  if (status !== "archived") out.push({ id: "wire.artifact.archive", label: "归档", args: { artifact_id: id } });
  return out;
}

function blockError(settled) {
  if (settled.status !== "rejected") return "上游返回了非列表数据";
  const r = settled.reason;
  if (r instanceof UpstreamError) {
    if (r.status === 0) return "柏讯服务不可达";
    return `柏讯返回 HTTP ${r.status}`;
  }
  return r?.message || "加载失败";
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * Registry of adapters by line id.
 */
const ADAPTERS = new Map([
  ["facet", new FacetBoardAdapter({ id: "facet", title: "谦面", originUrl: "https://facet.finddatatech.cloud" })],
  ["wanxing", new WanxingBoardAdapter({ id: "wanxing", title: "萬星", originUrl: "https://wanxing.finddatatech.cloud" })],
  ["wire", new WireBoardAdapter()],
]);

/**
 * Get an adapter by line id.
 */
export function getBoardAdapter(line) {
  return ADAPTERS.get(line) ?? null;
}

/**
 * List all available lines.
 */
export function listBoardLines() {
  return Array.from(ADAPTERS.keys());
}
