export interface ModelCost {
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
  readonly cachedInputUsdPer1M?: number;
}

export const MODEL_COST_TABLE: Readonly<Record<string, ModelCost>> = {
  "gpt-4o-mini": {
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
    cachedInputUsdPer1M: 0.075,
  },
  "gpt-4o": {
    inputUsdPer1M: 2.5,
    outputUsdPer1M: 10,
    cachedInputUsdPer1M: 1.25,
  },
  // Placeholders for sprint usage — see PR_NOTES.md for follow-up.
  "gpt-5.2": { inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  "gpt-5": { inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
} as const;

const warnedUnknownModels = new Set<string>();

function normalizeModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;

  // Azure variants — keep callers free to pass "azure:gpt-4o" etc while pricing
  // remains keyed on the base OpenAI model name.
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("azure:")) return trimmed.slice("azure:".length);
  if (lower.startsWith("azure/")) return trimmed.slice("azure/".length);
  if (lower.endsWith("@azure")) return trimmed.slice(0, -"@azure".length);

  return trimmed;
}

function clampNonNegativeInt(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

export function estimateCostUsd(args: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}): number {
  const model = normalizeModel(args.model);
  const pricing = MODEL_COST_TABLE[model];
  if (!pricing) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      // Console warn is intentional: this module is pure and should not depend
      // on Nest Logger. Callers should consider unknown-model pricing a config
      // issue, not a runtime failure.
      // eslint-disable-next-line no-console
      console.warn(`[model-cost] Unknown model "${model}" — cost will be recorded as $0.00`);
    }
    return 0;
  }

  const inputTokens = clampNonNegativeInt(args.inputTokens);
  const outputTokens = clampNonNegativeInt(args.outputTokens);
  const cachedInputTokens = clampNonNegativeInt(args.cachedInputTokens);

  const cachedRate = pricing.cachedInputUsdPer1M ?? pricing.inputUsdPer1M;
  const cached = Math.min(cachedInputTokens, inputTokens);
  const uncached = Math.max(0, inputTokens - cached);

  const inputUsd = (uncached / 1_000_000) * pricing.inputUsdPer1M;
  const cachedUsd = (cached / 1_000_000) * cachedRate;
  const outputUsd = (outputTokens / 1_000_000) * pricing.outputUsdPer1M;

  const total = inputUsd + cachedUsd + outputUsd;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

