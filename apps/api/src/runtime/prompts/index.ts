import { getSDRPrompt } from "./sdr-agent";
import { getCRMSyncPrompt } from "./crm-sync-agent";
import { getContentWriterPrompt } from "./content-writer";
import { getSocialEngagementPrompt } from "./social-engagement";
import { getInboxMonitorPrompt } from "./inbox-monitor";
import { getReportingPrompt } from "./reporting-agent";
import { getReplyHandlerPrompt } from "./reply-handler";
import { getSEOAgentPrompt } from "./seo-agent";

export function getPromptForTemplate(templateName: string, config: Record<string, unknown>): string {
  const name = templateName.toLowerCase();

  // Order matters: more specific matches must come before broader ones.
  if (name.includes("reply")) return getReplyHandlerPrompt(config);
  if (name.includes("seo")) return getSEOAgentPrompt(config);
  if (name.includes("sdr")) return getSDRPrompt(config);
  if (name.includes("crm")) return getCRMSyncPrompt(config);
  if (name.includes("content")) return getContentWriterPrompt(config);
  if (name.includes("social")) return getSocialEngagementPrompt(config);
  if (name.includes("inbox")) return getInboxMonitorPrompt(config);
  if (name.includes("report")) return getReportingPrompt(config);

  // Fallback generic prompt
  return `You are an AI agent assistant. Execute the following task based on your configuration:\n${JSON.stringify(config, null, 2)}\n\nProvide your output as a JSON object with a "type" field indicating the output type.`;
}
