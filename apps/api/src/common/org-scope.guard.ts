import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  SetMetadata,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { verifyClerkToken } from "./jwt.util";

export const SKIP_ORG_GUARD = "skipOrgGuard";

/**
 * Authoritative org scoping.
 *
 * - Requires `Authorization: Bearer <Clerk JWT>` on every protected route.
 * - Derives `orgId` from the verified `org_id` claim — never from header/query/body.
 * - Confirms the org exists in our DB.
 * - Sets `request.orgId`, `request.clerkUserId`, and `request.clerkOrgRole` for handlers.
 *
 * Use `@SkipOrgGuard()` for endpoints that authenticate by other means
 * (OAuth callbacks with signed state, signed webhooks, health checks).
 *
 * In production, fails fast at boot if Clerk env vars are missing.
 * Set `ALLOW_DEV_ORG_HEADER=true` in non-production environments to fall back
 * to an `x-org-id` header for local testing without Clerk.
 */
@Injectable()
export class OrgScopeGuard implements CanActivate {
  private readonly logger = new Logger(OrgScopeGuard.name);
  private readonly clerkConfigured: boolean;
  private readonly allowDevHeader: boolean;

  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {
    this.clerkConfigured = !!(
      process.env.CLERK_DOMAIN ||
      process.env.CLERK_JWKS_URL
    );
    this.allowDevHeader =
      process.env.NODE_ENV !== "production" &&
      process.env.ALLOW_DEV_ORG_HEADER === "true";

    if (process.env.NODE_ENV === "production" && !this.clerkConfigured) {
      throw new Error(
        "OrgScopeGuard: CLERK_DOMAIN or CLERK_JWKS_URL must be set in production. " +
        "Refusing to start — header-based org spoofing would be possible otherwise.",
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skipGuard = this.reflector.getAllAndOverride<boolean>(SKIP_ORG_GUARD, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipGuard) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const reqAny = request as unknown as Record<string, unknown>;

    let orgId: string | undefined;
    let clerkUserId: string | undefined;
    let clerkOrgRole: string | undefined;

    if (this.clerkConfigured) {
      const authHeader = request.headers["authorization"];
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new UnauthorizedException("Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7).trim();
      let payload: Awaited<ReturnType<typeof verifyClerkToken>>;
      try {
        payload = await verifyClerkToken(token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Token verification failed";
        throw new UnauthorizedException(msg);
      }

      if (!payload.org_id) {
        throw new ForbiddenException(
          "Token has no org_id claim — use an org-scoped session token",
        );
      }

      orgId = payload.org_id;
      clerkUserId = payload.sub;
      clerkOrgRole = payload.org_role;
    } else if (this.allowDevHeader) {
      const headerOrgId = request.headers["x-org-id"];
      if (typeof headerOrgId === "string" && headerOrgId.length > 0) {
        orgId = headerOrgId;
        this.logger.warn(
          "Dev mode: orgId resolved from x-org-id header. " +
          "Never enable this in production.",
        );
      }
    }

    if (!orgId) {
      throw new UnauthorizedException("Authentication required");
    }

    // Resolve Clerk org slug -> our internal org id when needed.
    // Clerk's org id (`org_xxx`) is not the same as our cuid; we look up by slug.
    const org = await this.resolveOrg(orgId);
    if (!org) {
      throw new ForbiddenException("Organization not found");
    }

    reqAny.orgId = org.id;
    if (clerkUserId) reqAny.clerkUserId = clerkUserId;
    if (clerkOrgRole) reqAny.clerkOrgRole = clerkOrgRole;
    return true;
  }

  /**
   * Look up our internal Org by either internal cuid or Clerk org id/slug.
   * Clerk org ids (`org_xxx`) get matched against `slug` if not found as `id`.
   */
  private async resolveOrg(idOrSlug: string): Promise<{ id: string } | null> {
    const byId = await this.prisma.org.findUnique({
      where: { id: idOrSlug },
      select: { id: true },
    });
    if (byId) return byId;
    return this.prisma.org.findUnique({
      where: { slug: idOrSlug },
      select: { id: true },
    });
  }
}

/** Mark an endpoint as public. Such endpoints MUST authenticate by other means. */
export function SkipOrgGuard() {
  return SetMetadata(SKIP_ORG_GUARD, true);
}
