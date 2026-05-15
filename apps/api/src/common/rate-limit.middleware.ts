import { Injectable, NestMiddleware, HttpException, HttpStatus } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Rate limiting middleware.
 * Keys on `x-org-id` header when present (200 req/min per org).
 * Falls back to IP address for unauthenticated requests (100 req/min).
 * Uses in-memory store; for multi-instance deployments, swap for a Redis store.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly windowMs = 60_000; // 1 minute
  private readonly orgLimit = 200;    // requests per minute per org
  private readonly ipLimit = 100;     // requests per minute per IP
  private cleanupHandle: ReturnType<typeof setInterval>;

  constructor() {
    // Evict expired entries every 5 minutes to prevent memory leak
    this.cleanupHandle = setInterval(() => this.evictExpired(), 5 * 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupHandle);
  }

  private evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.resetAt) {
        this.store.delete(key);
      }
    }
  }

  use(req: Request, _res: Response, next: NextFunction) {
    // Prefer orgId for keying — gives each org their own quota
    const orgId = req.headers["x-org-id"] as string | undefined;
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const key = orgId ? `org:${orgId}` : `ip:${ip}`;
    const limit = orgId ? this.orgLimit : this.ipLimit;

    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return next();
    }

    if (entry.count >= limit) {
      throw new HttpException(
        orgId
          ? `Rate limit exceeded (${limit} req/min per organization). Try again in a minute.`
          : `Rate limit exceeded (${limit} req/min per IP). Try again in a minute.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    entry.count++;
    next();
  }
}
