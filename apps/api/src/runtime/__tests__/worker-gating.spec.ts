import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorkerService, isWorkerEnabled } from "../worker.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { QueueService } from "../queue.service";
import type { ExecutorService } from "../executor.service";
import {
  ProductionBootstrapWriterFenceClosedError,
  ProductionBootstrapWriterFenceUnavailableError,
  type ProductionBootstrapWriterFenceService,
} from "../../ops/production-bootstrap-writer-fence";

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

  it("stays healthy and attaches a fenced consumer when bootstrap is CLOSED", async () => {
    process.env.WORKER_ENABLED = "true";
    const fence = {
      runWriter: vi.fn(async () => {
        throw new ProductionBootstrapWriterFenceClosedError();
      }),
    } as unknown as ProductionBootstrapWriterFenceService;
    const worker = new WorkerService(prisma, queue, executor, fence);

    await expect(worker.onModuleInit()).resolves.toBeUndefined();
    expect(prisma.agentRun.findMany).not.toHaveBeenCalled();
    expect(queue.isBullMode).toHaveBeenCalledOnce();
    const handleJob = (
      worker as unknown as {
        handleJob(job: {
          data: { agentId: string; runId: string };
        }): Promise<void>;
      }
    ).handleJob.bind(worker);
    await expect(
      handleJob({ data: { agentId: "agent_1", runId: "run_1" } }),
    ).rejects.toBeInstanceOf(ProductionBootstrapWriterFenceClosedError);
    await worker.onModuleDestroy();
  });

  it("creates no BullMQ consumer while CLOSED and activates after exact OPEN", async () => {
    vi.useFakeTimers();
    process.env.WORKER_ENABLED = "true";
    const isPaused = vi.fn(async () => false);
    queue = {
      isBullMode: vi.fn().mockReturnValue(true),
      getConnection: vi.fn().mockReturnValue({}),
      getBullQueue: vi.fn().mockReturnValue({ isPaused }),
      enqueue: vi.fn(),
    } as unknown as QueueService;
    let closed = true;
    let epochUnavailable = true;
    const fence = {
      runWriter: vi.fn(async (_kind, operation) => {
        if (closed) throw new ProductionBootstrapWriterFenceClosedError();
        return operation();
      }),
      deploymentEpochMode: vi.fn(async () => {
        if (epochUnavailable) {
          throw new ProductionBootstrapWriterFenceUnavailableError();
        }
        return closed ? "closed" : "open";
      }),
    } as unknown as ProductionBootstrapWriterFenceService;
    const worker = new WorkerService(prisma, queue, executor, fence);
    const start = vi
      .spyOn(
        worker as unknown as { startBullWorker(): void },
        "startBullWorker",
      )
      .mockImplementation(() => undefined);
    const warnLog = vi
      .spyOn(
        (worker as unknown as { logger: { warn: (...args: unknown[]) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      await expect(worker.onModuleInit()).resolves.toBeUndefined();
      expect(isPaused).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(warnLog).toHaveBeenCalledWith(
        expect.stringContaining("activation remains fail-closed"),
      );
      expect(unhandled).not.toHaveBeenCalled();

      epochUnavailable = false;
      closed = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(start).toHaveBeenCalledOnce();
      expect(prisma.agentRun.findMany).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", unhandled);
      await worker.onModuleDestroy();
      vi.useRealTimers();
    }
  });
});
