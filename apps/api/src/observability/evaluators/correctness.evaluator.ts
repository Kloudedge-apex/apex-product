import { Injectable } from "@nestjs/common";
import { Evaluator, EvaluatorContext, EvaluatorResult, stringifyForEval } from "./evaluator.interface";

/**
 * Correctness evaluator — only runs when ground truth is supplied via
 * EvaluatorContext.groundTruth. Computes:
 *   - exact JSON deep-equality → score 1
 *   - structural overlap (shared keys + value matches) → score in (0, 1)
 *   - no overlap → score 0
 *
 * Use this for offline dataset evaluation (icp_auto_extractor, team_page_extractor,
 * inbox_monitor, reporting_agent — agents whose outputs have deterministic ground truth).
 */
@Injectable()
export class CorrectnessEvaluator implements Evaluator {
  readonly key = "correctness";

  appliesTo(ctx: EvaluatorContext): boolean {
    return ctx.groundTruth !== undefined && ctx.groundTruth !== null;
  }

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorResult | null> {
    if (ctx.groundTruth === undefined || ctx.groundTruth === null) return null;

    const expected = parseMaybeJson(ctx.groundTruth);
    const actual = parseMaybeJson(ctx.outputs);

    if (deepEqual(expected, actual)) {
      return { key: this.key, score: 1, value: "exact_match" };
    }

    // Structural similarity for object outputs
    if (typeof expected === "object" && typeof actual === "object" && expected !== null && actual !== null) {
      const overlap = jaccardObjects(expected as Record<string, unknown>, actual as Record<string, unknown>);
      if (overlap >= 0.99) return { key: this.key, score: 1, value: "exact_match" };
      if (overlap > 0) {
        return {
          key: this.key,
          score: overlap,
          value: "partial_match",
          comment: `Structural overlap ${(overlap * 100).toFixed(0)}%`,
        };
      }
    }

    // String similarity fallback
    const expStr = stringifyForEval(expected, 2000);
    const actStr = stringifyForEval(actual, 2000);
    if (expStr && actStr && expStr.toLowerCase() === actStr.toLowerCase()) {
      return { key: this.key, score: 1, value: "exact_match_string" };
    }

    return { key: this.key, score: 0, value: "mismatch", comment: "Output did not match ground truth" };
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((k, i) => k === bKeys[i])) return false;
    return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function jaccardObjects(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aKeys = Object.keys(a);
  const bKeys = new Set(Object.keys(b));
  if (aKeys.length === 0 && bKeys.size === 0) return 1;
  const shared = aKeys.filter((k) => bKeys.has(k));
  if (shared.length === 0) return 0;
  const matching = shared.filter((k) => deepEqual(a[k], b[k]));
  const union = new Set([...aKeys, ...bKeys]).size;
  return matching.length / union;
}
