import { Tool } from "./tool.interface";
import { WebSearchTool } from "./web-search.tool";
import { WebScrapeTool } from "./web-scrape.tool";
import { SendEmailTool } from "./send-email.tool";
import { HubSpotTool } from "./hubspot.tool";
import { CompanyResearchTool } from "./company-research.tool";
import { LeadScoreTool } from "./lead-score.tool";
import { MemoryTool } from "./memory.tool";
import { LinkedInSendMessageTool } from "./linkedin-send-message.tool";
import { MemoryService } from "../memory.service";
import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { LinkedInService } from "../../integrations/linkedin/linkedin.service";
import { getAllTemplates } from "../../agents/templates";
import { AgentTemplateConfig } from "../../agents/templates/template.types";

/**
 * Canonical set of tool names that ToolRegistry knows how to instantiate.
 * Used by buildTemplateToolMap() to validate template `availableTools` against
 * a stable source-of-truth even when optional tools (e.g. `memory`, which
 * requires MemoryService) aren't wired in a particular invocation.
 *
 * Keep in sync with registerDefaults() below.
 */
export const REGISTRABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "web_scrape",
  "send_email",
  "hubspot",
  "company_research",
  "lead_score",
  "memory",
  "linkedin_send_message",
]);

/**
 * Derive the `templateName.toLowerCase() -> allowed tool names` map from the
 * imported agent templates. Templates are the single source of truth for tool
 * whitelisting; this function is also where bootstrap-fast-fails if any
 * template cites a tool name that ToolRegistry has no idea how to provide.
 *
 * Throws on unknown tool names with the exact message format:
 *   `Template "${slug}" cites unknown tool "${name}"`
 */
export function buildTemplateToolMap(
  templates: AgentTemplateConfig[],
  knownToolNames: ReadonlySet<string> = REGISTRABLE_TOOL_NAMES,
): Record<string, string[]> {
  const map: Record<string, string[]> = {};

  for (const template of templates) {
    const toolNames: string[] = [];

    for (const tool of template.availableTools) {
      if (!knownToolNames.has(tool.name)) {
        throw new Error(`Template "${template.slug}" cites unknown tool "${tool.name}"`);
      }
      toolNames.push(tool.name);
    }

    map[template.name.toLowerCase()] = toolNames;
  }

  return map;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private readonly templateToolMap: Record<string, string[]>;

  constructor(
    memoryService?: MemoryService,
    evidenceLedger?: EvidenceLedgerService,
    templates: AgentTemplateConfig[] = getAllTemplates(),
    linkedinService?: LinkedInService,
  ) {
    this.registerDefaults(memoryService, evidenceLedger, linkedinService);
    // Templates are the source of truth for tool whitelisting; derive the map
    // at construction so the runtime cannot drift away from declared templates.
    this.templateToolMap = buildTemplateToolMap(templates);
  }

  private registerDefaults(
    memoryService?: MemoryService,
    evidenceLedger?: EvidenceLedgerService,
    linkedinService?: LinkedInService,
  ): void {
    this.register(new WebSearchTool());
    this.register(new WebScrapeTool());
    this.register(new SendEmailTool(evidenceLedger));
    this.register(new HubSpotTool(evidenceLedger));
    this.register(new CompanyResearchTool());
    this.register(new LeadScoreTool());
    // linkedin_send_message is always registered so the template/registry sync
    // invariant holds even when LinkedInService isn't wired. Execution fails
    // explicitly unless both the service and live tenant credentials exist.
    this.register(new LinkedInSendMessageTool(linkedinService, evidenceLedger));
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
    const toolNames = this.templateToolMap[normalized];

    if (!toolNames) {
      return [];
    }

    return toolNames
      .map((name) => this.tools.get(name))
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * Returns the allow-list of tool names for a template, or `null` when the
   * template has no explicit entry. Execution callers must treat `null` as an
   * empty allow-list; evaluator callers may use it to try normalized aliases.
   */
  getAllowedToolNames(templateName: string): string[] | null {
    const normalized = templateName.toLowerCase();
    const toolNames = this.templateToolMap[normalized];
    return toolNames ? [...toolNames] : null;
  }

  listAll(): { name: string; description: string }[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }
}
