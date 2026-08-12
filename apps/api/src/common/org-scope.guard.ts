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
import { buildTrialOrgSlug } from "./trial-org.util";

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
      process.env.CLERK_JWKS_URL ||
      process.env.CLERK_ISSUER ||
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    );
    this.allowDevHeader =
      process.env.NODE_ENV !== "production" &&
      process.env.ALLOW_DEV_ORG_HEADER === "true";

    if (process.env.NODE_ENV === "production" && !this.clerkConfigured) {
      throw new Error(
        "OrgScopeGuard: Clerk issuer/JWKS configuration must be set in production. " +
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

      // Defense in depth: tenant resolution must never proceed without a
      // concrete Clerk principal, even if the verifier is later replaced or
      // regresses. A signed org_id alone is not an internal membership proof.
      if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
        throw new UnauthorizedException("JWT subject is required");
      }
      clerkUserId = payload.sub;
      clerkOrgRole = payload.org_role;

      if (payload.org_id) {
        orgId = payload.org_id;
      } else {
        // Fallback: no Clerk Organization yet (common during onboarding before
        // Clerk Org sync). Resolve the internal Org via the verified `sub`
        // (clerkUserId). Safe because `sub` is signature-verified by Clerk and
        // each user maps to exactly one internal Org via the User table.
        const user = await this.prisma.user.findUnique({
          where: { clerkId: clerkUserId },
          select: { orgId: true },
        });
        if (user) {
          orgId = user.orgId;
        } else {
          // No internal Org+User row yet. The dashboard bootstrap normally
          // handles this via POST /api/orgs, but if the user lands directly on
          // a protected route (or that call raced/failed), provision here so
          // the request can proceed. Identity is taken solely from the
          // signature-verified `sub` claim.
          const provisioned = await this.autoProvisionOrg(payload);
          orgId = provisioned.id;
        }
      }
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

    // A verified Clerk org_id proves membership in a Clerk organization, but
    // it does not by itself prove membership in the internal tenant row that
    // happened to match by id/slug. Bind every protected request back to the
    // one internal User row for the verified `sub` before exposing orgId.
    if (this.clerkConfigured) {
      const membership = await this.prisma.user.findUnique({
        where: { clerkId: clerkUserId! },
        select: { orgId: true },
      });
      if (!membership || membership.orgId !== org.id) {
        throw new ForbiddenException("User is not a member of this organization");
      }
    }

    reqAny.orgId = org.id;
    if (this.clerkConfigured) reqAny.clerkUserId = clerkUserId!;
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

  /**
   * Create an internal Org+User on demand from a verified Clerk JWT payload.
   * Used when a signed-in user hits a protected route before the frontend
   * bootstrap (POST /api/orgs) has completed. Re-entrant: if a parallel
   * request created the row in the meantime, the unique-clerkId constraint
   * will surface that and we look up the existing org.
   */
  private async autoProvisionOrg(payload: {
    sub: string;
    email?: string;
  }): Promise<{ id: string }> {
    const clerkUserId = payload.sub;
    const email =
      payload.email && payload.email.length > 0
        ? payload.email
        : `${clerkUserId}@no-email.workforceos.local`;
    const baseName =
      payload.email && payload.email.includes("@")
        ? payload.email.split("@")[1].split(".")[0]
        : "Workspace";
    const name = baseName.charAt(0).toUpperCase() + baseName.slice(1);
    const slug = buildTrialOrgSlug(name, clerkUserId);

    try {
      const org = await this.prisma.org.create({
        data: {
          name,
          slug,
          plan: "TRIAL",
          trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
          users: {
            create: {
              email,
              name: payload.email || name,
              role: "OWNER",
              clerkId: clerkUserId,
            },
          },
        },
        select: { id: true },
      });
      this.logger.log(
        `Auto-provisioned org ${org.id} for clerkUser ${clerkUserId}`,
      );
      return org;
    } catch (err) {
      // Likely a race: another request created the row first. Re-fetch.
      const user = await this.prisma.user.findUnique({
        where: { clerkId: clerkUserId },
        select: { orgId: true },
      });
      if (user) return { id: user.orgId };
      this.logger.error(
        `Auto-provision failed for clerkUser ${clerkUserId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ForbiddenException(
        "Could not provision workspace for this user",
      );
    }
  }
}

/** Mark an endpoint as public. Such endpoints MUST authenticate by other means. */
export function SkipOrgGuard() {
  return SetMetadata(SKIP_ORG_GUARD, true);
}
