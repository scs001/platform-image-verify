// Model binding and provider routing for Agent Cluster Platform
// Handles per-agent model selection, provider fallback, and billing attribution


import { getClusterDatabase } from "./clusters-db.js";

const clusterDb = getClusterDatabase();

const PROVIDER_ROUTES = {
  // Volces (豆包)
  "volces-max": {
    provider: "volces",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "VOLCES_API_KEY",
    fallbackProviders: ["tencent"],
  },
  "volces-standard": {
    provider: "volces",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "VOLCES_API_KEY",
    fallbackProviders: ["tencent"],
  },
  
  // Tencent Cloud
  "tencent-standard": {
    provider: "tencent",
    endpoint: "https://hunyuan.tencentcloudapi.com",
    apiKeyEnv: "TENCENT_API_KEY",
    fallbackProviders: ["volces"],
  },
  
  // DeepSeek
  "deepseek-chat": {
    provider: "deepseek",
    endpoint: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    fallbackProviders: [],
  },
  
  // OpenRouter (for models not available locally)
  "openrouter-default": {
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    fallbackProviders: [],
  },
};

export function createModelBindingRoutes(app) {
  // GET /api/models - List available models with provider info
  app.get("/api/models", (req, res) => {
    try {
      const models = Object.entries(PROVIDER_ROUTES).map(([id, config]) => ({
        id,
        name: id.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
        provider: config.provider,
        endpoint: config.endpoint,
        hasFallback: config.fallbackProviders.length > 0,
        fallbackCount: config.fallbackProviders.length,
      }));
      
      res.json({ models });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  // POST /api/clusters/:clusterId/bindings - Set model bindings for cluster agents
  app.post("/api/clusters/:clusterId/bindings", async (req, res) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      
      const clusterId = req.params.clusterId;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      const { bindings } = req.body;
      
      if (!bindings || !Array.isArray(bindings)) {
        return res.status(400).json({ error: "bindings array required" });
      }
      
      // Validate each binding
      for (const binding of bindings) {
        if (!binding.agentId || !binding.modelId) {
          return res.status(400).json({ 
            error: `Invalid binding: agentId and modelId required` 
          });
        }
        
        if (!PROVIDER_ROUTES[binding.modelId]) {
          return res.status(400).json({ 
            error: `Unknown model: ${binding.modelId}` 
          });
        }
        
        // Check if agent exists in cluster
        const agentExists = cluster.agents.some(a => a.agentId === binding.agentId);
        if (!agentExists) {
          return res.status(400).json({ 
            error: `Agent ${binding.agentId} not found in cluster` 
          });
        }
      }
      
      // Store bindings (in production, use database)
      if (!global.modelBindings) {
        global.modelBindings = new Map();
      }
      
      if (!global.modelBindings.has(clusterId)) {
        global.modelBindings.set(clusterId, {});
      }
      
      const clusterBindings = global.modelBindings.get(clusterId);
      for (const binding of bindings) {
        clusterBindings[binding.agentId] = {
          modelId: binding.modelId,
          updatedAt: Date.now(),
          updatedBy: user.email,
        };
      }
      
      res.json({ 
        success: true, 
        message: "Model bindings updated",
        bindings: clusterBindings 
      });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  // GET /api/clusters/:clusterId/bindings - Get current model bindings
  app.get("/api/clusters/:clusterId/bindings", (req, res) => {
    try {
      const clusterId = req.params.clusterId;
      const cluster = clusterDb.get(clusterId);
      
      if (!cluster) {
        return res.status(404).json({ error: "Cluster not found" });
      }
      
      const bindings = {};
      const clusterBindings = global.modelBindings?.get(clusterId) || {};
      
      for (const agent of cluster.agents) {
        const binding = clusterBindings[agent.agentId];
        if (binding) {
          const modelConfig = PROVIDER_ROUTES[binding.modelId];
          bindings[agent.agentId] = {
            ...binding,
            modelName: modelConfig ? modelConfig.provider : "unknown",
            hasFallback: modelConfig ? modelConfig.hasFallback : false,
          };
        } else {
          bindings[agent.agentId] = null;
        }
      }
      
      res.json({ bindings });
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
  
  // POST /api/tasks/:taskId/route - Execute task with provider routing
  app.post("/api/tasks/:taskId/route", async (req, res) => {
    try {
      const taskId = req.params.taskId;
      const { agentId, prompt, modelOverride } = req.body;
      
      // Get cluster and agent info
      // (This would normally query the task system)
      
      // Determine which model to use
      let modelId = modelOverride;
      if (!modelId) {
        // Try to get from cluster bindings
        // (would come from task context in real implementation)
        modelId = getDefaultModelForAgent(agentId);
      }
      
      if (!modelId || !PROVIDER_ROUTES[modelId]) {
        return res.status(400).json({ error: "Invalid or missing model" });
      }
      
      const route = PROVIDER_ROUTES[modelId];
      
      try {
        // Call primary provider
        const result = await callProvider(route, prompt);
        
        res.json({
          success: true,
          provider: route.provider,
          modelId,
          result,
          tokensUsed: result.tokens || 0,
        });
      } catch (error) {
        console.log(`[model-routing] Primary provider ${route.provider} failed:`, error.message);
        
        // Try fallback providers
        if (route.fallbackProviders && route.fallbackProviders.length > 0) {
          for (const fallbackProvider of route.fallbackProviders) {
            const fallbackRoute = findProviderByType(fallbackProvider);
            if (fallbackRoute) {
              try {
                const result = await callProvider(fallbackRoute, prompt);
                
                res.json({
                  success: true,
                  provider: fallbackProvider,
                  modelId,
                  result,
                  tokensUsed: result.tokens || 0,
                  routed: true, // Indicates fallback was used
                });
                return;
              } catch (fallbackError) {
                console.log(`[model-routing] Fallback ${fallbackProvider} also failed:`, fallbackError.message);
              }
            }
          }
        }
        
        // All providers failed
        res.status(503).json({ 
          error: "All providers unavailable",
          originalError: error.message,
          attemptedProviders: [route.provider, ...route.fallbackProviders || []]
        });
      }
    
    } catch (err) {
      console.error("[cluster] handler error:", err);
      if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
    }
  });
}

// Helper functions
function getDefaultModelForAgent(agentId) {
  // In production, this would check cluster defaults or agent-specific settings
  // For now, return a default model
  return "volces-max";
}

function findProviderByType(providerType) {
  for (const [id, config] of Object.entries(PROVIDER_ROUTES)) {
    if (config.provider === providerType) {
      return config;
    }
  }
  return null;
}

async function callProvider(route, prompt) {
  // This would make actual API calls to the provider
  // For now, return mock response
  
  const apiKey = process.env[route.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`API key not configured for ${route.provider}`);
  }
  
  // Mock response
  return {
    content: `Mock response from ${route.provider} using ${route.endpoint}`,
    tokens: Math.floor(Math.random() * 100),
    duration: Math.random() * 2000,
  };
}
