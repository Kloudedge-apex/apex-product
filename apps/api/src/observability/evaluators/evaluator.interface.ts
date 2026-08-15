export interface EvaluatorContext {
  readonly runId: string;
  readonly agent?: string;
  readonly node?: string;
  readonly model: string;
  readonly inputs: unknown;
  readonly outputs: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly tags?: readonly string[];
  /** Optional ground truth for correctness evaluation (deterministic agents only). */
  readonly groundTruth?: unknown;
}

export interface EvaluatorResult {
  /** LangSmith feedback key, e.g. "pii_leakage", "prompt_injection", "toxicity". */
  readonly key: string;
  /** 0..1 where 1 = perfect / safe, 0 = bad. */
  readonly score: number;
  /** Optional categorical value (e.g. "safe", "high_risk"). */
  readonly value?: string;
  /** Human-readable rationale, shown in the LangSmith UI. */
  readonly comment?: string;
}

export interface EvaluatorDeps {
  /** Optional LLM provider for LLM-as-judge evaluators. When absent, judge-based evaluators return null. */
  readonly judge?: (args: {
    readonly rubricName: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly model?: string;
    /** Tenant charged for this evaluator call; absent only for system runs. */
    readonly orgId?: string;
  }) => Promise<{ score: number; label: string; rationale: string } | null>;
}

export interface Evaluator {
  readonly key: string;
  /** Return true to run this evaluator for the given context. Default: run for all. */
  appliesTo?(ctx: EvaluatorContext): boolean;
  evaluate(ctx: EvaluatorContext, deps: EvaluatorDeps): Promise<EvaluatorResult | null>;
}

export function stringifyForEval(value: unknown, maxChars = 8000): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, maxChars);
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}
