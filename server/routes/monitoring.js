// Cluster monitoring (agent-cluster-platform).
//
// Honest-surface rewrite 2026-10-21: this file previously also served
// /api/monitoring/providers (hardcoded fabricated provider metrics) and
// /api/monitoring/tasks (constant zeros); the provider endpoint is deleted
// (no real data source exists behind it) and /tasks now reads the live task
// engine. Every number served here is computed from real state.

import { getClusterDatabase } from "./clusters-db.js";
import * as engine from "../../task-engine.js";

const clusterDb = getClusterDatabase();

export function createMonitoringRoutes(app) {
  // GET /api/monitoring/clusters - cluster metrics from clusters.db
  app.get("/api/monitoring/clusters", (_req, res) => {
    try {
      const clusters = clusterDb.listAll().map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        status: cluster.status,
        agentCount: cluster.agents.length,
        totalExecutions: cluster.totalExecutions,
        totalTokensUsed: cluster.totalTokensUsed,
        tokensPerExecution:
          cluster.totalExecutions > 0
            ? Math.floor(cluster.totalTokensUsed / cluster.totalExecutions)
            : 0,
        lastUsedAt: cluster.lastUsedAt,
        createdAt: cluster.createdAt,
      }));

      const totalExecutions = clusters.reduce((sum, c) => sum + c.totalExecutions, 0);
      const totalTokens = clusters.reduce((sum, c) => sum + c.totalTokensUsed, 0);

      res.json({
        summary: {
          totalClusters: clusters.length,
          activeClusters: clusters.filter((c) => c.status === "ready").length,
          totalExecutions,
          totalTokens,
          averageTokensPerExecution: totalExecutions > 0 ? Math.floor(totalTokens / totalExecutions) : 0,
        },
        clusters: clusters.sort((a, b) => b.lastUsedAt - a.lastUsedAt),
      });
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // GET /api/monitoring/tasks - task metrics from the live task engine
  // (cluster tasks included; clusterName/agentCount ride the client shape).
  app.get("/api/monitoring/tasks", (_req, res) => {
    try {
      const tasks = engine.listTasks();
      const byState = (pred) => tasks.filter(pred).length;
      res.json({
        summary: {
          totalTasks: tasks.length,
          activeTasks: byState((t) => t.state === "running" || t.state === "queued"),
          clusterTasks: byState((t) => t.target?.type === "cluster" || t.clusterId != null),
          pausedTasks: byState((t) => t.paused),
        },
        tasks: tasks.slice(0, 50).map((t) => ({
          id: t.id,
          type: t.type,
          status: t.status,
          state: t.state,
          paused: t.paused,
          clusterId: t.clusterId ?? null,
          clusterName: t.clusterName ?? null,
          agentCount: t.agentCount ?? null,
          lastRun: t.lastRun,
          nextRun: t.nextRun,
        })),
      });
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // GET /api/monitoring/health - process + cluster-store health
  app.get("/api/monitoring/health", (_req, res) => {
    try {
      res.json({
        status: "healthy",
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: {
          used: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100 + "MB",
          total: Math.round((process.memoryUsage().heapTotal / 1024 / 1024) * 100) / 100 + "MB",
        },
        clusters: {
          total: clusterDb.count(),
          active: clusterDb.countActive(),
        },
      });
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
}
