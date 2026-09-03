import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { LLMService } from "../llm.service";

const PROVIDER_ENV_KEYS = [
  "NODE_ENV",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_FAST_DEPLOYMENT",
  "AZURE_OPENAI_DEPLOYMENT",
  "ANTHROPIC_API_KEY",
] as const;

let originalProviderEnv: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>>;
const ORIGINAL_FETCH = globalThis.fetch;

describe("LLMService", () => {
  let llm: LLMService;

  beforeEach(() => {
    originalProviderEnv = {};
    for (const key of PROVIDER_ENV_KEYS) {
      if (process.env[key] !== undefined) originalProviderEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "test";
    // Ensure no API key so we get mock responses
    llm = new LLMService();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const key of PROVIDER_ENV_KEYS) {
      const original = originalProviderEnv[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  describe("chat (mock mode)", () => {
    it("should return a mock response when no API key", async () => {
      const response = await llm.chat([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ]);

      expect(response.content).toBeDefined();
      expect(response.tokensUsed).toBeGreaterThan(0);
      expect(response.model).toContain("mock");
      expect(response.cost).toBeGreaterThanOrEqual(0);
    });

    it("should generate SDR-themed content for SDR system prompts", async () => {
      const response = await llm.chat([
        { role: "system", content: "You are an SDR agent for sales outreach." },
        { role: "user", content: "Research and email prospect." },
      ]);

      const parsed = JSON.parse(response.content);
      expect(parsed.type).toBe("email_draft");
      expect(parsed.to).toBeDefined();
    });

    it("should generate content-themed response for content writer prompts", async () => {
      const response = await llm.chat([
        { role: "system", content: "You are a content writer agent." },
        { role: "user", content: "Write a blog post." },
      ]);

      const parsed = JSON.parse(response.content);
      expect(parsed.type).toBe("content");
    });

    it("should generate report response for reporting prompts", async () => {
      const response = await llm.chat([
        { role: "system", content: "You are a reporting agent." },
        { role: "user", content: "Generate weekly report." },
      ]);

      const parsed = JSON.parse(response.content);
      expect(parsed.type).toBe("report");
    });

    it("should simulate tool calls when tools are provided", async () => {
      const tools = [{
        type: "function" as const,
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object" as const,
            properties: { query: { type: "string", description: "Search query" } },
            required: ["query"],
          },
        },
      }];

      const response = await llm.chat(
        [
          { role: "system", content: "You are a content writer agent." },
          { role: "user", content: "Write content." },
        ],
        { tools },
      );

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls?.length).toBeGreaterThan(0);
      expect(response.finishReason).toBe("tool_calls");
    });

    it("should return final answer after tool results are provided", async () => {
      const tools = [{
        type: "function" as const,
        function: {
          name: "web_search",
          description: "Search",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
      }];

      // Simulate a conversation with tool call + result
      const messages = [
        { role: "system" as const, content: "You are a content writer." },
        { role: "user" as const, content: "Write." },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [{ id: "call_1", type: "function" as const, function: { name: "web_search", arguments: "{}" } }],
        },
        { role: "tool" as const, content: JSON.stringify({ results: [] }), tool_call_id: "call_1" },
      ];

      // After one tool call done, next should continue the sequence or give final answer
      const response = await llm.chat(messages, { tools });

      // Should eventually give a final answer or next tool call
      expect(response.content !== undefined || response.toolCalls !== undefined).toBe(true);
    });

    it("should respect plan-based token limits", () => {
      expect(llm.getTokenLimit("TRIAL")).toBe(5000);
      expect(llm.getTokenLimit("STARTER")).toBe(10000);
      expect(llm.getTokenLimit("GROWTH")).toBe(50000);
      expect(llm.getTokenLimit("ENTERPRISE")).toBe(Infinity);
      expect(llm.getTokenLimit("UNKNOWN")).toBe(5000); // fallback to TRIAL
    });
  });

  describe("production provider readiness", () => {
    it("sends top_p 0.9 by default to the model provider", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { total_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await new LLMService().chat([{ role: "user", content: "hello" }]);

      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        top_p: 0.9,
      });
    });

    it("rejects production startup without an OpenAI-compatible provider", () => {
      process.env.NODE_ENV = "production";
      process.env.ANTHROPIC_API_KEY = "anthropic-only";

      expect(() => new LLMService()).toThrow(/complete OpenAI-compatible provider/);
    });

    it("accepts a complete Azure OpenAI provider", () => {
      process.env.NODE_ENV = "production";
      process.env.AZURE_OPENAI_KEY = "azure-key";
      process.env.AZURE_OPENAI_ENDPOINT = "https://example.openai.azure.com";
      process.env.AZURE_OPENAI_FAST_DEPLOYMENT = "gpt-4o-mini";
      process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o";

      expect(() => new LLMService()).not.toThrow();
    });
  });
});
