import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { OutreachSuppressionReason } from "@prisma/client";
import { Request } from "express";
import { OrgId } from "../common/org-context.decorator";
import {
  findAuthorizedOrgUser,
  OWNER_OR_ADMIN_ROLES,
  readSignedClerkOrgRole,
} from "../common/org-role-authority";
import { PrismaService } from "../prisma/prisma.service";
import type {
  ArtifactManualSuppressionResult,
  BulkManualSuppressionResult,
} from "./suppression.service";
import { SuppressionService } from "./suppression.service";

/**
 * Admin surface for the outreach suppression list. Org-scoped — the
 * @OrgId() decorator pulls the caller's orgId off the request (set by
 * OrgScopeGuard) so every row read/written/deleted is implicitly scoped.
 *
 * WRITE entry points: the public unsubscribe path (POST /u/:token in
 * unsubscribe.controller.ts) for recipients, and the admin CREATE below
 * (GL6b) for operators honoring an out-of-band opt-out ("please stop
 * emailing me" said on a call) before the next send fires.
 *
 * ALL endpoints require an active tenant-scoped OWNER or ADMIN database role,
 * plus a matching signed Clerk org_role for Clerk-bound tenants. The rows
 * contain recipient email addresses (PII), and removing a manual suppression
 * re-enables outbound. Even OWNER/ADMIN callers cannot remove unsubscribe,
 * complaint, or bounce rows without a durable re-consent/reverification
 * workflow.
 *
 * Audit P0 #3 follow-up.
 */
@Controller("outreach/suppression")
export class SuppressionController {
  private readonly logger = new Logger(SuppressionController.name);

  constructor(
    private readonly suppression: SuppressionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @OrgId() orgId: string,
    @Req() req: Request,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<{ rows: Array<unknown>; nextCursor: string | null }> {
    await this.assertAdminOrOwner(req, orgId, "view the suppression list");
    const parsedLimit = limit ? Math.max(1, Math.min(200, Number.parseInt(limit, 10))) : 50;
    const { rows, nextCursor } = await this.suppression.listForOrg(orgId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
      cursor: typeof cursor === "string" && cursor.length > 0 ? cursor : undefined,
    });
    return { rows, nextCursor };
  }

  /**
   * GL6b: manual suppression. Idempotent — SuppressionService.suppress
   * returns { created: false } when the recipient is already on the list
   * (the first real suppression wins; only a legacy gmail_reply sequence-stop
   * marker may be upgraded). Actor attribution is server-derived from the
   * authenticated principal (same clerkUserId source as assertAdminOrOwner) —
   * never trusted from the body.
   */
  @Post()
  async create(
    @OrgId() orgId: string,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{
    created: boolean;
    recipientRef: string;
    reason: OutreachSuppressionReason;
  }> {
    const actor = await this.assertAdminOrOwner(req, orgId, "suppress a recipient");
    const { recipientRef, reason } = parseCreateSuppressionBody(body);
    const normalizedRef = recipientRef.toLowerCase().trim();
    const { created } = await this.suppression.suppress({
      orgId,
      recipientRef: normalizedRef,
      reason,
      source: "admin_manual",
      metadata: {
        actorUserId: actor.userId,
        actorClerkId: actor.clerkUserId,
      },
    });
    this.logger.log(
      JSON.stringify({
        event: "outreach.suppression.created",
        orgId,
        recipientRef: normalizedRef,
        reason,
        created,
        actorUserId: actor.userId,
        actorClerkId: actor.clerkUserId,
        ts: new Date().toISOString(),
      }),
    );
    return { created, recipientRef: normalizedRef, reason };
  }

  /**
   * Suppress the recipient persisted on a reviewed outreach artifact. The
   * request deliberately has no body: recipient, org, and actor all come
   * from server-owned state.
   */
  @Post("artifacts/:artifactId")
  async suppressArtifactRecipient(
    @OrgId() orgId: string,
    @Req() req: Request,
    @Param("artifactId") artifactId: string,
  ): Promise<ArtifactManualSuppressionResult> {
    const actor = await this.assertAdminOrOwner(
      req,
      orgId,
      "suppress an artifact recipient",
    );
    return this.suppression.suppressArtifactRecipient({
      orgId,
      artifactId,
      actor,
    });
  }

  /**
   * Bulk suppression accepts Person ids only. Company ownership and the
   * usable EmailCandidate are resolved server-side, so callers cannot inject
   * another org or an arbitrary recipient address.
   */
  @Post("people/bulk")
  async suppressPeople(
    @OrgId() orgId: string,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<BulkManualSuppressionResult> {
    const actor = await this.assertAdminOrOwner(
      req,
      orgId,
      "bulk suppress people",
    );
    const personIds = parseBulkPersonSuppressionBody(body);
    return this.suppression.suppressPeople({ orgId, personIds, actor });
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsuppress(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Req() req: Request,
  ): Promise<void> {
    const actor = await this.assertAdminOrOwner(req, orgId, "unsuppress a recipient");
    const ok = await this.suppression.unsuppress(orgId, id);
    if (!ok) {
      throw new NotFoundException(`Suppression ${id} not found`);
    }
    // Audit trail — the suppression row is gone, so we log the act so the
    // compliance trail survives the delete. The structured shape mirrors
    // other admin-action evidence.
    this.logger.log(
      JSON.stringify({
        event: "outreach.suppression.unsuppressed",
        orgId,
        suppressionId: id,
        actorUserId: actor.userId,
        actorClerkId: actor.clerkUserId,
        ts: new Date().toISOString(),
      }),
    );
  }

  private async assertAdminOrOwner(
    req: Request,
    orgId: string,
    actionLabel: string,
  ): Promise<{ userId: string; clerkUserId: string }> {
    const clerkUserId = (req as unknown as Record<string, unknown>).clerkUserId;
    if (typeof clerkUserId !== "string" || clerkUserId.length === 0) {
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

/** Hard cap on recipientRef length — emails max out at 320 chars (RFC 5321). */
const MAX_RECIPIENT_REF_LENGTH = 512;

/**
 * Manual body validation (this controller does not use class-validator DTOs —
 * follow the existing raw Query/Param parsing pattern). `reason` is optional
 * and defaults to MANUAL; when supplied it must be a real
 * OutreachSuppressionReason value so a typo'd reason 400s instead of 500ing
 * at the Prisma layer.
 */
function parseCreateSuppressionBody(body: unknown): {
  recipientRef: string;
  reason: OutreachSuppressionReason;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Request body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;

  const recipientRef =
    typeof obj.recipientRef === "string" ? obj.recipientRef.trim() : "";
  if (!recipientRef) {
    throw new BadRequestException("recipientRef is required");
  }
  if (recipientRef.length > MAX_RECIPIENT_REF_LENGTH) {
    throw new BadRequestException(
      `recipientRef must be at most ${MAX_RECIPIENT_REF_LENGTH} characters`,
    );
  }

  let reason: OutreachSuppressionReason = OutreachSuppressionReason.MANUAL;
  if (obj.reason !== undefined) {
    const validReasons = Object.values(OutreachSuppressionReason) as string[];
    if (typeof obj.reason !== "string" || !validReasons.includes(obj.reason)) {
      throw new BadRequestException(
        `reason must be one of: ${validReasons.join(", ")}`,
      );
    }
    reason = obj.reason as OutreachSuppressionReason;
  }

  return { recipientRef, reason };
}

const MAX_BULK_PERSON_IDS = 200;
const MAX_PERSON_ID_LENGTH = 256;

function parseBulkPersonSuppressionBody(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("Request body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  const unexpectedKeys = Object.keys(obj).filter((key) => key !== "personIds");
  if (unexpectedKeys.length > 0) {
    throw new BadRequestException(
      `Only personIds is accepted; unexpected field(s): ${unexpectedKeys.join(", ")}`,
    );
  }
  if (!Array.isArray(obj.personIds) || obj.personIds.length === 0) {
    throw new BadRequestException("personIds must be a non-empty array");
  }
  if (obj.personIds.length > MAX_BULK_PERSON_IDS) {
    throw new BadRequestException(
      `personIds must contain at most ${MAX_BULK_PERSON_IDS} entries`,
    );
  }

  return obj.personIds.map((value, index) => {
    if (typeof value !== "string") {
      throw new BadRequestException(`personIds[${index}] must be a string`);
    }
    const personId = value.trim();
    if (!personId || personId.length > MAX_PERSON_ID_LENGTH) {
      throw new BadRequestException(
        `personIds[${index}] must be between 1 and ${MAX_PERSON_ID_LENGTH} characters`,
      );
    }
    return personId;
  });
}
