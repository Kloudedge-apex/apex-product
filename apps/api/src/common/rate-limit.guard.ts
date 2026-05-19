import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { Request } from "express";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Rate limiter. Runs after `OrgScopeGuard`, so it can key on the verified
 * `request.orgId` rather than a client-supplied header. For unauthenticated
 * routes (`@SkipOrgGuard()`), keys on client IP.
 *
 * Why a guard and not middleware: Nest middleware runs before guards, which
 * means `request.orgId` isn't populated yet. Keying off `x-org-id` from the
 * raw request lets any client claim another org's quota.
 *
 * In-memory store; swap for Redis for multi-instance deployments.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly windowMs = 60_000;
  private readonly orgLimit = 200;
  private readonly ipLimit = 100;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<
      Request & { orgId?: string }
    >();

    const orgId = req.orgId;
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
      return true;
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
    return true;
  }
}
