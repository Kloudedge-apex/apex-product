import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "../health.controller";
import type { WorkerHealthReport } from "../worker-health.service";

type FakePrismaService = { $queryRaw: ReturnType<typeof vi.fn> };
type FakeQueue = { client: Promise<{ ping: ReturnType<typeof vi.fn> }> };
type FakeQueueService = { getBullQueue: () => FakeQueue | null };
type FakeWorkerHealth = { check: ReturnType<typeof vi.fn> };

function makePrisma(opts: { failsWith?: Error } = {}): FakePrismaService {
  return {
    $queryRaw: vi.fn(async () => {
      if (opts.failsWith) throw opts.failsWith;
      return [{ result: 1 }];
    }),
  };
}

function makeQueueService(opts: { redisOk?: boolean; nullQueue?: boolean } = { redisOk: true }): FakeQueueService {
  if (opts.nullQueue) {
    return { getBullQueue: () => null };
  }
  const ping = vi.fn(async () => {
    if (opts.redisOk === false) throw new Error("redis down");
    return "PONG";
  });
  return {
    getBullQueue: () => ({ client: Promise.resolve({ ping }) }),
  };
}

function makeWorkerHealth(report: WorkerHealthReport): FakeWorkerHealth {
  return { check: vi.fn(async () => report) };
}

const HEALTHY_REPORT: WorkerHealthReport = {
  healthy: true,
  stallWindowMs: 300_000,
  queues: [],
};

const UNHEALTHY_REPORT: WorkerHealthReport = {
  healthy: false,
  stallWindowMs: 300_000,
  queues: [
    {
      queue: "graph-runs",
      mode: "bullmq",
      healthy: false,
      reasons: ["3 job(s) backlogged on \"graph-runs\" with zero BullMQ consumers attached"],
      workerCount: 0,
      backlog: 3,
      counts: { waiting: 3, active: 0, delayed: 0, failed: 0, completed: 0 },
      observedWindowMs: null,
    },
  ],
};

describe("HealthController", () => {
  let prisma: FakePrismaService;
  let queueSvc: FakeQueueService;
  let workerHealth: FakeWorkerHealth;
  let controller: HealthController;

  beforeEach(() => {
    prisma = makePrisma();
    queueSvc = makeQueueService();
    workerHealth = makeWorkerHealth(HEALTHY_REPORT);
    controller = new HealthController(prisma as never, queueSvc as never, workerHealth as never);
  });

  it("/live returns static OK without touching deps", () => {
    const out = controller.live();
    expect(out.status).toBe("ok");
    expect(out.service).toBe("apex-api");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("/ready returns 200 + checks=ok when all deps healthy", async () => {
    const out = await controller.ready();
    expect(out.status).toBe("ok");
    expect(out.checks).toEqual({ postgres: "ok", redis: "ok" });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("/ready throws 503 when postgres is down", async () => {
    prisma = makePrisma({
      failsWith: new Error("connect ECONNREFUSED internal-postgres.example:5432"),
    });
    controller = new HealthController(prisma as never, queueSvc as never, workerHealth as never);
    const err = await controller.ready().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
    expect(body.checks).toEqual({ postgres: "failed", redis: "ok" });
    expect(JSON.stringify(body)).not.toContain("internal-postgres.example");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("/ready throws 503 when redis ping fails", async () => {
    queueSvc = makeQueueService({ redisOk: false });
    controller = new HealthController(prisma as never, queueSvc as never, workerHealth as never);
    const err = await controller.ready().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
    expect(body.checks).toEqual({ postgres: "ok", redis: "failed" });
    expect(JSON.stringify(body)).not.toContain("redis down");
  });

  it("/ready times out and throws 503 when redis ping never settles", async () => {
    const ping = vi.fn(() => new Promise<string>(() => undefined));
    queueSvc = {
      getBullQueue: () => ({ client: Promise.resolve({ ping }) }),
    };
    controller = new HealthController(prisma as never, queueSvc as never, workerHealth as never);

    const err = await controller
      .ready({ HEALTH_CHECK_TIMEOUT_MS: "5" })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("/ready times out and throws 503 when postgres never settles", async () => {
    prisma = {
      $queryRaw: vi.fn(() => new Promise(() => undefined)),
    };
    controller = new HealthController(prisma as never, queueSvc as never, workerHealth as never);

    const err = await controller
      .ready({ HEALTH_CHECK_TIMEOUT_MS: "5" })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
  });

  it("/ready returns ok when bullQueue is null (dev DB-polling fallback)", async () => {
    queueSvc = makeQueueService({ nullQueue: true });
    controller = new HealthController(prisma as never, queueSvc as never, workerHealth as never);
    const out = await controller.ready();
    expect(out.checks.redis).toBe("ok");
  });

  it("/ legacy endpoint still returns static OK for deploy rollout compat", () => {
    const out = controller.check();
    expect(out.status).toBe("ok");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("/worker returns 200 with the report when consumers are healthy", async () => {
    const out = await controller.worker();
    expect(out.status).toBe("ok");
    expect(out.stallWindowMs).toBe(300_000);
    expect(workerHealth.check).toHaveBeenCalledTimes(1);
  });

  it("/worker throws 503 carrying queue verdicts when consumers are not consuming", async () => {
    workerHealth = makeWorkerHealth(UNHEALTHY_REPORT);
    controller = new HealthController(prisma as never, queueSvc as never, workerHealth as never);
    const err = await controller.worker().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const body = (err as ServiceUnavailableException).getResponse() as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.queues).toEqual(UNHEALTHY_REPORT.queues);
  });
});
