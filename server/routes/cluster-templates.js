// Cluster templates marketplace for Agent Cluster Platform
// Allows users to publish, browse, and subscribe to cluster templates

import * as db from "../../db.js";
import { getClusterDatabase } from "./clusters-db.js";

const clusterDb = getClusterDatabase();

export function createClusterTemplateRoutes(app) {
  // GET /api/templates - List available cluster templates
  app.get("/api/templates", (req, res) => {
    const templates = [
      {
        id: "finance-analyst",
        name: "Finance Analyst Cluster",
        description: "Financial analysis team with data extraction and reporting",
        agents: [
          { id: "finance-bot", name: "Finance Bot", role: "data-extraction" },
          { id: "data-analyst", name: "Data Analyst", role: "analysis" },
          { id: "report-generator", name: "Report Generator", role: "reporting" }
        ],
        tags: ["finance", "analysis", "reporting"],
        author: "FindData Technology",
        version: "1.0.0",
        subscriberCount: 127,
        featured: true,
        category: "business",
      },
      {
        id: "legal-review",
        name: "Legal Review Team",
        description: "Contract review and legal analysis cluster",
        agents: [
          { id: "contract-analyzer", name: "Contract Analyzer", role: "review" },
          { id: "legal-researcher", name: "Legal Researcher", role: "research" },
          { id: "compliance-checker", name: "Compliance Checker", role: "compliance" }
        ],
        tags: ["legal", "contracts", "compliance"],
        author: "LegalTech Solutions",
        version: "1.2.0",
        subscriberCount: 89,
        featured: false,
        category: "legal",
      },
      {
        id: "marketing-automation",
        name: "Marketing Automation Cluster",
        description: "Content creation and campaign management",
        agents: [
          { id: "content-writer", name: "Content Writer", role: "creation" },
          { id: "seo-optimizer", name: "SEO Optimizer", role: "optimization" },
          { id: "campaign-manager", name: "Campaign Manager", role: "management" }
        ],
        tags: ["marketing", "content", "campaigns"],
        author: "Marketing Pro",
        version: "2.1.0",
        subscriberCount: 245,
        featured: true,
        category: "marketing",
      },
    ];
    
    // Filter by category if provided
    const category = req.query.category;
    if (category) {
      const filtered = templates.filter(t => 
        t.tags.includes(category) || t.category === category
      );
      return res.json({ templates: filtered });
    }
    
    res.json({ templates });
  });
  
  // GET /api/templates/:id - Get template details
  app.get("/api/templates/:id", (req, res) => {
    const templateId = req.params.id;
    const template = templates.find(t => t.id === templateId);
    
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    
    res.json({ template });
  });
  
  // POST /api/templates - Create new template (admin/creator only)
  app.post("/api/templates", async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    // Check if user has permission to create templates
    // (would check creator groups in production)
    
    const { name, description, agents, tags, category } = req.body;
    
    if (!name || !description || !Array.isArray(agents)) {
      return res.status(400).json({ error: "name, description, and agents required" });
    }
    
    // Validate agents
    for (const agent of agents) {
      if (!agent.id || !agent.name || !agent.role) {
        return res.status(400).json({ error: "Each agent must have id, name, and role" });
      }
    }
    
    // In production, save to database
    const newTemplate = {
      id: `tpl_${Date.now()}`,
      name,
      description,
      agents,
      tags: tags || [],
      category: category || "general",
      author: user.email,
      version: "1.0.0",
      subscriberCount: 0,
      featured: false,
      createdAt: Date.now(),
    };
    
    // Save to DB (mock implementation)
    console.log("[templates] New template created:", newTemplate.id);
    
    res.status(201).json({ 
      success: true, 
      template: newTemplate,
      message: "Template created successfully"
    });
  });
  
  // POST /api/templates/:id/subscribe - Subscribe to a template
  app.post("/api/templates/:id/subscribe", async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    const templateId = req.params.id;
    
    // In production, check if already subscribed, update count, etc.
    console.log(`[templates] User ${user.email} subscribed to template ${templateId}`);
    
    res.json({ 
      success: true, 
      message: "Successfully subscribed to template"
    });
  });
  
  // DELETE /api/templates/:id - Delete template (owner/admin only)
  app.delete("/api/templates/:id", async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    const templateId = req.params.id;
    
    // In production, verify ownership before deleting
    console.log(`[templates] Template ${templateId} deleted`);
    
    res.json({ 
      success: true, 
      message: "Template deleted"
    });
  });
  
  // POST /api/templates/:id/deploy - Deploy template as cluster
  app.post("/api/templates/:id/deploy", async (req, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    const templateId = req.params.id;
    const { name, description } = req.body;
    
    // Find template
    const template = templates.find(t => t.id === templateId);
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }
    
    // Create cluster from template
    const clusterData = {
      id: `dyn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: name || `${template.name} (from template)`,
      description: description || `Deployed from ${template.name} template`,
      tags: template.tags,
      agents: template.agents.map(a => ({
        packId: `template_${templateId}`,
        agentId: a.id,
        version: template.version,
        status: "active"
      })),
      activateAll: true,
      bindToSession: false,
      sessionId: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      totalExecutions: 0,
      totalTokensUsed: 0,
      status: "ready",
      isFromTemplate: true,
      templateId,
    };
    
    // Store cluster
    clusterDb.create(clusterData);
    
    res.json({
      success: true,
      clusterId: clusterData.id,
      message: "Cluster deployed from template successfully"
    });
  });
}
