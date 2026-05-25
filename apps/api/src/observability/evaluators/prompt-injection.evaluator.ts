import { Injectable } from "@nestjs/common";
import { Evaluator, EvaluatorContext, EvaluatorResult, stringifyForEval } from "./evaluator.interface";

// Conservative heuristics — keep precision high; LLM-as-judge can catch the rest.
const INJECTION_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /ignore (all |previous |the |any )?(prior |above |earlier )?(instructions|rules|prompts?)/i, label: "ignore_instructions" },
  { re: /disregard (all |previous |the )?(prior |above |earlier )?(instructions|rules|prompts?)/i, label: "disregard_instructions" },
  { re: /you are now (a |an )?[a-z ]{2,40}(?: assistant| agent| ai| model)?/i, label: "role_override" },
  { re: /(reveal|print|show|leak|output|repeat)\s+(your\s+)?(system\s+)?(prompt|instructions|rules)/i, label: "prompt_extraction" },
  { re: /developer mode|jailbreak|dan mode|do anything now/i, label: "jailbreak_keyword" },
  { re: /reset (your\s+)?(memory|context|conversation)/i, label: "reset_memory" },
  { re: /forget (everything|all|what)/i, label: "forget_keyword" },
  { re: /(act|behave|pretend) as (?:if you are|you'?re|a) /i, label: "pretend_role" },
  { re: /<\|.*?\|>|\[INST\]|\[\/INST\]/i, label: "control_token" },
];

/**
 * Heuristic prompt-injection detector. Scans tool outputs / scraped content
 * (i.e. the *inputs* the agent ingested) for injection patterns that would
 * try to override the system prompt. Outputs themselves rarely contain
 * injection — it's the untrusted content the agent ingests that matters.
 */
@Injectable()
export class PromptInjectionEvaluator implements Evaluator {
  readonly key = "prompt_injection";

  appliesTo(ctx: EvaluatorContext): boolean {
    // Most relevant where agents ingest external content: web scrape, email, social.
    const tags = (ctx.tags ?? []).join(",").toLowerCase();
    const agent = (ctx.agent ?? "").toLowerCase();
    return (
      tags.includes("inbox_monitor") ||
      tags.includes("social_engagement") ||
      tags.includes("team_page_extractor") ||
      tags.includes("icp_auto_extractor") ||
      agent.includes("inbox") ||
      agent.includes("social") ||
      agent.includes("scraper") ||
      agent.includes("team_page") ||
      agent.includes("icp_auto") ||
      // SDR draft uses scraped research; check the brief.
      agent.includes("sdr_agent") ||
      // Catch-all executor steps that pulled in tool results
      agent.includes("executor")
    );
  }

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorResult | null> {
    const haystack = stringifyForEval(ctx.inputs);
    if (!haystack) return null;

    const hits: string[] = [];
    for (const { re, label } of INJECTION_PATTERNS) {
      if (re.test(haystack)) hits.push(label);
    }

    if (hits.length === 0) {
      return { key: this.key, score: 1, value: "clean" };
    }

    const severity = hits.length >= 2 ? 0 : 0.4;
    return {
      key: this.key,
      score: severity,
      value: severity === 0 ? "high_risk" : "suspicious",
      comment: `Prompt-injection patterns matched in agent inputs: ${hits.join(", ")}`,
    };
  }
}
