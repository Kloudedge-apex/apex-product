import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SchedulerService } from "../scheduler.service";
import { PrismaService } from "../../prisma/prisma.service";
import { RuntimeService } from "../runtime.service";

function createMockPrisma() {
  return {
    agent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
}

function createMockRuntime() {
  return {
    triggerRun: vi.fn().mockResolvedValue({ id: "run_1" }),
  } as unknown as RuntimeService;
}

describe("SchedulerService", () => {
  let scheduler: SchedulerService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockRuntime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPrisma = createMockPrisma();
    mockRuntime = createMockRuntime();
    scheduler = new SchedulerService(mockPrisma, mockRuntime);
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    vi.useRealTimers();
  });

  it("should start interval on module init", () => {
    scheduler.onModuleInit();
    // The interval should be set — we can verify by advancing time
    expect(mockPrisma.agent.findMany).not.toHaveBeenCalled();
  });

  it("should check schedules after interval", async () => {
    scheduler.onModuleInit();

    // Advance 60 seconds to trigger check
    await vi.advanceTimersByTimeAsync(60000);

    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "ACTIVE",
          schedule: { not: null },
        }),
      }),
    );
  });

  it("should trigger run for agent due for execution (every_hour, no previous run)", async () => {
    const agent = {
      id: "agent_1",
      orgId: "org_1",
      schedule: "every_hour",
      runs: [], // No previous runs
    };

    (mockPrisma.agent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(60000);

    expect(mockRuntime.triggerRun).toHaveBeenCalledWith("agent_1", "org_1");
  });

  it("should NOT trigger run for agent that recently ran (every_hour)", async () => {
    const agent = {
      id: "agent_1",
      orgId: "org_1",
      schedule: "every_hour",
      runs: [{ startedAt: new Date() }], // Just ran
    };

    (mockPrisma.agent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(60000);

    expect(mockRuntime.triggerRun).not.toHaveBeenCalled();
  });

  it("should trigger run for every_15min schedule when enough time passed", async () => {
    const lastRun = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
    const agent = {
      id: "agent_1",
      orgId: "org_1",
      schedule: "every_15min",
      runs: [{ startedAt: lastRun }],
    };

    (mockPrisma.agent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(60000);

    expect(mockRuntime.triggerRun).toHaveBeenCalledWith("agent_1", "org_1");
  });

  it("should handle every_day schedule", async () => {
    const lastRun = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    const agent = {
      id: "agent_1",
      orgId: "org_1",
      schedule: "every_day",
      runs: [{ startedAt: lastRun }],
    };

    (mockPrisma.agent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(60000);

    expect(mockRuntime.triggerRun).toHaveBeenCalledWith("agent_1", "org_1");
  });

  it("should clean up interval on module destroy", () => {
    scheduler.onModuleInit();
    scheduler.onModuleDestroy();

    // After destroy, advancing time should not trigger new calls
    (mockPrisma.agent.findMany as ReturnType<typeof vi.fn>).mockClear();
    vi.advanceTimersByTime(120000);
    expect(mockPrisma.agent.findMany).not.toHaveBeenCalled();
  });

  it("should skip agents with null schedule", async () => {
    const agent = {
      id: "agent_1",
      orgId: "org_1",
      schedule: null,
      runs: [],
    };

    (mockPrisma.agent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([agent]);
    scheduler.onModuleInit();

    await vi.advanceTimersByTimeAsync(60000);

    expect(mockRuntime.triggerRun).not.toHaveBeenCalled();
  });
});
