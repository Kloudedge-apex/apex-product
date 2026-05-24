import { describe, it, expect, beforeEach } from "vitest";
import { ToolUseCorrectnessEvaluator } from "../tool-use-correctness.evaluator";
import type { EvaluatorContext } from "../evaluator.interface";

/**
 * Pins the contract that ToolUseCorrectnessEvaluator scores three dimensions:
 * existence (against REGISTRABLE_TOOL_NAMES), whitelist (against the template's
 * availableTools), and arg-shape (against the tool's declared parameters).
 * The runner expects 0..1 scores and a categorical value of
 * `all_valid` | `partial` | `invalid_use`.
 */
describe("ToolUseCorrectnessEvaluator", () => {
  let evaluator: ToolUseCorrectnessEvaluator;

  beforeEach(() => {
    evaluator = new ToolUseCorrectnessEvaluator();
  });

  function ctx(overrides: Partial<EvaluatorContext>): EvaluatorContext {
    return {
      runId: "run-1",
      model: "gpt-4o-mini",
      inputs: {},
      outputs: {},
      ...overrides,
    };
  }

  function toolCall(name: string, args: Record<string, unknown>): {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  } {
    return {
      id: `call_${name}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  it("scores 1 when all tool calls exist, are whitelisted, and have valid args", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "sdr_agent.draft_message",
        tags: ["agent:sdr_agent.draft_message"],
        outputs: {
          toolCalls: [
            toolCall("web_search", { query: "acme corp funding" }),
            toolCall("hubspot", { action: "search_contacts", data: { email: "x@acme.com" } }),
          ],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.key).toBe("tool_use_correctness");
    expect(result!.score).toBe(1);
    expect(result!.value).toBe("all_valid");
  });

  it("scores < 1 when a hallucinated tool name is called", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "sdr_agent",
        tags: ["agent:sdr_agent"],
        outputs: {
          toolCalls: [
            toolCall("web_search", { query: "x" }),
            toolCall("not_a_real_tool", { foo: "bar" }),
          ],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(1);
    expect(result!.comment).toContain("hallucinated");
  });

  it("scores < 1 when a tool is called that isn't whitelisted for the template (seo_agent calling send_email)", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "seo_agent.step",
        tags: ["agent:seo_agent.step"],
        outputs: {
          toolCalls: [
            // web_search IS in seo-agent's whitelist
            toolCall("web_search", { query: "keyword research" }),
            // send_email is registrable but NOT in seo-agent's whitelist
            toolCall("send_email", { to: "x@y.com", subject: "s", body: "b" }),
          ],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(1);
    expect(result!.comment).toContain("not whitelisted");
  });

  it("scores < 1 when arg shape is malformed (missing required param)", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "sdr_agent",
        tags: ["agent:sdr_agent"],
        outputs: {
          toolCalls: [
            // web_search.query is required — omit it
            toolCall("web_search", { max_results: 5 }),
          ],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(1);
    expect(result!.comment).toContain("bad args");
  });

  it("scores < 1 when arguments aren't valid JSON", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "sdr_agent",
        outputs: {
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "web_search", arguments: "{ not json" },
            },
          ],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(1);
  });

  it("returns null (skips gracefully) when the run produced no tool calls", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "sdr_agent",
        outputs: { content: "hello world", toolCalls: [] },
      }),
    );
    expect(result).toBeNull();
  });

  it("appliesTo returns false for LLM-only runs", () => {
    expect(
      evaluator.appliesTo(ctx({ outputs: { content: "hello" } })),
    ).toBe(false);
  });

  it("appliesTo returns true when outputs contain at least one tool call", () => {
    expect(
      evaluator.appliesTo(
        ctx({
          outputs: { toolCalls: [toolCall("web_search", { query: "x" })] },
        }),
      ),
    ).toBe(true);
  });

  it("skips the whitelist dimension when the agent doesn't map to a known template", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "unknown_mystery_agent.do_thing",
        outputs: {
          toolCalls: [toolCall("web_search", { query: "x" })],
        },
      }),
    );
    expect(result).not.toBeNull();
    // With no whitelist applied, score is the average of (existence=1, arg_shape=1) = 1
    expect(result!.score).toBe(1);
    expect(result!.value).toBe("all_valid");
  });

  it("never throws on unexpected output shapes", async () => {
    const r1 = await evaluator.evaluate(ctx({ outputs: null }));
    expect(r1).toBeNull();
    const r2 = await evaluator.evaluate(ctx({ outputs: "just a string" }));
    expect(r2).toBeNull();
    const r3 = await evaluator.evaluate(
      ctx({ outputs: { toolCalls: "not an array" } }),
    );
    expect(r3).toBeNull();
  });

  it("supports snake_case `tool_calls` output shape", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "sdr_agent",
        outputs: {
          tool_calls: [toolCall("web_search", { query: "x" })],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1);
  });

  it("labels score below 0.5 as invalid_use", async () => {
    const result = await evaluator.evaluate(
      ctx({
        agent: "sdr_agent",
        outputs: {
          toolCalls: [
            toolCall("hallucinated_1", {}),
            toolCall("hallucinated_2", {}),
          ],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.score).toBeLessThan(0.5);
    expect(result!.value).toBe("invalid_use");
  });
});
