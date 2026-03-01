import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { verifyClerkToken } from "./jwt.util";

export const SKIP_ORG_GUARD = "skipOrgGuard";

/**
 * Guard that:
 * 1. Verifies the Clerk JWT from the Authorization header (RS256 signature)
 * 2. Extracts the org_id claim from the verified payload
 * 3. Cross-checks it against the requested orgId (from header/query/body)
 * 4. Confirms the org exists in our DB
 *
 * In local dev without CLERK_DOMAIN set, falls back to trusting the orgId header
 * so development without Clerk credentials still works.
 *
 * Use @SkipOrgGuard() decorator to skip for public endpoints.
 */
@Injectable()
export class OrgScopeGuard implements CanActivate {
  private readonly clerkEnabled: boolean;

  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {
    // Only enforce JWT verification when Clerk is configured
    this.clerkEnabled = !!(
      process.env.CLERK_DOMAIN ||
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
      process.env.CLERK_JWKS_URL
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skipGuard = this.reflector.getAllAndOverride<boolean>(SKIP_ORG_GUARD, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skipGuard) return true;

    const request = context.switchToHttp().getRequest<Request>();

    const orgId = this.extractOrgId(request);
    if (!orgId) return true; // Some endpoints don't require orgId

    if (this.clerkEnabled) {
      // ── Verify JWT and confirm org ownership ──────────────────────────────
      const authHeader = request.headers["authorization"];
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        throw new UnauthorizedException("Missing or invalid Authorization header");
      }

      const token = authHeader.slice(7);
      let payload: Awaited<ReturnType<typeof verifyClerkToken>>;

      try {
        payload = await verifyClerkToken(token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Token verification failed";
        throw new UnauthorizedException(msg);
      }

      // The JWT must contain an org_id claim that matches the requested orgId
      if (!payload.org_id) {
        throw new ForbiddenException("Token does not contain an org_id claim — use an org-scoped session token");
      }

      if (payload.org_id !== orgId) {
        throw new ForbiddenException("Token org_id does not match the requested orgId");
      }

      // Store verified user info on request for downstream use
      (request as unknown as Record<string, unknown>).clerkUserId = payload.sub;
      (request as unknown as Record<string, unknown>).clerkOrgId = payload.org_id;
    }

    // ── Confirm org exists in DB ───────────────────────────────────────────
    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { id: true },
    });

    if (!org) {
      throw new ForbiddenException("Invalid organization");
    }

    (request as unknown as Record<string, unknown>).orgId = orgId;
    return true;
  }

  private extractOrgId(request: Request): string | undefined {
    const headerOrgId = request.headers["x-org-id"];
    if (typeof headerOrgId === "string") return headerOrgId;

    const queryOrgId = request.query.orgId;
    if (typeof queryOrgId === "string") return queryOrgId;

    const body = request.body as Record<string, unknown> | undefined;
    if (body && typeof body.orgId === "string") return body.orgId;

    return undefined;
  }
}

/**
 * Decorator to skip org scope guard for specific endpoints.
 * Use on health checks, auth callbacks, and public endpoints.
 */
export function SkipOrgGuard() {
  return SetMetadata(SKIP_ORG_GUARD, true);
}
