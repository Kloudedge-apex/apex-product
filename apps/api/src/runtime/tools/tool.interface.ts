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
