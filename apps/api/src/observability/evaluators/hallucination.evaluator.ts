import { Injectable } from "@nestjs/common";
import { Evaluator, EvaluatorContext, EvaluatorDeps, EvaluatorResult, stringifyForEval } from "./evaluator.interface";

const SYSTEM = `You are a grounding judge. The assistant was given research/context as input and produced an output.
Score how well the output is GROUNDED in the provided context.
- score=1: every factual claim in the output is supported by the input context (verbatim or paraphrase)
- score=0.5: some claims are unsupported, but the gist matches
- score=0: the output invents facts not in the context (hallucination)
Generic/fluent prose without specific factual claims = score=1.
Return ONLY a JSON object: {"score": number 0..1, "label": "grounded"|"partial"|"hallucinated", "rationale": "..."}`;

@Injectable()
export class HallucinationEvaluator implements Evaluator {
  readonly key = "hallucination";

  appliesTo(ctx: EvaluatorContext): boolean {
    const agent = (ctx.agent ?? "").toLowerCase();
    const tags = (ctx.tags ?? []).join(",").toLowerCase();
    return (
      agent.includes("sdr_agent.draft_message") ||
      agent.includes("icp_auto") ||
      agent.includes("content_writer") ||
      agent.includes("reporting") ||
      tags.includes("draft_message")
    );
  }

  async evaluate(ctx: EvaluatorContext, deps: EvaluatorDeps): Promise<EvaluatorResult | null> {
    if (!deps.judge) return null;
    const inputs = stringifyForEval(ctx.inputs, 6000);
    const outputs = stringifyForEval(ctx.outputs, 3000);
    if (!inputs || !outputs) return null;

    const verdict = await deps.judge({
      rubricName: this.key,
      systemPrompt: SYSTEM,
      userPrompt: `Input context provided to agent:\n${inputs}\n\nAgent output to score:\n${outputs}`,
    });
    if (!verdict) return null;
    return {
      key: this.key,
      score: verdict.score,
      value: verdict.label,
      comment: verdict.rationale,
    };
  }
}
