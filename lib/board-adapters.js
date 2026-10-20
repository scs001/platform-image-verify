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
  async fetchBlocks(ctx) {
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
  async fetchBlocks(ctx) {
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
 * Registry of adapters by line id.
 */
const ADAPTERS = new Map([
  ["facet", new FacetBoardAdapter({ id: "facet", title: "谦面", originUrl: "https://facet.finddatatech.cloud" })],
  ["wanxing", new WanxingBoardAdapter({ id: "wanxing", title: "萬星", originUrl: "https://wanxing.finddatatech.cloud" })],
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
