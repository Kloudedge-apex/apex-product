import { describe, it, expect, vi } from "vitest";
import {
  extractJsonFromMarkdown,
  parseJsonResponse,
  chatJsonWithRetry,
  type LlmChatLike,
  type ShapeGuard,
} from "../json-output.util";
import type { LLMResponse } from "../../runtime/llm.service";

// A representative target shape for the parse tests — mirrors the kind of
// object the ICP extractor returns.
interface Sample {
  name: string;
  tags: string[];
}

const isSample: ShapeGuard<Sample> = (v): v is Sample => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.name !== "string") return false;
  if (!Array.isArray(obj.tags) || !obj.tags.every((t) => typeof t === "string")) {
    return false;
  }
  return true;
};

describe("extractJsonFromMarkdown", () => {
  it("strips ```json fences", () => {
    expect(extractJsonFromMarkdown('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips bare ``` fences", () => {
    expect(extractJsonFromMarkdown('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("returns input unchanged when there is no fence", () => {
    expect(extractJsonFromMarkdown('{"a":1}')).toBe('{"a":1}');
  });

  it("handles empty / whitespace input", () => {
    expect(extractJsonFromMarkdown("")).toBe("");
    expect(extractJsonFromMarkdown("   ")).toBe("");
  });
});

describe("parseJsonResponse", () => {
  it("parses valid JSON that matches the schema", () => {
    const result = parseJsonResponse('{"name":"acme","tags":["a","b"]}', isSample);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("acme");
      expect(result.data.tags).toEqual(["a", "b"]);
    }
  });

  it("extracts JSON from a ```json fence", () => {
    const wrapped = '```json\n{"name":"acme","tags":[]}\n```';
    const result = parseJsonResponse(wrapped, isSample);
    expect(result.ok).toBe(true);
  });

  it("recovers from leading prose by extracting the first {...} block", () => {
    const messy = 'Sure, here you go: {"name":"acme","tags":["x"]} cheers';
    const result = parseJsonResponse(messy, isSample);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.name).toBe("acme");
  });

  it("returns ok:false with an error message on malformed JSON", () => {
    const result = parseJsonResponse("{not valid json", isSample);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain("json");
  });

  it("returns ok:false when JSON parses but does not match the schema", () => {
    const result = parseJsonResponse('{"name":42,"tags":["a"]}', isSample);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/schema/i);
  });

  it("returns ok:false on empty input", () => {
    const result = parseJsonResponse("", isSample);
    expect(result.ok).toBe(false);
  });
});

// Helper for the retry tests: builds a fake LLM that returns the given
// content strings in order. Each call consumes one entry from the queue.
function makeFakeLlm(contents: string[]): {
  llm: LlmChatLike;
  calls: { messageCount: number }[];
} {
  const calls: { messageCount: number }[] = [];
  const queue = [...contents];
  const llm: LlmChatLike = {
    chat: vi.fn(async (messages) => {
      calls.push({ messageCount: messages.length });
      const content = queue.shift() ?? "";
      const resp: LLMResponse = {
        content,
        tokensUsed: 0,
        model: "fake",
        cost: 0,
      };
      return resp;
    }),
  };
  return { llm, calls };
}

describe("chatJsonWithRetry", () => {
  it("returns parsed data on the first successful attempt (no retry)", async () => {
    const { llm, calls } = makeFakeLlm(['{"name":"acme","tags":[]}']);
    const onRetry = vi.fn();
    const result = await chatJsonWithRetry<Sample>(llm, {
      messages: [{ role: "user", content: "go" }],
      guard: isSample,
      schemaDescription: "Sample",
      onRetry,
    });
    expect(result).not.toBeNull();
    expect(result?.name).toBe("acme");
    expect(calls).toHaveLength(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries once when the first response is malformed and succeeds on the second", async () => {
    const { llm, calls } = makeFakeLlm([
      "not even close to json",
      '{"name":"acme","tags":["x"]}',
    ]);
    const onRetry = vi.fn();
    const onFailure = vi.fn();

    const result = await chatJsonWithRetry<Sample>(llm, {
      messages: [{ role: "user", content: "go" }],
      guard: isSample,
      schemaDescription: "Sample",
      onRetry,
      onFailure,
    });

    expect(result).not.toBeNull();
    expect(result?.name).toBe("acme");
    expect(calls).toHaveLength(2);
    // Retry should include the original turns + assistant echo + system nudge.
    expect(calls[1]!.messageCount).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("returns null when both attempts fail (does not throw)", async () => {
    const { llm, calls } = makeFakeLlm(["garbage", "still garbage"]);
    const onRetry = vi.fn();
    const onFailure = vi.fn();

    const result = await chatJsonWithRetry<Sample>(llm, {
      messages: [{ role: "user", content: "go" }],
      guard: isSample,
      schemaDescription: "Sample",
      onRetry,
      onFailure,
    });

    expect(result).toBeNull();
    expect(calls).toHaveLength(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("retries when the first response parses but fails the shape guard", async () => {
    const { llm, calls } = makeFakeLlm([
      '{"name":42,"tags":[]}', // wrong type for name
      '{"name":"acme","tags":["a"]}',
    ]);

    const result = await chatJsonWithRetry<Sample>(llm, {
      messages: [{ role: "user", content: "go" }],
      guard: isSample,
      schemaDescription: "Sample",
    });

    expect(result).not.toBeNull();
    expect(calls).toHaveLength(2);
  });
});
