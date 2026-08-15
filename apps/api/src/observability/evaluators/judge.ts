import { Logger } from "@nestjs/common";
import type { LLMService } from "../../runtime/llm.service";

const logger = new Logger("EvaluatorJudge");

const JUDGE_TAG = "evaluator_judge";

export interface JudgeVerdict {
  readonly score: number; // 0..1
  readonly label: string;
  readonly rationale: string;
}

/**
 * Call an LLM judge to score a single rubric. Always tags the run with
 * "evaluator_judge" so the evaluator runner can skip evaluating it (no recursion).
 * Returns null on any failure — judge calls must not break the pipeline.
 */
export async function callJudge(
  llm: LLMService,
  args: {
    readonly rubricName: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly model?: string;
    readonly orgId?: string;
  },
): Promise<JudgeVerdict | null> {
  try {
    const resp = await llm.chat(
      [
        { role: "system", content: args.systemPrompt },
        { role: "user", content: args.userPrompt },
      ],
      {
        // Judge is system-level (not template-driven), so it reads from a
        // dedicated env knob. Lets ops tune evaluator cost/quality without
        // touching template configs.
        model: args.model ?? process.env.LANGSMITH_JUDGE_MODEL ?? "gpt-4o-mini",
        maxTokens: 300,
        agent: `evaluator.${args.rubricName}`,
        tags: [JUDGE_TAG, args.rubricName],
        orgId: args.orgId,
        metadata: args.orgId ? { org_id: args.orgId } : undefined,
      },
    );

    const parsed = parseJudgeResponse(resp.content);
    if (!parsed) {
      logger.warn(`Judge ${args.rubricName} returned unparseable content`);
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn(
      `Judge ${args.rubricName} call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function isJudgeRun(tags?: readonly string[]): boolean {
  return (tags ?? []).includes(JUDGE_TAG);
}

function parseJudgeResponse(raw: string): JudgeVerdict | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const scoreRaw = obj.score;
    const score = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
    if (!Number.isFinite(score)) return null;
    const clamped = Math.max(0, Math.min(1, score));
    const label = typeof obj.label === "string" ? obj.label : "unknown";
    const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
    return { score: clamped, label, rationale };
  } catch {
    return null;
  }
}
