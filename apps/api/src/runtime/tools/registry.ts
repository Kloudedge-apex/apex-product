import { Tool } from "./tool.interface";
import { WebSearchTool } from "./web-search.tool";
import { WebScrapeTool } from "./web-scrape.tool";
import { SendEmailTool } from "./send-email.tool";
import { HubSpotTool } from "./hubspot.tool";
import { CompanyResearchTool } from "./company-research.tool";
import { LeadScoreTool } from "./lead-score.tool";
import { MemoryTool } from "./memory.tool";
import { MemoryService } from "../memory.service";

const TEMPLATE_TOOL_MAP: Record<string, string[]> = {
  "sdr agent": ["web_search", "company_research", "lead_score", "send_email", "hubspot", "memory"],
  "crm sync agent": ["hubspot", "web_scrape", "memory"],
  "content writer": ["web_search", "web_scrape", "memory"],
  "social engagement agent": ["web_search", "web_scrape", "memory"],
  "inbox monitor": ["send_email", "memory"],
  "reporting agent": ["hubspot", "web_search", "memory"],
};

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(memoryService?: MemoryService) {
    this.registerDefaults(memoryService);
  }

  private registerDefaults(memoryService?: MemoryService): void {
    this.register(new WebSearchTool());
    this.register(new WebScrapeTool());
    this.register(new SendEmailTool());
    this.register(new HubSpotTool());
    this.register(new CompanyResearchTool());
    this.register(new LeadScoreTool());
    if (memoryService) {
      this.register(new MemoryTool(memoryService));
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getForTemplate(templateName: string): Tool[] {
    const normalized = templateName.toLowerCase();
    const toolNames = TEMPLATE_TOOL_MAP[normalized];

    if (!toolNames) {
      // Return all tools as fallback
      return Array.from(this.tools.values());
    }

    return toolNames
      .map((name) => this.tools.get(name))
      .filter((t): t is Tool => t !== undefined);
  }

  listAll(): { name: string; description: string }[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }
}
