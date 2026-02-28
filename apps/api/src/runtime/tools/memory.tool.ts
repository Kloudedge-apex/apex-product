import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { MemoryService } from "../memory.service";

export class MemoryTool implements Tool {
  name = "memory";
  description = "Read and write to the agent's persistent memory. Use this to remember information across runs, track contacted leads, cache research, and store summaries.";
  parameters = {
    action: {
      type: "string",
      description: 'Action: "read" to get a memory, "write" to store a memory, "list" to list all memory keys, "delete" to remove a memory',
      required: true,
    },
    key: {
      type: "string",
      description: "Memory key (e.g. 'contacted_leads', 'company_research_cache', 'last_run_summary')",
      required: false,
    },
    value: {
      type: "object",
      description: "Value to store (for write action). Can be any JSON value.",
      required: false,
    },
  };

  constructor(private memoryService: MemoryService) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = params.action as string;
    const key = params.key as string | undefined;
    const value = params.value;

    switch (action) {
      case "read": {
        if (!key) return { success: false, data: null, error: "key is required for read action" };
        const data = await this.memoryService.get(context.agentId, key);
        return { success: true, data: { key, value: data } };
      }
      case "write": {
        if (!key) return { success: false, data: null, error: "key is required for write action" };
        if (value === undefined) return { success: false, data: null, error: "value is required for write action" };
        await this.memoryService.set(context.agentId, key, value);
        return { success: true, data: { key, stored: true } };
      }
      case "list": {
        const all = await this.memoryService.getAll(context.agentId);
        const keys = Object.keys(all);
        return { success: true, data: { keys, count: keys.length } };
      }
      case "delete": {
        if (!key) return { success: false, data: null, error: "key is required for delete action" };
        await this.memoryService.delete(context.agentId, key);
        return { success: true, data: { key, deleted: true } };
      }
      default:
        return { success: false, data: null, error: `Unknown action: ${action}. Use read, write, list, or delete.` };
    }
  }
}
