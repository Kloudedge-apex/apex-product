import { describe, it, expect, vi } from "vitest";
import type { Job } from "bullmq";
import { UsageRollupProcessor } from "../usage-rollup.processor";

describe("UsageRollupProcessor", () => {
  it("dispatches rollup-hour jobs to UsageService", async () => {
    const usage = { rollupHour: vi.fn().mockResolvedValue(undefined), rollupDay: vi.fn() } as any;
    const queue = { isBullMode: () => false, getConnection: () => null } as any;
    const processor = new UsageRollupProcessor(queue, usage);

    const job = {
      name: "rollup-hour",
      data: { orgId: "org_1", hourBucket: "2026-05-29T10:00:00.000Z" },
    } as unknown as Job<any>;

    await processor.process(job);

    expect(usage.rollupHour).toHaveBeenCalledTimes(1);
    expect(usage.rollupHour).toHaveBeenCalledWith({
      orgId: "org_1",
      hourBucket: new Date("2026-05-29T10:00:00.000Z"),
    });
  });

  it("dispatches rollup-day jobs to UsageService", async () => {
    const usage = { rollupHour: vi.fn(), rollupDay: vi.fn().mockResolvedValue(undefined) } as any;
    const queue = { isBullMode: () => false, getConnection: () => null } as any;
    const processor = new UsageRollupProcessor(queue, usage);

    const job = {
      name: "rollup-day",
      data: { orgId: "org_1", dayBucket: "2026-05-28T00:00:00.000Z" },
    } as unknown as Job<any>;

    await processor.process(job);

    expect(usage.rollupDay).toHaveBeenCalledTimes(1);
    expect(usage.rollupDay).toHaveBeenCalledWith({
      orgId: "org_1",
      dayBucket: new Date("2026-05-28T00:00:00.000Z"),
    });
  });
});

