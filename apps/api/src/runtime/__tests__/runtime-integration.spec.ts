import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RuntimeService } from "../runtime.service";
import { QueueService } from "../queue.service";
import { WorkerService } from "../worker.service";
import { ExecutorService } from "../executor.service";
import { LLMService } from "../llm.service";
import { MemoryService } from "../memory.service";
import { PrismaService } from "../../prisma/prisma.service";
import { IntegrationsService } from "../../integrations/integrations.service";

/**
 * Integration-level test for the runtime pipeline:
 * RuntimeService.triggerRun -> QueueService -> WorkerService -> ExecutorService
 */

function createMockPrisma() {
  const runs = new Map<string, any>();
  const logs: any[] = [];
  const steps: any[] = [];

  return {
    org: {
      findUnique: vi.fn().mockResolvedValue({ id: "org_1", plan: "TRIAL" }),
    },
    agent: {
      findUnique: vi.fn().mockResolvedValue({
        id: "agent_1",
        orgId: "org_1",
        name: "Test SDR",
        domain: "SALES",
        config: { icp: { industry: "SaaS" }, emailTone: "professional" },
        template: { id: "tpl_1", name: "SDR Agent", domain: "SALES", defaultConfig: {} },
        org: { id: "org_1", name: "Test Org", plan: "TRIAL" },
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentRun: {
      create: vi.fn().mockImplementation(({ data }) => {
        const run = { id: `run_${Date.now()}`, ...data, startedAt: new Date() };
        runs.set(run.id, run);
        return Promise.resolve(run);
      }),
      update: vi.fn().mockImplementation(({ where, data }) => {
        const run = runs.get(where.id) || { id: where.id };
        Object.assign(run, data);
        return Promise.resolve(run);
      }),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentLog: {
      create: vi.fn().mockImplementation(({ data }) => {
        logs.push(data);
        return Promise.resolve({ id: `log_${logs.length}`, ...data });
      }),
    },
    runStep: {
      create: vi.fn().mockImplementation(({ data }) => {
        steps.push(data);
        return Promise.resolve({ id: `step_${steps.length}`, ...data });
      }),
    },
    integration: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentMemory: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    _runs: runs,
    _logs: logs,
    _steps: steps,
  } as unknown as PrismaService & { _runs: Map<string, any>; _logs: any[]; _steps: any[] };
}

describe("Runtime Integration", () => {
  let runtimeService: RuntimeService;
  let queueService: QueueService;
  let workerService: WorkerService;
  let executorService: ExecutorService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    queueService = new QueueService();

    const llmService = new LLMService();
    const memoryService = new MemoryService(mockPrisma as PrismaService, llmService);
    const integrationsService = {
      refreshTokenIfNeeded: vi.fn().mockResolvedValue(null),
    } as unknown as IntegrationsService;

    executorService = new ExecutorService(
      mockPrisma as PrismaService,
      llmService,
      memoryService,
      integrationsService,
    );

    runtimeService = new RuntimeService(mockPrisma as PrismaService, queueService);

    // Don't use the real WorkerService interval; we'll manually process
    workerService = new WorkerService(mockPrisma as PrismaService, queueService, executorService);
  });

  afterEach(() => {
    workerService.onModuleDestroy();
  });

  it("should enqueue a run and track it properly", async () => {
    const run = await runtimeService.triggerRun("agent_1", "org_1");

    expect(run.status).toBe("QUEUED");
    expect(run.agentId).toBe("agent_1");
    expect(run.orgId).toBe("org_1");

    // Queue should have one job
    const stats = await runtimeService.getQueueStats();
    expect(stats.queued).toBe(1);

    // Log should have been created
    expect(mockPrisma.agentLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ level: "INFO", message: "Run queued for execution" }),
      }),
    );
  });

  it("should enforce daily run limits per plan", async () => {
    // Simulate 3 runs already today (TRIAL limit)
    (mockPrisma.agentRun.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);

    await expect(runtimeService.triggerRun("agent_1", "org_1")).rejects.toThrow(
      /Daily run limit reached/,
    );
  });

  it("should cancel a queued run", async () => {
    const run = await runtimeService.triggerRun("agent_1", "org_1");
    const result = await runtimeService.cancelRun(run.id);

    expect(result.cancelled).toBe(true);
    expect(mockPrisma.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: run.id },
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("should execute full pipeline: trigger -> queue -> execute (mock LLM)", async () => {
    const run = await runtimeService.triggerRun("agent_1", "org_1");

    // Manually process the queue (simulating what WorkerService does)
    const job = queueService.dequeue();
    expect(job).not.toBeNull();
    expect(job!.runId).toBe(run.id);

    // Execute the agent (mock mode since no OPENAI_API_KEY)
    const result = await executorService.executeAgent("agent_1", run.id);

    expect(result.output).toBeDefined();
    expect(result.tokensUsed).toBeGreaterThan(0);
    expect(result.cost).toBeGreaterThan(0);
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.model).toContain("mock");

    // Should have tool calls (mock mode simulates multi-step for SDR)
    const toolCalls = result.steps.filter((s) => s.type === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);

    // Should have persisted RunSteps to DB
    expect(mockPrisma.runStep.create).toHaveBeenCalled();
    const stepCalls = (mockPrisma.runStep.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(stepCalls.length).toBeGreaterThan(0);

    // Check step types include LLM_CALL and TOOL_CALL
    const stepTypes = stepCalls.map((c: any) => c[0].data.type);
    expect(stepTypes).toContain("LLM_CALL");
    expect(stepTypes).toContain("TOOL_CALL");
    expect(stepTypes).toContain("TOOL_RESULT");
  }, 30000);

  it("should include token budget info in output", async () => {
    await runtimeService.triggerRun("agent_1", "org_1");
    const job = queueService.dequeue();
    const result = await executorService.executeAgent("agent_1", job!.runId);

    expect(result.output._meta).toBeDefined();
    const meta = result.output._meta as Record<string, unknown>;
    expect(meta.tokenBudget).toBe(5000); // TRIAL plan
    expect(meta.tokensUsed).toBeGreaterThan(0);
    expect(meta.budgetRemaining).toBeDefined();
  }, 30000);
});
