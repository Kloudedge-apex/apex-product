import { Injectable } from "@nestjs/common";

export interface QueueJob {
  id: string;
  agentId: string;
  orgId: string;
  runId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

@Injectable()
export class QueueService {
  private queue: QueueJob[] = [];
  private processing = new Map<string, QueueJob>();

  enqueue(job: Omit<QueueJob, "status" | "createdAt">): QueueJob {
    const queueJob: QueueJob = {
      ...job,
      status: "queued",
      createdAt: new Date(),
    };
    this.queue.push(queueJob);
    return queueJob;
  }

  dequeue(): QueueJob | null {
    const job = this.queue.shift();
    if (job) {
      job.status = "processing";
      job.startedAt = new Date();
      this.processing.set(job.id, job);
    }
    return job || null;
  }

  complete(jobId: string): void {
    const job = this.processing.get(jobId);
    if (job) {
      job.status = "completed";
      job.completedAt = new Date();
      this.processing.delete(jobId);
    }
  }

  fail(jobId: string, error: string): void {
    const job = this.processing.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = error;
      job.completedAt = new Date();
      this.processing.delete(jobId);
    }
  }

  cancel(jobId: string): boolean {
    // Try to cancel from queue first
    const idx = this.queue.findIndex((j) => j.id === jobId);
    if (idx >= 0) {
      this.queue[idx].status = "cancelled";
      this.queue.splice(idx, 1);
      return true;
    }
    // Try to cancel from processing
    const job = this.processing.get(jobId);
    if (job) {
      job.status = "cancelled";
      this.processing.delete(jobId);
      return true;
    }
    return false;
  }

  getStatus(jobId: string): QueueJob | null {
    const queued = this.queue.find((j) => j.id === jobId);
    if (queued) return queued;
    return this.processing.get(jobId) || null;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getProcessingCount(): number {
    return this.processing.size;
  }
}
