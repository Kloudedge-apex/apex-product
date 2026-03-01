import { describe, it, expect, beforeEach } from "vitest";
import { QueueService, QueueJob } from "../queue.service";

describe("QueueService", () => {
  let queue: QueueService;

  beforeEach(() => {
    queue = new QueueService();
  });

  describe("enqueue", () => {
    it("should add a job to the queue with queued status", () => {
      const job = queue.enqueue({
        id: "job_1",
        agentId: "agent_1",
        orgId: "org_1",
        runId: "run_1",
      });

      expect(job.id).toBe("job_1");
      expect(job.status).toBe("queued");
      expect(job.createdAt).toBeInstanceOf(Date);
      expect(queue.getQueueLength()).toBe(1);
    });

    it("should enqueue multiple jobs in order", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.enqueue({ id: "job_2", agentId: "a2", orgId: "o1", runId: "r2" });
      queue.enqueue({ id: "job_3", agentId: "a3", orgId: "o1", runId: "r3" });

      expect(queue.getQueueLength()).toBe(3);
    });
  });

  describe("dequeue", () => {
    it("should return null when queue is empty", () => {
      expect(queue.dequeue()).toBeNull();
    });

    it("should return and remove the first job (FIFO)", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.enqueue({ id: "job_2", agentId: "a2", orgId: "o1", runId: "r2" });

      const job = queue.dequeue();
      expect(job?.id).toBe("job_1");
      expect(job?.status).toBe("processing");
      expect(job?.startedAt).toBeInstanceOf(Date);
      expect(queue.getQueueLength()).toBe(1);
      expect(queue.getProcessingCount()).toBe(1);
    });
  });

  describe("complete", () => {
    it("should mark a processing job as completed", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.dequeue();

      queue.complete("job_1");

      expect(queue.getProcessingCount()).toBe(0);
    });

    it("should do nothing for unknown job id", () => {
      queue.complete("nonexistent");
      expect(queue.getProcessingCount()).toBe(0);
    });
  });

  describe("fail", () => {
    it("should mark a processing job as failed with error", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.dequeue();

      queue.fail("job_1", "Something went wrong");

      expect(queue.getProcessingCount()).toBe(0);
      const status = queue.getStatus("job_1");
      expect(status).toBeNull(); // removed from processing
    });
  });

  describe("cancel", () => {
    it("should cancel a queued job", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });

      const cancelled = queue.cancel("job_1");

      expect(cancelled).toBe(true);
      expect(queue.getQueueLength()).toBe(0);
    });

    it("should cancel a processing job", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.dequeue();

      const cancelled = queue.cancel("job_1");

      expect(cancelled).toBe(true);
      expect(queue.getProcessingCount()).toBe(0);
    });

    it("should return false for unknown job", () => {
      expect(queue.cancel("nonexistent")).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("should find queued job", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });

      const status = queue.getStatus("job_1");
      expect(status?.status).toBe("queued");
    });

    it("should find processing job", () => {
      queue.enqueue({ id: "job_1", agentId: "a1", orgId: "o1", runId: "r1" });
      queue.dequeue();

      const status = queue.getStatus("job_1");
      expect(status?.status).toBe("processing");
    });

    it("should return null for unknown job", () => {
      expect(queue.getStatus("nonexistent")).toBeNull();
    });
  });
});
