import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { PrismaService } from "../prisma/prisma.service";
import { GraphRunQueueService } from "../graph/graph-run-queue.service";

/**
 * Liveness + readiness probes. Audit P0 #14.
 *
 * - `/api/health/live` — process up. Static 200. Used by orchestrator restart
 *   policy; should NOT depend on Postgres/Redis (a flapping DB must not cause
 *   pod restarts).
 * - `/api/health/ready` — process can serve traffic. Probes Postgres + Redis
 *   (via the BullMQ queue's redis client) and returns 503 if any dep is down.
 *   Used by the load balancer / Container App readiness probe to drain traffic
 *   off pods whose dependencies have died.
 *
 * Backwards-compat: `/api/health` (no suffix) still returns 200 OK and matches
 * the previous static shape so deploy probes pointing at the legacy path do
 * not break during rollout. Once the Container App probes are switched over,
 * the legacy alias can be removed.
 */
@Controller("health")
@SkipOrgGuard()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graphRunQueue: GraphRunQueueService,
  ) {}

  /**
   * Legacy probe — kept for deploy rollout compatibility. Equivalent to
   * /live; does NOT touch dependencies.
   */
  @Get()
  check() {
    return this.staticOk();
  }

  @Get("live")
  live() {
    return this.staticOk();
  }

  @Get("ready")
  @HttpCode(HttpStatus.OK)
  async ready() {
    const checks: Record<string, "ok" | string> = {};

    // Postgres — a real query against the connection.
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = "ok";
    } catch (err) {
      checks.postgres = err instanceof Error ? err.message : "unknown error";
    }

    // Redis (via BullMQ queue's underlying ioredis client). The queue is null
    // when REDIS_URL is unset — that is only legitimate in dev; in prod the
    // constructor throws at boot if Redis is missing, so a null queue here
    // means we are in the dev DB-polling fallback. Treat that as "ok" for
    // local dev so `pnpm dev` does not fail readiness.
    try {
      const queue = this.graphRunQueue.getBullQueue();
      if (queue) {
        // BullMQ Queue exposes .client which is a Promise<IORedis>; await + ping.
        const client = await queue.client;
        await client.ping();
        checks.redis = "ok";
      } else {
        checks.redis = "ok"; // dev fallback mode — not a readiness failure
      }
    } catch (err) {
      checks.redis = err instanceof Error ? err.message : "unknown error";
    }

    const failing = Object.entries(checks).filter(([, v]) => v !== "ok");
    if (failing.length > 0) {
      this.logger.warn(
        `Readiness probe failing: ${failing.map(([k, v]) => `${k}=${v}`).join(", ")}`,
      );
      throw new ServiceUnavailableException({
        status: "degraded",
        service: "apex-api",
        timestamp: new Date().toISOString(),
        checks,
      });
    }

    return {
      status: "ok",
      service: "apex-api",
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private staticOk() {
    return {
      status: "ok",
      service: "apex-api",
      timestamp: new Date().toISOString(),
    };
  }
}
