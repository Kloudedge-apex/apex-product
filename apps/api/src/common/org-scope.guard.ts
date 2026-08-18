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
import {
  assertClerkUserNotDeleted,
  withProvisionableClerkUser,
} from "./clerk-user-provisioning";

export const SKIP_ORG_GUARD = "skipOrgGuard";

/**
 * Authoritative org scoping.
 *
 * - Requires `Authorization: Bearer <Clerk JWT>` on every protected route.
 * - Derives Clerk-bound tenants from the verified `org_id` claim — never from
 *   header/query/body. Personal sessions may resolve only unbound local tenants.
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
    let orgIdentity: "internal" | "clerk" = "internal";
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
      if (payload.sub !== payload.sub.trim()) {
        throw new UnauthorizedException("JWT subject must be canonical");
      }
      const hasClerkOrgId =
        typeof payload.org_id === "string" && payload.org_id.length > 0;
      const hasClerkOrgRole =
        typeof payload.org_role === "string" && payload.org_role.length > 0;
      if (hasClerkOrgId !== hasClerkOrgRole) {
        throw new UnauthorizedException(
          "JWT organization claims are inconsistent",
        );
      }
      clerkUserId = payload.sub;
      clerkOrgRole = payload.org_role;
      await assertClerkUserNotDeleted(this.prisma, clerkUserId);

      if (hasClerkOrgId) {
        orgId = payload.org_id;
        orgIdentity = "clerk";
      } else {
        // Fallback: no Clerk Organization yet (common during onboarding before
        // Clerk Org sync). Resolve the internal Org via the verified `sub`
        // (clerkUserId). Safe because `sub` is signature-verified by Clerk and
        // each user maps to exactly one internal Org via the User table.
        const user = await this.prisma.user.findUnique({
          where: { clerkId: clerkUserId },
          select: { orgId: true, membershipActive: true },
        });
        if (user) {
          if (!user.membershipActive) {
            throw new ForbiddenException("Organization membership is inactive");
          }
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
        const headerClerkUserId = request.headers["x-clerk-user-id"];
        if (
          typeof headerClerkUserId === "string" &&
          headerClerkUserId.length > 0
        ) {
          clerkUserId = headerClerkUserId;
          reqAny.clerkUserId = headerClerkUserId;
        }
        this.logger.warn(
          "Dev mode: orgId resolved from x-org-id header. " +
          "Never enable this in production.",
        );
      }
    }

    if (!orgId) {
      throw new UnauthorizedException("Authentication required");
    }

    // A Clerk org claim is an immutable external id. It must never be treated
    // as an internal cuid or mutable slug; local/no-org and dev flows already
    // hold the internal id directly.
    const org =
      orgIdentity === "clerk"
        ? await this.resolveClerkOrg(orgId)
        : await this.resolveInternalOrg(orgId);
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
        select: { orgId: true, membershipActive: true },
      });
      if (
        !membership ||
        !membership.membershipActive ||
        membership.orgId !== org.id
      ) {
        throw new ForbiddenException("User is not a member of this organization");
      }

      // A personal-session JWT can legitimately access an unbound local trial
      // workspace, but it must never inherit access to a tenant that has been
      // bound to Clerk Organizations. Bound tenants require both claims from
      // the verified organization session.
      if (
        org.clerkOrgId &&
        (orgIdentity !== "clerk" ||
          typeof clerkOrgRole !== "string" ||
          clerkOrgRole.trim().length === 0)
      ) {
        throw new ForbiddenException(
          "Active Clerk organization session required",
        );
      }
    }

    reqAny.orgId = org.id;
    if (this.clerkConfigured) reqAny.clerkUserId = clerkUserId!;
    if (clerkOrgRole) reqAny.clerkOrgRole = clerkOrgRole;
    return true;
  }

  private async resolveInternalOrg(
    id: string,
  ): Promise<{ id: string; clerkOrgId: string | null } | null> {
    return this.prisma.org.findUnique({
      where: { id },
      select: { id: true, clerkOrgId: true },
    });
  }

  private async resolveClerkOrg(
    clerkOrgId: string,
  ): Promise<{ id: string; clerkOrgId: string | null } | null> {
    return this.prisma.org.findUnique({
      where: { clerkOrgId },
      select: { id: true, clerkOrgId: true },
    });
  }

  /**
   * Create an internal Org+User on demand from a verified Clerk JWT payload.
   * Used when a signed-in user hits a protected route before the frontend
   * bootstrap (POST /api/orgs) has completed. Re-entrant: both bootstrap paths
   * share the same per-user transaction lock and recheck the principal.
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

    return withProvisionableClerkUser(
      this.prisma,
      clerkUserId,
      async (tx) => {
        // Recheck under the same user lock used by user.deleted and the
        // explicit POST /orgs bootstrap path. A concurrent winner can have
        // created or deactivated this principal after the guard's pre-read.
        const existingUser = await tx.user.findUnique({
          where: { clerkId: clerkUserId },
          select: { orgId: true, membershipActive: true },
        });
        if (existingUser?.membershipActive) {
          return { id: existingUser.orgId };
        }
        if (existingUser) {
          throw new ForbiddenException("Organization membership is inactive");
        }

        const org = await tx.org.create({
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
                membershipActive: true,
              },
            },
          },
          select: { id: true },
        });
        this.logger.log(
          `Auto-provisioned org ${org.id} for clerkUser ${clerkUserId}`,
        );
        return org;
      },
    );
  }
}

/** Mark an endpoint as public. Such endpoints MUST authenticate by other means. */
export function SkipOrgGuard() {
  return SetMetadata(SKIP_ORG_GUARD, true);
}
