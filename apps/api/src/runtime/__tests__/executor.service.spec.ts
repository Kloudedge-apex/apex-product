import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExecutorService } from "../executor.service";
import { LLMService } from "../llm.service";
import { MemoryService } from "../memory.service";
import { PrismaService } from "../../prisma/prisma.service";
import { IntegrationsService } from "../../integrations/integrations.service";
import { OutreachArtifactsService } from "../../outreach/outreach-artifacts.service";
import { ConfigService } from "@nestjs/config";

// Mock PrismaService
function createMockPrisma() {
  return {
    agent: {
      findUnique: vi.fn(),
    },
    agentRun: {
      findUnique: vi.fn().mockResolvedValue(null),
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
    outreachArtifact: {
      findMany: vi.fn().mockResolvedValue([]),
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
      { get: vi.fn().mockReturnValue(undefined) } as unknown as ConfigService,
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

  it("should reject tool calls outside the per-template whitelist (Reply Handler must not hubspot)", async () => {
    // SEO Agent template — whitelist is web_search/web_scrape/company_research/memory.
    // No send_email, no hubspot. If the LLM hallucinates send_email, the
    // executor must reject the call without invoking the tool.
    const seoAgent = {
      ...mockAgent,
      template: { ...mockAgent.template, name: "SEO Agent" },
    };
    (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(seoAgent);

    const chatMock = mockLLM.chat as ReturnType<typeof vi.fn>;

    // Step 1: LLM calls send_email (out of whitelist for SEO Agent)
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 50,
      model: "gpt-4o-mini-mock",
      cost: 0.0005,
      toolCalls: [{
        id: "call_1",
        type: "function" as const,
        function: { name: "send_email", arguments: JSON.stringify({ to: "x@y.com" }) },
      }],
      finishReason: "tool_calls",
    });

    // Step 2: after rejection, LLM picks a real whitelisted tool
    chatMock.mockResolvedValueOnce({
      content: "",
      tokensUsed: 50,
      model: "gpt-4o-mini-mock",
      cost: 0.0005,
      toolCalls: [{
        id: "call_2",
        type: "function" as const,
        function: { name: "web_search", arguments: JSON.stringify({ query: "seo keyword" }) },
      }],
      finishReason: "tool_calls",
    });

    // Step 3: final answer
    chatMock.mockResolvedValueOnce({
      content: JSON.stringify({ type: "seo_research", keywords: [] }),
      tokensUsed: 80,
      model: "gpt-4o-mini-mock",
      cost: 0.001,
      finishReason: "stop",
    });

    const result = await executor.executeAgent("agent_1", "run_1");

    // The rejected send_email should appear as a tool_result with
    // tool_not_whitelisted: true, and the actual SendEmailTool should never
    // have executed (we don't have a direct spy here, but the log assertion
    // proves the rejection path was taken).
    const logCalls = (mockPrisma.agentLog.create as ReturnType<typeof vi.fn>).mock.calls;
    const mentionsRejection = logCalls.some((call) => {
      const arg = call[0] as { data?: { message?: unknown } };
      const msg = arg.data?.message;
      return typeof msg === "string" && msg.includes("tool_not_whitelisted") && msg.includes("send_email");
    });
    expect(mentionsRejection).toBe(true);

    const rejectionStep = result.steps.find(
      (s) =>
        s.type === "tool_result" &&
        s.toolName === "send_email" &&
        (s.toolOutput as { tool_not_whitelisted?: boolean })?.tool_not_whitelisted === true,
    );
    expect(rejectionStep).toBeDefined();
  });

  // ── Model resolution from template config ────────────────────────────────
  // These tests pin the contract that ExecutorService reads model selection
  // from `agent.template.defaultConfig.{model,fastModel}` and falls back to
  // env / hardcoded defaults only when those fields are absent.
  describe("model resolution", () => {
    /**
     * Stub a one-shot LLM exchange (final answer, no tool calls). Returns the
     * chat mock so the caller can assert on its arguments.
     */
    function stubFinalAnswer(): ReturnType<typeof vi.fn> {
      const chatMock = mockLLM.chat as ReturnType<typeof vi.fn>;
      chatMock.mockResolvedValue({
        content: JSON.stringify({ type: "result" }),
        tokensUsed: 10,
        model: "stub",
        cost: 0,
        finishReason: "stop",
      });
      return chatMock;
    }

    function buildAgent(opts: {
      templateName: string;
      defaultConfig: Record<string, unknown>;
    }) {
      return {
        ...mockAgent,
        template: {
          ...mockAgent.template,
          name: opts.templateName,
          defaultConfig: opts.defaultConfig,
        },
      };
    }

    it("isComplex=true template uses template.model", async () => {
      // SDR Agent is in the complex-task list.
      (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        buildAgent({
          templateName: "SDR Agent",
          defaultConfig: { model: "gpt-4o-custom", fastModel: "ignored" },
        }),
      );
      const chatMock = stubFinalAnswer();

      const result = await executor.executeAgent("agent_1", "run_1");

      expect(result.model).toBe("gpt-4o-custom");
      // Every chat call should have been issued with the complex model
      for (const call of chatMock.mock.calls) {
        const opts = call[1] as { model?: string } | undefined;
        expect(opts?.model).toBe("gpt-4o-custom");
      }
    });

    it("isComplex=false template uses template.fastModel", async () => {
      // Content Writer is NOT in the complex-task list, so it picks fastModel.
      (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        buildAgent({
          templateName: "Content Writer",
          defaultConfig: { model: "ignored-complex", fastModel: "gpt-4o-fast-custom" },
        }),
      );
      const chatMock = stubFinalAnswer();

      const result = await executor.executeAgent("agent_1", "run_1");

      expect(result.model).toBe("gpt-4o-fast-custom");
      for (const call of chatMock.mock.calls) {
        const opts = call[1] as { model?: string } | undefined;
        expect(opts?.model).toBe("gpt-4o-fast-custom");
      }
    });

    it("absent template.model falls back to default (gpt-4o) for complex tasks", async () => {
      const prevDefault = process.env.DEFAULT_MODEL;
      delete process.env.DEFAULT_MODEL;
      try {
        (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
          buildAgent({ templateName: "SDR Agent", defaultConfig: {} }),
        );
        stubFinalAnswer();

        const result = await executor.executeAgent("agent_1", "run_1");
        expect(result.model).toBe("gpt-4o");
      } finally {
        if (prevDefault !== undefined) process.env.DEFAULT_MODEL = prevDefault;
      }
    });

    it("absent template.fastModel falls back to default (gpt-4o-mini) for simple tasks", async () => {
      const prevMini = process.env.SYSTEM_MODEL_MINI;
      delete process.env.SYSTEM_MODEL_MINI;
      try {
        (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
          buildAgent({ templateName: "Content Writer", defaultConfig: {} }),
        );
        stubFinalAnswer();

        const result = await executor.executeAgent("agent_1", "run_1");
        expect(result.model).toBe("gpt-4o-mini");
      } finally {
        if (prevMini !== undefined) process.env.SYSTEM_MODEL_MINI = prevMini;
      }
    });

    it("env DEFAULT_MODEL overrides the hardcoded complex fallback", async () => {
      const prev = process.env.DEFAULT_MODEL;
      process.env.DEFAULT_MODEL = "gpt-5-via-env";
      try {
        (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
          buildAgent({ templateName: "SDR Agent", defaultConfig: {} }),
        );
        stubFinalAnswer();

        const result = await executor.executeAgent("agent_1", "run_1");
        expect(result.model).toBe("gpt-5-via-env");
      } finally {
        if (prev === undefined) delete process.env.DEFAULT_MODEL;
        else process.env.DEFAULT_MODEL = prev;
      }
    });

    it("env SYSTEM_MODEL_MINI overrides the hardcoded simple fallback", async () => {
      const prev = process.env.SYSTEM_MODEL_MINI;
      process.env.SYSTEM_MODEL_MINI = "gpt-mini-via-env";
      try {
        (mockPrisma.agent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
          buildAgent({ templateName: "Content Writer", defaultConfig: {} }),
        );
        stubFinalAnswer();

        const result = await executor.executeAgent("agent_1", "run_1");
        expect(result.model).toBe("gpt-mini-via-env");
      } finally {
        if (prev === undefined) delete process.env.SYSTEM_MODEL_MINI;
        else process.env.SYSTEM_MODEL_MINI = prev;
      }
    });
  });

  // ── approvalEnvelopeForRun: UI-facing pending-review payload ───────────
  // Read path only — no executor loop. The method shells out to Prisma
  // via the same injected service the executor uses.
  describe("approvalEnvelopeForRun", () => {
    /**
     * Subclass that pins `graphRunIdForRun` to a fixed value, simulating
     * the future case where the executor knows which GraphRun owns the
     * AgentRun. The Phase-2.5 default returns null, which would short
     * the read to [] before any Prisma call.
     */
    class TestExecutor extends ExecutorService {
      constructor(
        prisma: PrismaService,
        llm: LLMService,
        memory: MemoryService,
        integrations: IntegrationsService,
        outreach: OutreachArtifactsService,
        private readonly graphRunOverride: string | null,
      ) {
        super(prisma, llm, memory, integrations, outreach);
      }
      protected override graphRunIdForRun(_runId: string): string | null {
        return this.graphRunOverride;
      }
    }

    function buildExecutor(graphRunOverride: string | null): ExecutorService {
      return new TestExecutor(
        mockPrisma as PrismaService,
        mockLLM as LLMService,
        mockMemory as MemoryService,
        mockIntegrations as IntegrationsService,
        createMockOutreachArtifacts(),
        graphRunOverride,
      );
    }

    it("returns one envelope per PENDING_REVIEW artifact with correct fields", async () => {
      (mockPrisma.agentRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run_1",
        orgId: "org_1",
      });
      const createdA = new Date("2026-05-20T10:00:00Z");
      const createdB = new Date("2026-05-20T10:05:00Z");
      (mockPrisma.outreachArtifact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: "art_a",
          channel: "EMAIL",
          recipientRef: "ceo@acme.com",
          subject: "Quick question on Q3",
          bodyText: "Hi Jane, " + "x".repeat(500),
          bodyHtml: "<p>Hi Jane</p>",
          toolName: "send_email",
          payload: { to: "ceo@acme.com", subject: "Quick question on Q3" },
          createdAt: createdA,
        },
        {
          id: "art_b",
          channel: "HUBSPOT_NOTE",
          recipientRef: "contact_42",
          subject: null,
          bodyText: "Note body",
          bodyHtml: null,
          toolName: "hubspot",
          payload: { contactId: "contact_42", note: "Note body" },
          createdAt: createdB,
        },
      ]);

      const exec = buildExecutor("graph_xyz");
      const envelopes = await exec.approvalEnvelopeForRun("run_1");

      expect(envelopes).toHaveLength(2);
      expect(envelopes[0]).toEqual({
        artifactId: "art_a",
        channel: "EMAIL",
        recipientRef: "ceo@acme.com",
        subject: "Quick question on Q3",
        previewText: ("Hi Jane, " + "x".repeat(500)).slice(0, 200),
        bodyHtml: "<p>Hi Jane</p>",
        toolName: "send_email",
        payload: { to: "ceo@acme.com", subject: "Quick question on Q3" },
        createdAt: createdA,
      });
      expect(envelopes[0].previewText.length).toBe(200);
      expect(envelopes[1].artifactId).toBe("art_b");
      expect(envelopes[1].subject).toBeNull();
      expect(envelopes[1].bodyHtml).toBeNull();
      expect(envelopes[1].previewText).toBe("Note body");

      // The Prisma read must be scoped by org AND status AND graphRunId —
      // otherwise we'd leak APPROVED/REJECTED rows or cross-tenant data.
      const findArgs = (mockPrisma.outreachArtifact.findMany as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0] as { where: Record<string, unknown> };
      expect(findArgs.where).toMatchObject({
        orgId: "org_1",
        graphRunId: "graph_xyz",
        status: "PENDING_REVIEW",
      });
    });

    it("returns [] when there are no PENDING_REVIEW artifacts", async () => {
      (mockPrisma.agentRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run_1",
        orgId: "org_1",
      });
      (mockPrisma.outreachArtifact.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const exec = buildExecutor("graph_xyz");
      const envelopes = await exec.approvalEnvelopeForRun("run_1");
      expect(envelopes).toEqual([]);
    });

    it("returns [] when the AgentRun does not exist (matches non-throwing read pattern)", async () => {
      (mockPrisma.agentRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const exec = buildExecutor("graph_xyz");
      const envelopes = await exec.approvalEnvelopeForRun("missing_run");
      expect(envelopes).toEqual([]);
      // Must short-circuit before hitting the artifact table.
      expect(mockPrisma.outreachArtifact.findMany).not.toHaveBeenCalled();
    });

    it("filters out APPROVED/REJECTED via the status=PENDING_REVIEW query", async () => {
      (mockPrisma.agentRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run_1",
        orgId: "org_1",
      });
      // The mock implementation does the filtering — emulate Prisma by
      // checking the `where.status` argument and only returning matching rows.
      (mockPrisma.outreachArtifact.findMany as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ where }: { where: { status: string } }) => {
          const all = [
            { id: "art_pending", status: "PENDING_REVIEW", channel: "EMAIL", recipientRef: null, subject: null, bodyText: "pending", bodyHtml: null, toolName: "send_email", payload: {}, createdAt: new Date() },
            { id: "art_approved", status: "APPROVED", channel: "EMAIL", recipientRef: null, subject: null, bodyText: "approved", bodyHtml: null, toolName: "send_email", payload: {}, createdAt: new Date() },
            { id: "art_rejected", status: "REJECTED", channel: "EMAIL", recipientRef: null, subject: null, bodyText: "rejected", bodyHtml: null, toolName: "send_email", payload: {}, createdAt: new Date() },
          ];
          return all.filter((a) => a.status === where.status);
        },
      );

      const exec = buildExecutor("graph_xyz");
      const envelopes = await exec.approvalEnvelopeForRun("run_1");

      expect(envelopes).toHaveLength(1);
      expect(envelopes[0].artifactId).toBe("art_pending");
    });

    it("returns [] when no GraphRun is linked (Phase 2.5 direct AgentRun)", async () => {
      (mockPrisma.agentRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "run_1",
        orgId: "org_1",
      });

      // Default executor with graphRunIdForRun -> null
      const envelopes = await executor.approvalEnvelopeForRun("run_1");
      expect(envelopes).toEqual([]);
      expect(mockPrisma.outreachArtifact.findMany).not.toHaveBeenCalled();
    });
  });
});
