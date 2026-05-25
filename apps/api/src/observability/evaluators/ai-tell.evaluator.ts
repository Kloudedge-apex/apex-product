import { Injectable } from "@nestjs/common";
import { Evaluator, EvaluatorContext, EvaluatorResult, stringifyForEval } from "./evaluator.interface";

// "AI tells" — words and punctuation that statistically indicate machine
// generation in marketing copy. Em-dashes are gpt-4o's signature tic; "delve"
// and "tapestry" are 4o-mini's. Hits are penalized but lighter than boilerplate
// because some of these (e.g. "leverage") have legitimate uses — the score is
// advisory, not a hard gate.
const AI_TELLS: readonly RegExp[] = [
  /—/, // em-dash
  /\bdelve\b/i,
  /\btapestry\b/i,
  /\bnavigate the (?:landscape|complexities)\b/i,
  /\bIn today'?s (?:fast-paced|competitive|digital)\b/i,
  /\bleverage\b/i,
  /\bmoreover\b/i,
  /\bfurthermore\b/i,
  /\bIt'?s worth noting\b/i,
  /\b(?:unlock|unleash) (?:the )?(?:potential|power)\b/i,
  /\bgame[- ]?changer\b/i,
  /\brevolutioniz(?:e|ing|ed)\b/i,
  /\bcutting[- ]edge\b/i,
];

const PER_HIT_PENALTY = 0.15;

@Injectable()
export class AiTellEvaluator implements Evaluator {
  readonly key = "ai_tell";

  appliesTo(ctx: EvaluatorContext): boolean {
    const agent = (ctx.agent ?? "").toLowerCase();
    const tags = (ctx.tags ?? []).join(",").toLowerCase();
    return (
      agent.includes("sdr_agent.draft_message") ||
      agent.includes("content_writer") ||
      tags.includes("draft_message") ||
      tags.includes("customer_facing")
    );
  }

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorResult | null> {
    const body = extractBody(ctx.outputs);
    if (!body) return null;
    const hits = AI_TELLS.filter((p) => p.test(body));
    if (hits.length === 0) {
      return { key: this.key, score: 1, value: "human_sounding", comment: "no AI tells matched" };
    }
    const score = Math.max(0, 1 - hits.length * PER_HIT_PENALTY);
    const labels = hits.map((p) => p.source).slice(0, 5);
    return {
      key: this.key,
      score,
      value: score < 0.5 ? "many_tells" : "some_tells",
      comment: `tells (${hits.length}): ${labels.join(", ")}`,
    };
  }
}

function extractBody(outputs: unknown): string {
  if (!outputs) return "";
  if (typeof outputs === "string") return outputs;
  if (typeof outputs === "object") {
    const obj = outputs as Record<string, unknown>;
    if (typeof obj.body === "string") return obj.body;
    if (typeof obj.content === "string") return obj.content;
  }
  return stringifyForEval(outputs, 4000);
}
