import { Injectable } from "@nestjs/common";
import { Evaluator, EvaluatorContext, EvaluatorResult } from "./evaluator.interface";
import { ToolRegistry, REGISTRABLE_TOOL_NAMES } from "../../runtime/tools/registry";
import { Tool, ToolParameter } from "../../runtime/tools/tool.interface";

/**
 * Tool-use correctness evaluator (code-based, no LLM judge).
 *
 * The single highest-signal evaluator for our failure mode: agents hallucinate
 * tool names, call tools that aren't whitelisted for their template, or pass
 * malformed arguments that don't satisfy the tool's declared parameter schema.
 *
 * Scoring — average of up to three sub-scores; skips dimensions with no data:
 *   1. Existence  — fraction of called tool names that exist in REGISTRABLE_TOOL_NAMES
 *   2. Whitelist  — fraction of calls allowed by the agent's template (skipped
 *                   when the agent tag doesn't map to a known template)
 *   3. Arg shape  — fraction of calls whose JSON-parsed arguments satisfy the
 *                   tool's declared `required` parameters and basic type shape
 *
 * Skipped (returns null) when the run produced zero tool calls (LLM-only).
 * Never throws — any unexpected shape falls through to `null`.
 */
@Injectable()
export class ToolUseCorrectnessEvaluator implements Evaluator {
  readonly key = "tool_use_correctness";

  private registry: ToolRegistry | null = null;

  private getRegistry(): ToolRegistry {
    // Lazy-construct so module load cost is zero. Templates are the source of
    // truth — no DI services needed for tool list + per-template whitelist.
    if (!this.registry) {
      this.registry = new ToolRegistry();
    }
    return this.registry;
  }

  appliesTo(ctx: EvaluatorContext): boolean {
    return extractToolCalls(ctx.outputs).length > 0;
  }

  async evaluate(ctx: EvaluatorContext): Promise<EvaluatorResult | null> {
    const calls = extractToolCalls(ctx.outputs);
    if (calls.length === 0) return null;

    const registry = this.getRegistry();
    const allowedNames = this.resolveAllowedToolNames(registry, ctx);

    let existenceOk = 0;
    let whitelistOk = 0;
    let argShapeOk = 0;
    let whitelistApplied = 0;
    const details: string[] = [];

    for (const call of calls) {
      const name = call.name;
      const tool = registry.get(name);
      const exists = REGISTRABLE_TOOL_NAMES.has(name);
      if (exists) existenceOk += 1;

      let whitelistMark = "";
      if (allowedNames) {
        whitelistApplied += 1;
        if (allowedNames.has(name)) {
          whitelistOk += 1;
        } else {
          whitelistMark = `(not whitelisted)`;
        }
      }

      let argMark = "";
      if (tool) {
        const argsOk = validateArgs(tool, call.argumentsRaw);
        if (argsOk) argShapeOk += 1;
        else argMark = "(bad args)";
      }
      // When the tool doesn't exist we don't penalise arg shape twice —
      // existence already scored 0; arg-shape dimension simply doesn't apply
      // to that call.

      details.push(
        `${name} ${exists ? "ok" : "hallucinated"}${whitelistMark ? " " + whitelistMark : ""}${argMark ? " " + argMark : ""}`.trim(),
      );
    }

    const subScores: number[] = [];
    subScores.push(existenceOk / calls.length);
    if (whitelistApplied > 0) subScores.push(whitelistOk / whitelistApplied);
    // Arg-shape denominator excludes hallucinated tools (no schema to check).
    const argShapeDenominator = calls.filter((c) => REGISTRABLE_TOOL_NAMES.has(c.name)).length;
    if (argShapeDenominator > 0) subScores.push(argShapeOk / argShapeDenominator);

    const score = subScores.reduce((a, b) => a + b, 0) / subScores.length;
    const value = score >= 0.999 ? "all_valid" : score >= 0.5 ? "partial" : "invalid_use";

    return {
      key: this.key,
      score,
      value,
      comment: `tool calls: [${details.join(", ")}]`,
    };
  }

  /**
   * Map the run's agent tag (e.g. "sdr_agent.draft_message" or "SDR Agent.step")
   * to the template's allowed-tool whitelist. Returns null when no template can
   * be resolved — the whitelist dimension is then skipped (not penalised).
   */
  private resolveAllowedToolNames(
    registry: ToolRegistry,
    ctx: EvaluatorContext,
  ): ReadonlySet<string> | null {
    const candidates: string[] = [];
    if (ctx.agent) {
      candidates.push(ctx.agent);
      // Strip ".node" suffix (e.g. "sdr_agent.draft_message" → "sdr_agent")
      const dot = ctx.agent.indexOf(".");
      if (dot > 0) candidates.push(ctx.agent.slice(0, dot));
    }
    // Tag form: "agent:sdr_agent.draft_message"
    for (const tag of ctx.tags ?? []) {
      if (tag.startsWith("agent:")) {
        const rest = tag.slice("agent:".length);
        candidates.push(rest);
        const dot = rest.indexOf(".");
        if (dot > 0) candidates.push(rest.slice(0, dot));
      }
    }

    for (const raw of candidates) {
      const variants = templateNameVariants(raw);
      for (const v of variants) {
        const allowed = registry.getAllowedToolNames(v);
        if (allowed) return new Set(allowed);
      }
    }
    return null;
  }
}

interface ExtractedToolCall {
  readonly name: string;
  readonly argumentsRaw: string;
}

/**
 * Locate tool calls in the run output. The runner is invoked with the raw
 * `LLMResponse` (see langsmith.service.ts fireEvaluators), which has
 * `toolCalls?: ToolCallMessage[]` of shape
 *   `{ id, type: "function", function: { name, arguments: string } }`.
 *
 * Defensive: accepts both camelCase and snake_case forms and silently drops
 * anything that doesn't match.
 */
function extractToolCalls(outputs: unknown): ExtractedToolCall[] {
  if (!outputs || typeof outputs !== "object") return [];
  const obj = outputs as Record<string, unknown>;
  const raw = (obj.toolCalls ?? obj.tool_calls) as unknown;
  if (!Array.isArray(raw)) return [];

  const out: ExtractedToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const fn = e.function;
    if (!fn || typeof fn !== "object") continue;
    const f = fn as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name : undefined;
    if (!name) continue;
    const argumentsRaw = typeof f.arguments === "string" ? f.arguments : "";
    out.push({ name, argumentsRaw });
  }
  return out;
}

/**
 * Validate that the JSON-parsed arguments satisfy:
 *   - argumentsRaw is valid JSON object
 *   - every `required: true` parameter is present
 *   - declared parameters have the expected primitive type (best-effort)
 *
 * Returns false on any failure; never throws.
 */
function validateArgs(tool: Tool, argumentsRaw: string): boolean {
  let parsed: unknown;
  try {
    parsed = argumentsRaw.length === 0 ? {} : JSON.parse(argumentsRaw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const args = parsed as Record<string, unknown>;

  for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
    const value = args[paramName];
    if (paramDef.required && (value === undefined || value === null)) {
      return false;
    }
    if (value !== undefined && value !== null && !matchesType(value, paramDef)) {
      return false;
    }
  }
  return true;
}

function matchesType(value: unknown, param: ToolParameter): boolean {
  switch (param.type) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number" && !Number.isNaN(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    default:
      // Unknown declared type — accept anything rather than false-positive.
      return true;
  }
}

/**
 * Produce candidate template-name lookup keys. ToolRegistry keys its map by
 * `template.name.toLowerCase()` (e.g. "sdr agent", "seo agent"), but agent
 * tags use slug-style identifiers ("sdr_agent", "seo_agent"). Try both.
 */
function templateNameVariants(raw: string): string[] {
  const lower = raw.toLowerCase();
  const variants = new Set<string>([lower]);
  variants.add(lower.replace(/_/g, " "));
  variants.add(lower.replace(/-/g, " "));
  return Array.from(variants);
}
