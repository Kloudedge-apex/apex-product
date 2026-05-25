import { Injectable } from "@nestjs/common";
import { Evaluator, EvaluatorContext, EvaluatorResult, stringifyForEval } from "./evaluator.interface";

// Deterministic phrase-list detector for the most common cold-email tells that
// signal "this was AI-generated and not personalized." Each hit subtracts a
// fixed amount from the score; the goal is a cheap pre-filter that fires on
// every draft and pulls the floor up before the LLM-judge evaluators run.
const BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /\bI hope (?:this|you|your) (?:email\s+)?(?:finds|find) you well\b/i,
  /\bI help (?:companies|teams|businesses) like yours\b/i,
  /\bquick question\b/i,
  /\bcircling back\b/i,
  /\bjust (?:checking|following) in\b/i,
  /\bHi\s+\{\{?firstName\}?\}/i, // unresolved template var
  /\bHi\s+,\s/, // empty first name
  /\bI noticed that you\b/i,
  /\breach(?:ing)? out\s+because\b/i,
  /\bI came across your (?:company|profile|work)\b/i,
];

const PER_HIT_PENALTY = 0.25;

@Injectable()
export class BoilerplateEvaluator implements Evaluator {
  readonly key = "boilerplate";

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
    const hits = BOILERPLATE_PATTERNS.filter((p) => p.test(body));
    if (hits.length === 0) {
      return { key: this.key, score: 1, value: "clean", comment: "no boilerplate patterns matched" };
    }
    const score = Math.max(0, 1 - hits.length * PER_HIT_PENALTY);
    const labels = hits.map((p) => p.source);
    return {
      key: this.key,
      score,
      value: score < 0.5 ? "heavy_boilerplate" : "some_boilerplate",
      comment: `hits: ${labels.join(", ")}`,
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
