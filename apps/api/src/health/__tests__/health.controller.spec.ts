import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "../health.controller";

type FakePrismaService = { $queryRaw: ReturnType<typeof vi.fn> };
type FakeQueue = { client: Promise<{ ping: ReturnType<typeof vi.fn> }> };
type FakeQueueService = { getBullQueue: () => FakeQueue | null };

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

describe("HealthController", () => {
  let prisma: FakePrismaService;
  let queueSvc: FakeQueueService;
  let controller: HealthController;

  beforeEach(() => {
    prisma = makePrisma();
    queueSvc = makeQueueService();
    controller = new HealthController(prisma as never, queueSvc as never);
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
    prisma = makePrisma({ failsWith: new Error("connect ECONNREFUSED") });
    controller = new HealthController(prisma as never, queueSvc as never);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("/ready throws 503 when redis ping fails", async () => {
    queueSvc = makeQueueService({ redisOk: false });
    controller = new HealthController(prisma as never, queueSvc as never);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("/ready returns ok when bullQueue is null (dev DB-polling fallback)", async () => {
    queueSvc = makeQueueService({ nullQueue: true });
    controller = new HealthController(prisma as never, queueSvc as never);
    const out = await controller.ready();
    expect(out.checks.redis).toBe("ok");
  });

  it("/ legacy endpoint still returns static OK for deploy rollout compat", () => {
    const out = controller.check();
    expect(out.status).toBe("ok");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
