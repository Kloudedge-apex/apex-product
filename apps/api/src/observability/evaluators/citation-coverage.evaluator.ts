import { Injectable } from "@nestjs/common";
import { Evaluator, EvaluatorContext, EvaluatorResult, stringifyForEval } from "./evaluator.interface";

/**
 * Citation coverage — for SDR drafts that should ground every concrete claim
 * in a fact_id from the research brief. Score = supported / total, where
 *  - total = number of fact-bearing sentences in the body
 *  - supported = sentences whose tokens overlap (≥0.3 Jaccard) with a cited
 *    fact's verbatim text from the brief
 * Sentences with no factual claims don't count (we don't penalize the opener
 * or the soft CTA for not citing anything).
 *
 * Inputs the evaluator needs:
 *  - ctx.outputs.body — the draft body (or fall back to `content`)
 *  - ctx.outputs.groundednessSelfCheck.citedFactIds — the model's own claim of which facts it used
 *  - ctx.inputs — the prompt messages array; we extract <fact id="..."> from the user msg
 *
 * If the brief XML isn't recoverable from inputs (or no fact-bearing sentences exist),
 * the evaluator returns null rather than scoring blindly.
 */

const FACT_BEARING_HINTS: readonly RegExp[] = [
  /\b(?:raised|funded|launched|hired|announced|partnered|acquired|joined)\b/i,
  /\b(?:employees|customers|users|revenue|ARR|MRR|headcount)\b/i,
  /\b(?:CEO|CTO|CFO|COO|VP|Director|Head of|Manager)\b/i,
  /\$[\d,.]+(?:M|B|K)?/,
  /\b(?:Series\s+[A-D])\b/i,
  /\b(?:Q[1-4]\s*20\d{2}|20\d{2})\b/, // years / quarters
];

const FACT_XML_RE = /<fact\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/fact>/g;

@Injectable()
export class CitationCoverageEvaluator implements Evaluator {
  readonly key = "citation_coverage";

  appliesTo(ctx: EvaluatorContext): boolean {
    const agent = (ctx.agent ?? "").toLowerCase();
    const tags = (ctx.tags ?? []).join(",").toLowerCase();
    if (!(agent.includes("sdr_agent.draft_message") || tags.includes("draft_message"))) {
      return false;
    }
    // Only meaningful when there's a body to score.
    const body = extractBody(ctx.outputs);
    return body.length >= 30;
  }

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorResult | null> {
    const body = extractBody(ctx.outputs);
    if (!body) return null;

    const facts = extractFacts(ctx.inputs);
    if (facts.size === 0) return null;

    const cited = new Set(extractCitedFactIds(ctx.outputs));
    const sentences = splitSentences(body);
    const factBearing = sentences.filter((s) => FACT_BEARING_HINTS.some((p) => p.test(s)));
    if (factBearing.length === 0) {
      return { key: this.key, score: 1, value: "no_claims", comment: "no fact-bearing sentences" };
    }

    let supported = 0;
    for (const sentence of factBearing) {
      const lower = sentence.toLowerCase();
      const supportFound = [...cited].some((id) => {
        const factText = facts.get(id);
        return factText ? tokenOverlap(lower, factText.toLowerCase()) >= 0.3 : false;
      });
      if (supportFound) supported += 1;
    }

    const score = supported / factBearing.length;
    return {
      key: this.key,
      score,
      value: score >= 0.7 ? "well_cited" : score >= 0.3 ? "partial" : "uncited",
      comment: `${supported}/${factBearing.length} factual sentences cite a brief fact_id (cited ids: ${
        cited.size === 0 ? "none" : [...cited].join(",")
      })`,
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
  return "";
}

function extractCitedFactIds(outputs: unknown): readonly string[] {
  if (!outputs || typeof outputs !== "object") return [];
  const obj = outputs as Record<string, unknown>;
  const sc =
    (obj.groundednessSelfCheck as Record<string, unknown> | undefined) ??
    (obj.groundedness_self_check as Record<string, unknown> | undefined);
  if (!sc) return [];
  const ids =
    (sc.citedFactIds as unknown) ?? (sc.cited_fact_ids as unknown);
  if (!Array.isArray(ids)) return [];
  return ids.filter((x): x is string => typeof x === "string");
}

function extractFacts(inputs: unknown): Map<string, string> {
  // Look at message `content` strings first so XML survives intact. Falling
  // back to JSON-stringify drops the matches because escaped quotes
  // (`id=\"F1\"`) don't match the unescaped-quote pattern.
  const map = new Map<string, string>();
  const haystacks: string[] = [];

  if (Array.isArray(inputs)) {
    for (const msg of inputs) {
      if (msg && typeof msg === "object") {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string") haystacks.push(content);
      }
    }
  } else if (typeof inputs === "string") {
    haystacks.push(inputs);
  }

  if (haystacks.length === 0) {
    haystacks.push(stringifyForEval(inputs, 12000));
  }

  for (const h of haystacks) {
    for (const m of h.matchAll(FACT_XML_RE)) {
      map.set(m[1], m[2].trim());
    }
  }
  return map;
}

function splitSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function tokenOverlap(a: string, b: string): number {
  const tokensA = tokenSet(a);
  const tokensB = tokenSet(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let inter = 0;
  for (const t of tokensA) if (tokensB.has(t)) inter += 1;
  const union = tokensA.size + tokensB.size - inter;
  return union === 0 ? 0 : inter / union;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "he", "her", "his", "how", "i", "in", "is", "it", "its", "of", "on",
  "or", "she", "that", "the", "their", "they", "this", "to", "was", "we", "were",
  "with", "you", "your", "our", "us",
]);

function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}
