import { describe, it, expect, beforeEach } from "vitest";
import { buildRedisConnectionOptions, QueueService } from "../queue.service";

/**
 * These tests exercise the in-memory fallback (REDIS_URL must not be set).
 * The BullMQ-backed path is covered by integration tests against a real
 * Redis in CI.
 */
describe("QueueService (in-memory fallback)", () => {
  let queue: QueueService;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    queue = new QueueService();
  });

  describe("enqueue", () => {
    it("adds a job with queued status", async () => {
      const job = await queue.enqueue({
        id: "job_1",
        agentId: "agent_1",
        orgId: "org_1",
        runId: "run_1",
      });

      expect(job.id).toBe("job_1");
      expect(job.status).toBe("queued");
      expect(job.createdAt).toBeInstanceOf(Date);
      expect(await queue.getQueueLength()).toBe(1);
    });

    it("enqueues multiple jobs in order", async () => {
      await queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      await queue.enqueue({ id: "job_2", agentId: "a2", orgId: "o1", runId: "r2" });
      await queue.enqueue({ id: "job_3", agentId: "a3", orgId: "o1", runId: "r3" });

      expect(await queue.getQueueLength()).toBe(3);
    });
  });

  describe("dequeue (in-memory only)", () => {
    it("returns null when queue is empty", () => {
      expect(queue.dequeue()).toBeNull();
    });

    it("returns and removes the first job FIFO", async () => {
      await queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      await queue.enqueue({ id: "job_2", agentId: "a2", orgId: "o1", runId: "r2" });

      const job = queue.dequeue();
      expect(job?.id).toBe("job_1");
      expect(job?.status).toBe("processing");
      expect(await queue.getQueueLength()).toBe(1);
      expect(await queue.getProcessingCount()).toBe(1);
    });
  });

  describe("complete / fail", () => {
    it("marks a processing job as completed", async () => {
      await queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.dequeue();
      queue.complete("job_1");
      expect(await queue.getProcessingCount()).toBe(0);
    });

    it("marks a processing job as failed", async () => {
      await queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.dequeue();
      queue.fail("job_1", "boom");
      expect(await queue.getProcessingCount()).toBe(0);
    });
  });

  describe("cancel", () => {
    it("cancels a queued job", async () => {
      await queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      expect(await queue.cancel("job_1")).toBe(true);
      expect(await queue.getQueueLength()).toBe(0);
    });

    it("cancels a processing job", async () => {
      await queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.dequeue();
      expect(await queue.cancel("job_1")).toBe(true);
      expect(await queue.getProcessingCount()).toBe(0);
    });

    it("returns false for unknown job", async () => {
      expect(await queue.cancel("nonexistent")).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("finds a queued job", async () => {
      await queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      const status = await queue.getStatus("job_1");
      expect(status?.status).toBe("queued");
    });

    it("returns null for unknown job", async () => {
      expect(await queue.getStatus("nonexistent")).toBeNull();
    });
  });

  it("preserves the Redis username in host-mode connection options", () => {
    process.env.REDIS_HOST = "redis.internal";
    process.env.REDIS_PORT = "6380";
    process.env.REDIS_USERNAME = "workforce";
    process.env.REDIS_PASSWORD = "not-a-real-secret";
    process.env.REDIS_TLS = "false";
    try {
      expect(buildRedisConnectionOptions()).toMatchObject({
        host: "redis.internal",
        port: 6380,
        username: "workforce",
        password: "not-a-real-secret",
      });
    } finally {
      delete process.env.REDIS_HOST;
      delete process.env.REDIS_PORT;
      delete process.env.REDIS_USERNAME;
      delete process.env.REDIS_PASSWORD;
      delete process.env.REDIS_TLS;
    }
  });
});
