import { describe, it, expect, beforeEach, vi } from "vitest";
import { LLMService } from "../llm.service";

describe("LLMService", () => {
  let llm: LLMService;

  beforeEach(() => {
    // Ensure no API key so we get mock responses
    delete process.env.OPENAI_API_KEY;
    llm = new LLMService();
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
});
