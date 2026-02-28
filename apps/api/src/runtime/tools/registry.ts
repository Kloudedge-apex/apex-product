import { Tool } from "./tool.interface";
import { WebSearchTool } from "./web-search.tool";
import { WebScrapeTool } from "./web-scrape.tool";
import { SendEmailTool } from "./send-email.tool";
import { HubSpotTool } from "./hubspot.tool";
import { CompanyResearchTool } from "./company-research.tool";
import { LeadScoreTool } from "./lead-score.tool";

const TEMPLATE_TOOL_MAP: Record<string, string[]> = {
  "sdr agent": ["web_search", "company_research", "lead_score", "send_email", "hubspot"],
  "crm sync agent": ["hubspot", "web_scrape"],
  "content writer": ["web_search", "web_scrape"],
  "social engagement agent": ["web_search", "web_scrape"],
  "inbox monitor": ["send_email"],
  "reporting agent": ["hubspot", "web_search"],
};

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(new WebSearchTool());
    this.register(new WebScrapeTool());
    this.register(new SendEmailTool());
    this.register(new HubSpotTool());
    this.register(new CompanyResearchTool());
    this.register(new LeadScoreTool());
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
