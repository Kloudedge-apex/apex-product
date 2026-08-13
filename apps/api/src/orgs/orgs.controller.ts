import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Res,
  ForbiddenException,
  UnauthorizedException,
  HttpStatus,
} from "@nestjs/common";
import { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { OrgsService } from "./orgs.service";
import { PrismaService } from "../prisma/prisma.service";
import { OrgId } from "../common/org-context.decorator";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { CreateOrgDto, UpdateOrgDto } from "../common/dto/orgs.dto";
import { verifyClerkToken } from "../common/jwt.util";
import {
  findAuthorizedOrgUser,
  OWNER_ONLY_ROLES,
  OWNER_OR_ADMIN_ROLES,
  readSignedClerkOrgRole,
} from "../common/org-role-authority";

/** Max skew (seconds) between client-supplied X-Reauth-Exp and server clock. */
const REAUTH_MAX_WINDOW_SECONDS = 300;

/**
 * Maximum age (seconds) of the Clerk JWT's `iat` claim when issuing a
 * delete reauth-challenge. The FE flow uses Clerk's `useReverification`
 * hook which forces a fresh password / 2FA prompt and re-issues the JWT,
 * so `iat` near `now` is a proof of recent step-up. Tokens older than
 * this window are rejected — the FE must trigger reverification first.
 */
const REAUTH_CHALLENGE_MAX_JWT_AGE_SECONDS = 120;

@Controller("orgs")
export class OrgsController {
  constructor(
    private readonly orgsService: OrgsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Org bootstrap. The user has a Clerk session but is not yet a member of
   * any org, so the JWT has no `org_id` claim — we skip the global guard and
   * verify the bearer token inline. The user identity comes from the verified
   * `sub` claim, NEVER from the request body.
   */
  @Post()
  @SkipOrgGuard()
  async create(@Req() req: Request, @Body() body: CreateOrgDto) {
    const { clerkUserId, email, clerkOrgId, clerkOrgRole } =
      await verifyAuth(req);
    return this.orgsService.create({
      name: body.name,
      slug: body.slug,
      clerkUserId,
      email,
      userName: body.userName,
      clerkOrgId,
      clerkOrgRole,
    });
  }

  /**
   * Returns the authenticated user's org (chicken-and-egg safe: this works
   * even before an `org_id` claim exists on the JWT).
   *
   * The response carries a computed `sendReadiness` object (GL5) so the FE
   * can render live-send truth instead of guessing:
   *   { liveSendAllowed, physicalAddressSet, senderNameSet, countrySet,
   *     mailboxConnected, dailyCapRemaining }
   * See OrgsService.computeSendReadiness for derivation.
   */
  @Get("me")
  @SkipOrgGuard()
  async findMe(@Req() req: Request) {
    const { clerkUserId, clerkOrgId, clerkOrgRole } = await verifyAuth(req);
    return this.orgsService.findByClerkUser(clerkUserId, {
      clerkOrgId,
      clerkOrgRole,
    });
  }

  /**
   * Derived guided-setup status for the authenticated tenant. There is no
   * client-provided org identifier and no mutable completion flag.
   */
  @Get("onboarding/status")
  getOnboardingStatus(@OrgId() orgId: string) {
    return this.orgsService.getOnboardingStatus(orgId);
  }

  @Get(":id")
  findOne(@OrgId() orgId: string, @Param("id") id: string) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
    return this.orgsService.findOne(orgId);
  }

  /**
   * Org settings update. Writes sender identity (the CAN-SPAM §7704(a)(5)
   * fields the send worker fail-closes on) and `plan` — org-level settings a
   * regular MEMBER must not be able to change, so the same OWNER/ADMIN gate
   * as the suppression endpoints (commit e61b3cb) applies.
   */
  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: UpdateOrgDto,
    @Req() req: Request,
  ) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
    await this.assertAdminOrOwner(req, orgId, "update org settings");
    return this.orgsService.update(orgId, body);
  }

  @Get(":id/stats")
  getStats(@OrgId() orgId: string, @Param("id") id: string) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
    return this.orgsService.getStats(orgId);
  }

  /**
   * GDPR Art. 17 / CCPA §1798.105 right-to-erasure endpoint.
   *
   * Auth gates (defence in depth — caller has already passed OrgScopeGuard):
   *   1. The :id path param must equal the orgId derived from the verified
   *      Clerk JWT (handled by OrgScopeGuard + the explicit check below).
   *   2. The caller must have an active User row in that org with synchronized
   *      OWNER role. A signed Clerk org_role is an additional veto and is
   *      required for Clerk-bound tenants.
   *   3. Re-auth challenge: the client must present a short-lived HMAC token
   *      computed over `${orgId}:${userId}:${exp}` with the server-side
   *      ENCRYPTION_KEY. The frontend obtains this from a confirm-deletion
   *      dialog flow (a separate POST builds the HMAC for the user after
   *      they re-type their org name). Exp is carried in X-Reauth-Exp and
   *      must fall within ±REAUTH_MAX_WINDOW_SECONDS of `now`.
   *
   * On success, responds 204 No Content with no body — the org and all
   * cascade-linked rows are gone.
   */
  @Delete(":id")
  async remove(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (id !== orgId) {
      throw new ForbiddenException("Cross-org access denied");
    }

    const clerkUserId = readClerkUserId(req);
    if (!clerkUserId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }

    const user = await findAuthorizedOrgUser(this.prisma, {
      clerkUserId,
      orgId,
      clerkOrgRole: readSignedClerkOrgRole(req),
      allowedRoles: OWNER_ONLY_ROLES,
    });
    if (!user) {
      throw new ForbiddenException("Only the org OWNER may delete the org");
    }

    verifyReauthChallenge(req, orgId, user.id);

    await this.orgsService.deleteOrg(orgId, {
      userId: user.id,
      email: user.email ?? null,
    });

    res.status(HttpStatus.NO_CONTENT).send();
  }

  /**
   * Issues a short-lived (≤5 min) X-Reauth-Token + X-Reauth-Exp pair for
   * the calling user against the target org. The FE flow:
   *   1. user clicks "Delete organization" in Settings → Compliance
   *   2. FE POSTs to /api/orgs/:id/reauth-challenge
   *   3. FE sends the returned token + exp as headers on DELETE /api/orgs/:id
   *
   * Identity is enforced the same way the @Delete handler enforces it:
   *   - OrgScopeGuard already verified the JWT and attached clerkUserId
   *   - We re-look-up the active tenant membership and require both the
   *     synchronized and freshly re-verified signed roles to allow OWNER.
   *
   * Note on "freshness": Clerk session freshness is enforced upstream by
   * the FE (it triggers Clerk's step-up auth dialog before calling this).
   * Server-side we mint with a 5-min window so a leaked token cannot be
   * reused indefinitely.
   */
  @Post(":id/reauth-challenge")
  async issueReauthChallenge(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Req() req: Request,
  ): Promise<{ token: string; exp: number; expiresInSeconds: number }> {
    if (id !== orgId) {
      throw new ForbiddenException("Cross-org access denied");
    }

    // Re-verify the bearer JWT inline so we can read `iat` (Clerk's
    // issued-at). The OrgScopeGuard already verified the token earlier in
    // the request lifecycle, but it does not expose `iat` on the request
    // object — so we re-parse here. This is the step-up proof: the FE
    // must have called Clerk's reverification flow (which re-issues the
    // JWT) within REAUTH_CHALLENGE_MAX_JWT_AGE_SECONDS.
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing Authorization header");
    }
    const payload = await verifyClerkToken(authHeader.slice(7).trim()).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Invalid token";
      throw new UnauthorizedException(msg);
    });
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.iat !== "number" || now - payload.iat > REAUTH_CHALLENGE_MAX_JWT_AGE_SECONDS) {
      throw new UnauthorizedException(
        "JWT too stale for reauth-challenge — trigger Clerk reverification first",
      );
    }

    const user = await findAuthorizedOrgUser(this.prisma, {
      clerkUserId: payload.sub,
      orgId,
      clerkOrgRole: payload.org_role,
      allowedRoles: OWNER_ONLY_ROLES,
    });
    if (!user) {
      throw new ForbiddenException("Only the org OWNER may mint a delete challenge");
    }

    const secret = process.env.ENCRYPTION_KEY;
    if (!secret || secret.length === 0) {
      throw new UnauthorizedException("Server re-auth secret not configured");
    }

    const expiresInSeconds = REAUTH_MAX_WINDOW_SECONDS;
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const token = createHmac("sha256", secret)
      .update(`${orgId}:${user.id}:${exp}`)
      .digest("hex");

    return { token, exp, expiresInSeconds };
  }

  /**
   * Same shared role authority as suppression.controller.ts: the active,
   * tenant-scoped database role must allow OWNER/ADMIN, and a signed Clerk
   * org_role can veto stale privilege.
   */
  private async assertAdminOrOwner(
    req: Request,
    orgId: string,
    actionLabel: string,
  ): Promise<{ userId: string; clerkUserId: string }> {
    const clerkUserId = readClerkUserId(req);
    if (!clerkUserId) {
      throw new UnauthorizedException("Missing authenticated user context");
    }
    const user = await findAuthorizedOrgUser(this.prisma, {
      clerkUserId,
      orgId,
      clerkOrgRole: readSignedClerkOrgRole(req),
      allowedRoles: OWNER_OR_ADMIN_ROLES,
    });
    if (!user) {
      throw new ForbiddenException(`Only OWNER or ADMIN may ${actionLabel}`);
    }
    return { userId: user.id, clerkUserId };
  }
}

async function verifyAuth(
  req: Request,
): Promise<{
  clerkUserId: string;
  email: string;
  clerkOrgId?: string;
  clerkOrgRole?: string;
}> {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedException("Missing Authorization header");
  }
  try {
    const payload = await verifyClerkToken(authHeader.slice(7).trim());
    return {
      clerkUserId: payload.sub,
      email: payload.email ?? "",
      clerkOrgId: payload.org_id,
      clerkOrgRole: payload.org_role,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid token";
    throw new UnauthorizedException(msg);
  }
}

/** Pulls the OrgScopeGuard-attached clerk user id off the request. */
function readClerkUserId(req: Request): string | null {
  const raw = (req as unknown as Record<string, unknown>).clerkUserId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Validates the X-Reauth-Token / X-Reauth-Exp headers against an HMAC-SHA256
 * over `${orgId}:${userId}:${exp}` keyed on env.ENCRYPTION_KEY. Throws 401 on
 * any mismatch, missing header, malformed exp, expired, or future-skewed
 * token. Constant-time comparison via crypto.timingSafeEqual.
 */
function verifyReauthChallenge(
  req: Request,
  orgId: string,
  userId: string,
): void {
  const token = readHeader(req, "x-reauth-token");
  if (!token) {
    throw new UnauthorizedException("Missing X-Reauth-Token header");
  }
  const expRaw = readHeader(req, "x-reauth-exp");
  if (!expRaw) {
    throw new UnauthorizedException("Missing X-Reauth-Exp header");
  }
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || Number.isNaN(exp)) {
    throw new UnauthorizedException("Invalid X-Reauth-Exp header");
  }

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) {
    throw new UnauthorizedException("Re-auth challenge expired");
  }
  if (exp > now + REAUTH_MAX_WINDOW_SECONDS) {
    throw new UnauthorizedException("Re-auth challenge exp too far in future");
  }

  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length === 0) {
    // Defensive: at boot we expect ENCRYPTION_KEY to be set. If it isn't,
    // refuse the delete rather than degrade to an unauthenticated path.
    throw new UnauthorizedException("Server re-auth secret not configured");
  }

  const expected = createHmac("sha256", secret)
    .update(`${orgId}:${userId}:${exp}`)
    .digest("hex");

  const provided = token.trim().toLowerCase();
  const expectedNormalised = expected.toLowerCase();
  if (provided.length !== expectedNormalised.length) {
    throw new UnauthorizedException("Re-auth token mismatch");
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expectedNormalised, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedException("Re-auth token mismatch");
  }
}

function readHeader(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0];
  }
  return null;
}
