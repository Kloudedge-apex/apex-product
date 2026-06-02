import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { OrgId } from "../common/org-context.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { SuppressionService } from "./suppression.service";

/**
 * Admin surface for the outreach suppression list. Org-scoped — the
 * @OrgId() decorator pulls the caller's orgId off the request (set by
 * OrgScopeGuard) so every row read/deleted is implicitly scoped.
 *
 * The public unsubscribe path (POST /u/:token in unsubscribe.controller.ts)
 * is the only WRITE entry point. This controller offers READ + ADMIN
 * UNSUPPRESS (operator deletes a row after a manual recheck).
 *
 * BOTH endpoints require OWNER or ADMIN role: the rows contain recipient
 * email addresses (PII) and unsuppressing re-enables outbound to a
 * recipient who explicitly opted out — a regulatory action a regular member
 * must not be able to take.
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
    const user = await this.prisma.user.findUnique({
      where: { clerkId: clerkUserId },
      select: { id: true, role: true, orgId: true },
    });
    if (!user || user.orgId !== orgId) {
      throw new ForbiddenException("Cross-org access denied");
    }
    if (user.role !== "OWNER" && user.role !== "ADMIN") {
      throw new ForbiddenException(`Only OWNER or ADMIN may ${actionLabel}`);
    }
    return { userId: user.id, clerkUserId };
  }
}
