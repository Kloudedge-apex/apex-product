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

/** Max skew (seconds) between client-supplied X-Reauth-Exp and server clock. */
const REAUTH_MAX_WINDOW_SECONDS = 300;

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
    const { clerkUserId, email } = await verifyAuth(req);
    return this.orgsService.create({
      name: body.name,
      slug: body.slug,
      clerkUserId,
      email,
      userName: body.userName,
    });
  }

  /**
   * Returns the authenticated user's org (chicken-and-egg safe: this works
   * even before an `org_id` claim exists on the JWT).
   */
  @Get("me")
  @SkipOrgGuard()
  async findMe(@Req() req: Request) {
    const { clerkUserId } = await verifyAuth(req);
    return this.orgsService.findByClerkUser(clerkUserId);
  }

  @Get(":id")
  findOne(@OrgId() orgId: string, @Param("id") id: string) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
    return this.orgsService.findOne(orgId);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: UpdateOrgDto,
  ) {
    if (id !== orgId) throw new ForbiddenException("Cross-org access denied");
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
   *   2. The caller must be a User row in that org with role === OWNER. We
   *      look this up via the Clerk sub (set on `req.clerkUserId` by the
   *      guard) — there is no @Roles decorator in the codebase, so the check
   *      is inline.
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

    const user = await this.prisma.user.findUnique({
      where: { clerkId: clerkUserId },
      select: { id: true, email: true, role: true, orgId: true },
    });
    if (!user) {
      throw new ForbiddenException("User not found in target org");
    }
    if (user.orgId !== orgId) {
      throw new ForbiddenException("Cross-org access denied");
    }
    if (user.role !== "OWNER") {
      throw new ForbiddenException("Only the org OWNER may delete the org");
    }

    verifyReauthChallenge(req, orgId, user.id);

    await this.orgsService.deleteOrg(orgId, {
      userId: user.id,
      email: user.email ?? null,
    });

    res.status(HttpStatus.NO_CONTENT).send();
  }
}

async function verifyAuth(
  req: Request,
): Promise<{ clerkUserId: string; email: string }> {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new UnauthorizedException("Missing Authorization header");
  }
  try {
    const payload = await verifyClerkToken(authHeader.slice(7).trim());
    return { clerkUserId: payload.sub, email: payload.email ?? "" };
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
