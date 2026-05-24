import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExecutorService } from "../executor.service";
import { LLMService } from "../llm.service";
import { MemoryService } from "../memory.service";
import { PrismaService } from "../../prisma/prisma.service";
import { IntegrationsService } from "../../integrations/integrations.service";
import { OutreachArtifactsService } from "../../outreach/outreach-artifacts.service";

// Mock PrismaService
function createMockPrisma() {
  return {
    agent: {
      findUnique: vi.fn(),
    },
    agentLog: {
      create: vi.fn().mockResolvedValue({ id: "log_1" }),
    },
    runStep: {
      create: vi.fn().mockResolvedValue({ id: "step_1" }),
    },
    integration: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentMemory: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

function createMockLLM() {
  return {
    chat: vi.fn(),
  } as unknown as LLMService;
}

function createMockMemoryService() {
  return {
    getAll: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setLastRunSummary: vi.fn().mockResolvedValue(undefined),
    addContactedLead: vi.fn().mockResolvedValue(undefined),
    getContactedLeads: vi.fn().mockResolvedValue([]),
    searchSemantic: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryService;
}

function createMockIntegrationsService() {
  return {
    refreshTokenIfNeeded: vi.fn().mockResolvedValue(null),
  } as unknown as IntegrationsService;
}

function createMockOutreachArtifacts() {
  return {
    recordDryRun: vi.fn().mockResolvedValue(null),
  } as unknown as OutreachArtifactsService;
}

describe("ExecutorService", () => {
  let executor: ExecutorService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockLLM: ReturnType<typeof createMockLLM>;
  let mockMemory: ReturnType<typeof createMockMemoryService>;
  let mockIntegrations: ReturnType<typeof createMockIntegrationsService>;

  const mockAgent = {
    id: "agent_1",
    orgId: "org_1",
    name: "Test SDR Agent",
    domain: "SALES",
    config: { icp: { industry: "SaaS" }, emailTone: "professional" },
    template: {
      id: "tpl_1",
      name: "SDR Agent",
      domain: "SALES",
      defaultConfig: {},
    },
    org: {
      id: "org_1",
      name: "Test Org",
      plan: "TRIAL",
    },
  };

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    mockLLM = createMockLLM();
    mockMemory = createMockMemoryService();
    mockIntegrations = createMockIntegrationsService();

    (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockAgent);

    executor = new ExecutorService(
      mockPrisma as PrismaService,
      mockLLM as LLMService,
      mockMemory as MemoryService,
      mockIntegrations as IntegrationsService,
      createMockOutreachArtifacts(),
    );
  });

  it("should throw if agent not found", async () => {
    (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(executor.executeAgent("bad_id", "run_1")).rejects.toThrow("Agent not found");
  });

  it("should execute a simple agent run with no tool calls", async () => {
    // LLM returns a final answer directly (after forced tool calls)
    const chatMock = mockLLM.chat as ReturnType<typeof vi.fn>;

    // First call: forced tool call
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 100,
      model: "gpt-4o-mini-mock",
      cost: 0.001,
      toolCalls: [{
        id: "call_1",
        type: "function" as const,
        function: { name: "web_search", arguments: JSON.stringify({ query: "test company" }) },
      }],
      finishReason: "tool_calls",
    });

    // Second call: another tool call
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 100,
      model: "gpt-4o-mini-mock",
      cost: 0.001,
      toolCalls: [{
        id: "call_2",
        type: "function" as const,
        function: { name: "company_research", arguments: JSON.stringify({ company_name: "Test" }) },
      }],
      finishReason: "tool_calls",
    });

    // Third call: another tool
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 100,
      model: "gpt-4o-mini-mock",
      cost: 0.001,
      toolCalls: [{
        id: "call_3",
        type: "function" as const,
        function: { name: "lead_score", arguments: JSON.stringify({ lead: {} }) },
      }],
      finishReason: "tool_calls",
    });

    // Fourth call: final answer
    chatMock.mockResolvedValueOnce({
      content: JSON.stringify({ type: "email_draft", to: "test@example.com", subject: "Hello" }),
      tokensUsed: 200,
      model: "gpt-4o-mock",
      cost: 0.002,
      finishReason: "stop",
    });

    const result = await executor.executeAgent("agent_1", "run_1");

    expect(result.output).toBeDefined();
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThan(0);

    // Should have logged execution
    expect(mockPrisma.agentLog.create).toHaveBeenCalled();
  });

  it("should handle LLM returning a non-JSON final answer", async () => {
    const chatMock = mockLLM.chat as ReturnType<typeof vi.fn>;

    // Use a content writer template that requires fewer tool calls
    const contentAgent = {
      ...mockAgent,
      template: { ...mockAgent.template, name: "Content Writer" },
    };
    (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(contentAgent);

    // First: forced tool call
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 50,
      model: "gpt-4o-mini-mock",
      cost: 0.0005,
      toolCalls: [{
        id: "call_1",
        type: "function" as const,
        function: { name: "web_search", arguments: JSON.stringify({ query: "trending topics" }) },
      }],
      finishReason: "tool_calls",
    });

    // Second: forced tool call
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 50,
      model: "gpt-4o-mini-mock",
      cost: 0.0005,
      toolCalls: [{
        id: "call_2",
        type: "function" as const,
        function: { name: "web_scrape", arguments: JSON.stringify({ url: "https://example.com" }) },
      }],
      finishReason: "tool_calls",
    });

    // Third: non-JSON final answer
    chatMock.mockResolvedValueOnce({
      content: "Here is a great blog post about AI trends in 2026...",
      tokensUsed: 150,
      model: "gpt-4o-mini-mock",
      cost: 0.001,
      finishReason: "stop",
    });

    const result = await executor.executeAgent("agent_1", "run_1");

    expect(result.output.type).toBe("raw");
    expect(result.output.content).toContain("blog post");
  });

  it("should respect MAX_STEPS limit", async () => {
    const chatMock = mockLLM.chat as ReturnType<typeof vi.fn>;

    // Always return tool calls, never a final answer
    chatMock.mockResolvedValue({
      content: "",
      tokensUsed: 50,
      model: "gpt-4o-mini-mock",
      cost: 0.0005,
      toolCalls: [{
        id: `call_${Date.now()}`,
        type: "function" as const,
        function: { name: "web_search", arguments: JSON.stringify({ query: "test" }) },
      }],
      finishReason: "tool_calls",
    });

    const result = await executor.executeAgent("agent_1", "run_1");

    // Should stop after MAX_STEPS (10) iterations
    const toolCallSteps = result.steps.filter((s) => s.type === "tool_call");
    expect(toolCallSteps.length).toBeLessThanOrEqual(10);
  });

  it("should handle tool execution errors gracefully", async () => {
    const chatMock = mockLLM.chat as ReturnType<typeof vi.fn>;

    // First call: tool call with invalid tool name
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 50,
      model: "gpt-4o-mini-mock",
      cost: 0.0005,
      toolCalls: [{
        id: "call_1",
        type: "function" as const,
        function: { name: "nonexistent_tool", arguments: "{}" },
      }],
      finishReason: "tool_calls",
    });

    // Second: final answer
    chatMock.mockResolvedValueOnce({
      content: JSON.stringify({ type: "fallback", message: "completed with errors" }),
      tokensUsed: 100,
      model: "gpt-4o-mini-mock",
      cost: 0.001,
      finishReason: "stop",
    });

    const result = await executor.executeAgent("agent_1", "run_1");

    expect(result.output).toBeDefined();
    // Should have logged a warning/error mentioning the unknown tool.
    const logCalls = (mockPrisma.agentLog.create as ReturnType<typeof vi.fn>).mock.calls;
    const mentionsTool = logCalls.some((call) => {
      const arg = call[0] as { data?: { message?: unknown } };
      const msg = arg.data?.message;
      return typeof msg === "string" && msg.includes("nonexistent_tool");
    });
    expect(mentionsTool).toBe(true);
  });

  it("should track token costs correctly", async () => {
    const chatMock = mockLLM.chat as ReturnType<typeof vi.fn>;

    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 100,
      model: "gpt-4o-mini-mock",
      cost: 0.01,
      toolCalls: [{
        id: "call_1",
        type: "function" as const,
        function: { name: "web_search", arguments: JSON.stringify({ query: "test" }) },
      }],
      finishReason: "tool_calls",
    });

    chatMock.mockResolvedValueOnce({
      content: JSON.stringify({ type: "result" }),
      tokensUsed: 200,
      model: "gpt-4o-mini-mock",
      cost: 0.02,
      finishReason: "stop",
    });

    const result = await executor.executeAgent("agent_1", "run_1");

    expect(result.tokensUsed).toBe(300);
    expect(result.cost).toBeCloseTo(0.03);
  });
});
