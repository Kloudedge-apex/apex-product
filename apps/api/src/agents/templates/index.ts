export { AgentTemplateConfig, AgentDomain, TemplateTool, TemplateDefaultConfig } from "./template.types";
export { sdrAgentTemplate } from "./sdr-agent.template";
export { contentWriterTemplate } from "./content-writer.template";
export { inboxMonitorTemplate } from "./inbox-monitor.template";
export { replyHandlerTemplate } from "./reply-handler.template";
export { seoAgentTemplate } from "./seo-agent.template";
export { reportingAgentTemplate } from "./reporting-agent.template";

import { sdrAgentTemplate } from "./sdr-agent.template";
import { contentWriterTemplate } from "./content-writer.template";
import { inboxMonitorTemplate } from "./inbox-monitor.template";
import { replyHandlerTemplate } from "./reply-handler.template";
import { seoAgentTemplate } from "./seo-agent.template";
import { reportingAgentTemplate } from "./reporting-agent.template";
import { AgentTemplateConfig } from "./template.types";

/** All available agent templates, keyed by slug */
export const allTemplates: Record<string, AgentTemplateConfig> = {
  "sdr-agent": sdrAgentTemplate,
  "content-writer": contentWriterTemplate,
  "inbox-monitor": inboxMonitorTemplate,
  "reply-handler": replyHandlerTemplate,
  "seo-agent": seoAgentTemplate,
  "reporting-agent": reportingAgentTemplate,
};

/** Get all templates as an array */
export function getAllTemplates(): AgentTemplateConfig[] {
  return Object.values(allTemplates);
}

/** Get a template by slug */
export function getTemplateBySlug(slug: string): AgentTemplateConfig | undefined {
  return allTemplates[slug];
}

/** Get templates filtered by domain */
export function getTemplatesByDomain(domain: string): AgentTemplateConfig[] {
  return getAllTemplates().filter((t) => t.domain === domain);
}
