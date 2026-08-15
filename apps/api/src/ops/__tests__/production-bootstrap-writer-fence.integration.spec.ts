import IORedis from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorService } from "../../runtime/executor.service";
import { QueueService } from "../../runtime/queue.service";
import { WorkerService } from "../../runtime/worker.service";
import type { PrismaService } from "../../prisma/prisma.service";
import {
  armProductionBootstrapWriterFence,
  disarmProductionBootstrapWriterFence,
  PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
  PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY,
  ProductionBootstrapWriterFence,
  ProductionBootstrapWriterFenceUnavailableError,
  readProductionBootstrapWriterFence,
  recoverProductionBootstrapOrphanedWriterTokens,
} from "../production-bootstrap-writer-fence";

const REDIS_URL = process.env.WRITER_FENCE_INTEGRATION_REDIS_URL;
const ATTEMPT = "0123456789abcdef0123456789abcdef";
const integrationDescribe = REDIS_URL ? describe : describe.skip;

async function waitFor(
  assertion: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

integrationDescribe("production bootstrap real Redis/BullMQ contract", () => {
  let redis: IORedis | undefined;
  let queue: QueueService | undefined;
  let worker: WorkerService | undefined;
  const originalEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    REDIS_URL: process.env.REDIS_URL,
    WORKER_ENABLED: process.env.WORKER_ENABLED,
  };

  afterEach(async () => {
    if (worker) await worker.onModuleDestroy();
    if (queue) await queue.onModuleDestroy();
    if (redis) {
      await redis.flushdb();
      await redis.quit();
    }
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it(
    "keeps CLOSED at zero consumers, survives pause removal, and activates only on exact terminal OPEN",
    async () => {
      process.env.NODE_ENV = "test";
      process.env.REDIS_URL = REDIS_URL!;
      process.env.WORKER_ENABLED = "true";

      redis = new IORedis(REDIS_URL!, {
        enableReadyCheck: false,
        maxRetriesPerRequest: null,
      });
      redis.on("error", () => undefined);
      await redis.flushdb();

      // A lease that expires without an exact release is quarantined and
      // remains counted until a controller supplies the explicit zero proof.
      await redis.zadd(
        PRODUCTION_BOOTSTRAP_ACTIVE_WRITERS_KEY,
        0,
        "synthetic-crashed-root",
      );
      const quarantined = await readProductionBootstrapWriterFence(redis);
      expect(quarantined.activeWriters).toBe(1);
      const recovery = await recoverProductionBootstrapOrphanedWriterTokens(
        redis,
        {
          bootstrapAttemptId: ATTEMPT,
          expectedGeneration: 0,
          stableZeroEvidenceHash: `sha256:${"a".repeat(64)}`,
          ingressDisabled: true,
          queuesPausedAndDrained: true,
          apiReplicaCount: 0,
          workerReplicaCount: 0,
        },
      );
      expect(recovery.pre.uncertainApplicationWriters).toBe(1);
      expect(recovery.post.activeApplicationWriters).toBe(0);

      const now = new Date();
      await armProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        generation: 1,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      });
      const fence = new ProductionBootstrapWriterFence(redis, {
        production: true,
        bootstrapAttemptId: ATTEMPT,
        minimumGeneration: 1,
        leaseMs: 30_000,
        heartbeatMs: 1_000,
      });
      queue = new QueueService(fence);
      const bullQueue = queue.getBullQueue();
      expect(bullQueue).not.toBeNull();
      const job = await bullQueue!.add(
        "execute-agent",
        { agentId: "agent_ci", orgId: "org_ci", runId: "run_ci" },
        { jobId: "writer-fence-ci-job", attempts: 3 },
      );
      const prisma = {
        agentRun: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as unknown as PrismaService;
      worker = new WorkerService(
        prisma,
        queue,
        {} as ExecutorService,
        fence,
      );

      await worker.onModuleInit();
      expect((await queue.getQueueStats())?.workerCount).toBe(0);
      expect(await job.getState()).toBe("waiting");
      expect(job.attemptsMade).toBe(0);

      // Removing a queue pause cannot burn an attempt because CLOSED has not
      // constructed or registered a BullMQ consumer at all.
      await bullQueue!.pause();
      await bullQueue!.resume();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect((await queue.getQueueStats())?.workerCount).toBe(0);
      expect(await job.getState()).toBe("waiting");
      expect((await bullQueue!.getJob(job.id!))?.attemptsMade).toBe(0);

      await disarmProductionBootstrapWriterFence(redis, {
        bootstrapAttemptId: ATTEMPT,
        generation: 1,
        observedAt: new Date(),
      });
      await waitFor(
        async () => (await queue!.getQueueStats())?.workerCount === 1,
        "the exact guarded OPEN consumer",
      );
      await waitFor(
        async () => (await job.getState()) === "completed",
        "the queued job to complete after OPEN",
      );
      expect((await bullQueue!.getJob(job.id!))?.attemptsMade).toBe(1);

      // Exact OPEN replay is idempotent; terminal OPEN can never be re-armed.
      await expect(
        disarmProductionBootstrapWriterFence(redis, {
          bootstrapAttemptId: ATTEMPT,
          generation: 1,
          observedAt: new Date(),
        }),
      ).resolves.toBeUndefined();
      await expect(
        armProductionBootstrapWriterFence(redis, {
          bootstrapAttemptId: ATTEMPT,
          generation: 2,
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow("terminally open");

      await redis.del(PRODUCTION_BOOTSTRAP_WRITER_FENCE_STATE_KEY);
      await expect(
        fence.runWriter("http", async () => "unsafe"),
      ).rejects.toBeInstanceOf(
        ProductionBootstrapWriterFenceUnavailableError,
      );
    },
    25_000,
  );
});
