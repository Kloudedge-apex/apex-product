export interface LangSmithConfig {
  readonly apiKey?: string;
  readonly project?: string;
  readonly tracing?: boolean;
  readonly capturePrompts?: boolean;
  readonly maxContentChars: number;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseOptionalPositiveInt(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed <= 0) return undefined;
  return parsed;
}

export function getLangSmithConfig(
  env: NodeJS.ProcessEnv = process.env,
): LangSmithConfig {
  return {
    apiKey: env.LANGSMITH_API_KEY,
    project: env.LANGSMITH_PROJECT,
    tracing: parseOptionalBoolean(env.LANGSMITH_TRACING),
    capturePrompts: parseOptionalBoolean(env.LANGSMITH_CAPTURE_PROMPTS),
    maxContentChars: parseOptionalPositiveInt(env.LANGSMITH_MAX_CONTENT_CHARS) ?? 4000,
  };
}

