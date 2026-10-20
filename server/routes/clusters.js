// Dynamic cluster management (agent-cluster-platform)
// Simplified version to avoid ES module issues

import * as db from "../../db.js";

const CLUSTER_RATE_LIMIT = 10;
const CLUSTER_RATE_WINDOW = 60 * 60 * 1000;

const rateLimitBuckets = new Map();

function checkRateLimit(email) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(email);
  
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + CLUSTER_RATE_WINDOW };
    rateLimitBuckets.set(email, bucket);
  }
  
  if (bucket.count >= CLUSTER_RATE_LIMIT) {
    return false;
  }
  
  bucket.count += 1;
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - CLUSTER_RATE_WINDOW;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= cutoff) {
      rateLimitBuckets.delete(key);
    }
  }
}, CLUSTER_RATE_WINDOW).unref();

export function createClusterRoutes(app) {
  app.post("/api/clusters/dynamic", async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    if (!checkRateLimit(user.email)) {
      return res.status(429).json({ 
        error: "Too many cluster creations, try again later" 
      });
    }
    
    const { name, description, tags, agents, activateAll = true, bindToSession } = req.body;
    
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Cluster name is required" });
    }
    
    if (!Array.isArray(agents) || agents.length === 0) {
      return res.status(400).json({ error: "At least one agent is required" });
    }
    
    const invalidAgents = [];
    for (const agentRef of agents) {
      if (!agentRef.packId || !agentRef.agentId) {
        invalidAgents.push(agentRef);
        continue;
      }
      
      const subscription = db.getInstalledPack(agentRef.packId);
      if (!subscription) {
        invalidAgents.push({ ...agentRef, reason: "not_subscribed" });
      }
    }
    
    if (invalidAgents.length > 0) {
      return res.status(400).json({ 
        error: "Invalid agent references",
        invalidAgents 
      });
    }
    
    const clusterId = `dyn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const createdAt = Date.now();
    
    let hasInstalling = false;
    const processedAgents = agents.map(a => {
      const sub = db.getInstalledPack(a.packId);
      const status = sub ? "active" : "installing";
      if (!sub) hasInstalling = true;
      
      return {
        packId: a.packId,
        agentId: a.agentId,
        version: a.version,
        status
      };
    });
    
    const clusterData = {
      id: clusterId,
      name: name.trim(),
      description: description?.trim() || "",
      tags: tags?.filter(t => typeof t === "string" && t.trim()).slice(0, 5) || [],
      agents: processedAgents,
      activateAll,
      bindToSession,
      sessionId: bindToSession ? req.sessionId : null,
      createdAt,
      lastUsedAt: createdAt,
      totalExecutions: 0,
      totalTokensUsed: 0,
      status: hasInstalling ? "loading" : "ready"
    };
    
    // Use in-memory storage for now
    if (!global.dynamicClusters) {
      global.dynamicClusters = new Map();
    }
    global.dynamicClusters.set(clusterId, clusterData);
    
    if (bindToSession && req.sessionId) {
      if (!global.clusterSessionBindings) {
        global.clusterSessionBindings = new Map();
      }
      global.clusterSessionBindings.set(req.sessionId, clusterId);
    }
    
    res.json({
      clusterId,
      status: clusterData.status,
      name: clusterData.name,
      agents: clusterData.agents.map(a => ({ ...a, status: a.status }))
    });
  });
  
  app.get("/api/clusters/:id", (req, res) => {
    const clusterId = req.params.id;
    const cluster = global.dynamicClusters?.get(clusterId);
    
    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    
    cluster.lastUsedAt = Date.now();
    
    res.json({
      clusterId: cluster.id,
      name: cluster.name,
      description: cluster.description,
      tags: cluster.tags,
      status: cluster.status,
      createdAt: cluster.createdAt,
      lastUsedAt: cluster.lastUsedAt,
      totalExecutions: cluster.totalExecutions,
      totalTokensUsed: cluster.totalTokensUsed,
      agents: cluster.agents
    });
  });
  
  app.patch("/api/clusters/:id", (req, res) => {
    const clusterId = req.params.id;
    const cluster = global.dynamicClusters?.get(clusterId);
    
    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    
    const { name, description, tags } = req.body;
    
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Invalid cluster name" });
      }
      cluster.name = name.trim();
    }
    
    if (description !== undefined) {
      cluster.description = description?.trim() || "";
    }
    
    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: "Tags must be an array" });
      }
      cluster.tags = tags.filter(t => typeof t === "string" && t.trim()).slice(0, 5);
    }
    
    res.json({
      clusterId: cluster.id,
      name: cluster.name,
      description: cluster.description,
      tags: cluster.tags,
      updatedAt: Date.now()
    });
  });
  
  app.delete("/api/clusters/:id", (req, res) => {
    const clusterId = req.params.id;
    const cluster = global.dynamicClusters?.get(clusterId);
    
    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    
    global.dynamicClusters?.delete(clusterId);
    
    if (cluster.bindToSession && cluster.sessionId) {
      global.clusterSessionBindings?.delete(cluster.sessionId);
    }
    
    res.json({
      success: true,
      message: "Cluster terminated"
    });
  });
  
  app.post("/api/clusters/:id/agents", (req, res) => {
    const clusterId = req.params.id;
    const cluster = global.dynamicClusters?.get(clusterId);
    
    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    
    const { agents } = req.body;
    
    if (!Array.isArray(agents) || agents.length === 0) {
      return res.status(400).json({ error: "At least one agent is required" });
    }
    
    const added = [];
    for (const agentRef of agents) {
      const exists = cluster.agents.some(a => 
        a.packId === agentRef.packId && a.agentId === agentRef.agentId
      );
      
      if (exists) {
        continue;
      }
      
      const sub = db.getInstalledPack(agentRef.packId);
      if (!sub) {
        continue;
      }
      
      cluster.agents.push({
        packId: agentRef.packId,
        agentId: agentRef.agentId,
        version: agentRef.version,
        status: "active"
      });
      
      added.push(agentRef.agentId);
    }
    
    res.json({
      clusterId: cluster.id,
      added,
      totalAgents: cluster.agents.length
    });
  });
  
  app.delete("/api/clusters/:id/agents/:agentId", (req, res) => {
    const clusterId = req.params.id;
    const agentId = req.params.agentId;
    const cluster = global.dynamicClusters?.get(clusterId);
    
    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    
    const index = cluster.agents.findIndex(a => a.agentId === agentId);
    
    if (index === -1) {
      return res.status(404).json({ error: "Agent not found in cluster" });
    }
    
    cluster.agents.splice(index, 1);
    
    res.json({
      clusterId: cluster.id,
      removedAgentId: agentId,
      remainingAgents: cluster.agents.length
    });
  });
  
  app.get("/api/clusters/user/:email", (req, res) => {
    const requestedEmail = req.params.email;
    const user = req.user;
    
    if (!user || user.email !== requestedEmail) {
      return res.status(403).json({ error: "Forbidden" });
    }
    
    const userClusters = [];
    for (const cluster of global.dynamicClusters?.values() || []) {
      userClusters.push({
        clusterId: cluster.id,
        name: cluster.name,
        status: cluster.status,
        agentCount: cluster.agents.length,
        createdAt: cluster.createdAt,
        lastUsedAt: cluster.lastUsedAt
      });
    }
    
    res.json({ clusters: userClusters });
  });
}

export function startAutoTerminationJob() {
  setInterval(() => {
    const now = Date.now();
    const gracePeriod = 24 * 60 * 60 * 1000;
    const absoluteTimeout = 7 * 24 * 60 * 60 * 1000;
    
    if (!global.dynamicClusters) return;
    
    for (const [clusterId, cluster] of global.dynamicClusters) {
      const idleSince = now - cluster.lastUsedAt;
      const shouldTerminate = 
        (idleSince > gracePeriod && cluster.totalExecutions < 5) ||
        idleSince > absoluteTimeout;
      
      if (shouldTerminate) {
        setTimeout(() => {
          const deleted = global.dynamicClusters?.delete(clusterId);
          if (deleted) {
            console.log(`[cluster] Auto-terminated: ${clusterId}`);
          }
        }, 60 * 60 * 1000);
      }
    }
  }, 60 * 60 * 1000).unref();
}
