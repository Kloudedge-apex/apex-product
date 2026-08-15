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
 * `request.orgId` rather than a client-supplied header. Routes that intentionally
 * skip tenant auth are not placed into a process-local IP bucket: production
 * console requests, signed webhooks, and provider callbacks can share one BFF
 * or provider egress, so that bucket would create a cross-tenant denial of
 * service. Volumetric controls for those routes belong at the trusted edge.
 *
 * Why a guard and not middleware: Nest middleware runs before guards, which
 * means `request.orgId` isn't populated yet. Keying off `x-org-id` from the
 * raw request lets any client claim another org's quota.
 *
 * The store is process-local, but strictly bounded and expiry-swept. This
 * keeps a Redis outage from turning the public ingress into a hard dependency
 * while preventing attacker-controlled key growth. Multi-replica deployments
 * should additionally enforce an edge limit; this guard remains the
 * tenant-aware application backstop.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly windowMs = 60_000;
  private readonly orgLimit = 200;
  private readonly maxEntries = 10_000;
  private nextSweepAt = 0;

  canActivate(context: ExecutionContext): boolean {
    const req = this.getRequest(context);

    const orgId = req.orgId;
    if (!orgId) return true;

    return this.consume(
      `org:${orgId}`,
      this.orgLimit,
      `Rate limit exceeded (${this.orgLimit} req/min per organization). Try again in a minute.`,
    );
  }

  protected getRequest(
    context: ExecutionContext,
  ): Request & { orgId?: string } {
    return context.switchToHttp().getRequest<Request & { orgId?: string }>();
  }

  protected consume(key: string, limit: number, message: string): boolean {
    const now = Date.now();
    this.sweepExpired(now);
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      if (!entry && this.store.size >= this.maxEntries) {
        throw new HttpException(
          "Rate limiter is at capacity. Try again in a minute.",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // Refresh insertion order so the map remains an accurate bounded set of
      // active windows rather than retaining an expired position forever.
      this.store.delete(key);
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= limit) {
      throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
    }

    entry.count++;
    return true;
  }

  private sweepExpired(now: number): void {
    if (now < this.nextSweepAt) return;
    for (const [key, entry] of this.store) {
      if (now >= entry.resetAt) this.store.delete(key);
    }
    this.nextSweepAt = now + this.windowMs;
  }
}
