export interface ToolParameter {
  type: string;
  description: string;
  required?: boolean;
}

export interface ToolContext {
  orgId: string;
  agentId: string;
  runId: string;
  integrations: Map<string, IntegrationCredentials>;
  /**
   * CAN-SPAM §7704(a)(5) compliance: sender identity fields used by
   * SendEmailTool to compose the physical-address + unsubscribe-link footer
   * appended to every outbound. Worker-dispatched sends populate this from
   * the Org row immediately before tool.execute(). Audit P0 #2.
   */
  senderOrg?: {
    readonly orgName: string;
    readonly physicalAddress: string | null;
    readonly country: string | null;
    readonly senderName: string | null;
  };
}

export interface IntegrationCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export function toolToOpenAIFunction(tool: Tool): OpenAIFunctionDef {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];

  for (const [key, param] of Object.entries(tool.parameters)) {
    properties[key] = { type: param.type, description: param.description };
    if (param.required) required.push(key);
  }

  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        required,
      },
    },
  };
}

export interface OpenAIFunctionDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}
