import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorkerService, isWorkerEnabled } from "../worker.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { QueueService } from "../queue.service";
import type { ExecutorService } from "../executor.service";

describe("isWorkerEnabled", () => {
  it("returns true only for the exact string 'true'", () => {
    expect(isWorkerEnabled({ WORKER_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isWorkerEnabled({ WORKER_ENABLED: "True" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWorkerEnabled({ WORKER_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWorkerEnabled({ WORKER_ENABLED: "yes" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWorkerEnabled({ WORKER_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWorkerEnabled({ WORKER_ENABLED: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWorkerEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("WorkerService gating", () => {
  let prisma: PrismaService;
  let queue: QueueService;
  let executor: ExecutorService;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.WORKER_ENABLED;
    prisma = {
      agentRun: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    queue = {
      isBullMode: vi.fn().mockReturnValue(false),
      getConnection: vi.fn().mockReturnValue(null),
      enqueue: vi.fn(),
    } as unknown as QueueService;
    executor = {} as ExecutorService;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WORKER_ENABLED;
    else process.env.WORKER_ENABLED = originalEnv;
  });

  it("does not start the worker when WORKER_ENABLED is unset", async () => {
    delete process.env.WORKER_ENABLED;
    const worker = new WorkerService(prisma, queue, executor);
    await worker.onModuleInit();

    expect(queue.isBullMode).not.toHaveBeenCalled();
    expect(prisma.agentRun.findMany).not.toHaveBeenCalled();
  });

  it("does not start the worker when WORKER_ENABLED is set to 'false'", async () => {
    process.env.WORKER_ENABLED = "false";
    const worker = new WorkerService(prisma, queue, executor);
    await worker.onModuleInit();

    expect(queue.isBullMode).not.toHaveBeenCalled();
  });

  it("starts the worker when WORKER_ENABLED is exactly 'true'", async () => {
    process.env.WORKER_ENABLED = "true";
    const worker = new WorkerService(prisma, queue, executor);
    await worker.onModuleInit();

    expect(prisma.agentRun.findMany).toHaveBeenCalled();
    expect(queue.isBullMode).toHaveBeenCalled();
    await worker.onModuleDestroy();
  });
});
