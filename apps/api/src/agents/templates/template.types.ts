/** Domain categories for agent templates */
export type AgentDomain = "SALES" | "MARKETING" | "OPS";

/** Tool definition within a template */
export interface TemplateTool {
  name: string;
  description: string;
}

/** Default runtime configuration for an agent */
export interface TemplateDefaultConfig {
  maxIterations: number;
  timeoutMs: number;
  model: string;
  [key: string]: unknown;
}

/** Full agent template configuration */
export interface AgentTemplateConfig {
  /** Unique slug identifier for the template */
  slug: string;
  /** Human-readable template name */
  name: string;
  /** Description of what this agent does */
  description: string;
  /** Domain category */
  domain: AgentDomain;
  /** Detailed system prompt (200+ words) used by the LLM */
  systemPrompt: string;
  /** Integration providers required (e.g. "email", "crm", "social") */
  requiredIntegrations: string[];
  /** Default cron schedule */
  defaultSchedule: string;
  /** Tools this agent can use */
  availableTools: TemplateTool[];
  /** Example tasks this agent can perform */
  exampleTasks: string[];
  /** Default runtime config */
  defaultConfig: TemplateDefaultConfig;
}
