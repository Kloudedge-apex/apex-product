import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  BadRequestException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { OutreachArtifactStatus } from "@prisma/client";
import { OrgId } from "../common/org-context.decorator";
import { AdminOrManagerGuard } from "../common/admin-or-manager.guard";
import { OutreachArtifactsService } from "./outreach-artifacts.service";

interface ApproveBody {
  /**
   * @deprecated Ignored since audit B8 — attribution is derived from the
   * authenticated principal (request.clerkUserId set by OrgScopeGuard), never
   * from the body, so the audit trail cannot be forged. Tolerated so older FE
   * builds that still send it don't break.
   */
  reviewedBy?: string;
}

interface RejectBody {
  /** @deprecated Ignored since audit B8 — see {@link ApproveBody.reviewedBy}. */
  reviewedBy?: string;
  reviewerNote?: string;
}

@Controller()
export class OutreachArtifactsController {
  constructor(private readonly artifacts: OutreachArtifactsService) {}

  @Get("graph/runs/:id/outreach-artifacts")
  listForGraphRun(
    @OrgId() orgId: string | undefined,
    @Param("id") graphRunId: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.artifacts.listForGraphRun(orgId, graphRunId);
  }

  @Get("outreach-artifacts")
  list(
    @OrgId() orgId: string | undefined,
    @Query("status") status?: string,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const parsed = status ? parseStatus(status) : undefined;
    // Backwards compatible: legacy callers receive the historical bare array.
    // Pagination-aware callers receive an envelope with a real tenant-scoped
    // count, so review rows beyond the old 100-row window remain reachable.
    if (pageRaw !== undefined || limitRaw !== undefined) {
      const page = parsePositiveInt(pageRaw, 1, 10_000);
      const limit = parsePositiveInt(limitRaw, 20, 100);
      return this.artifacts.listPageForOrg(orgId, { status: parsed, page, limit });
    }
    return this.artifacts.listForOrg(orgId, { status: parsed });
  }

  /**
   * Read-only authorization probe for review clients. A successful response
   * means the same guard protecting approve/reject authorized this principal;
   * denied principals receive the guard's 403 and unauthenticated callers the
   * global org guard's 401.
   *
   * Keep this static route before `outreach-artifacts/:id` so the capability
   * name can never be interpreted as an artifact id.
   */
  @Get("outreach-artifacts/review-capability")
  @UseGuards(AdminOrManagerGuard)
  reviewCapability(): { canReviewArtifacts: true } {
    return { canReviewArtifacts: true };
  }

  @Get("outreach-artifacts/:id")
  get(@OrgId() orgId: string | undefined, @Param("id") id: string) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.artifacts.get(orgId, id);
  }

  // Audit B11: approve flips an artifact onto the live send path, so both
  // review verbs carry the same admin/manager gate as the raw Gmail send
  // endpoint (integrations/gmail/gmail.controller.ts) — a regular member must
  // not be able to trigger outbound.
  @Post("outreach-artifacts/:id/approve")
  @UseGuards(AdminOrManagerGuard)
  approve(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() _body: ApproveBody,
    @Req() req: Request,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const reviewedBy = this.reviewerFromRequest(req);
    return this.artifacts.approve(orgId, id, reviewedBy);
  }

  @Post("outreach-artifacts/:id/reject")
  @UseGuards(AdminOrManagerGuard)
  reject(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() body: RejectBody,
    @Req() req: Request,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const reviewedBy = this.reviewerFromRequest(req);
    return this.artifacts.reject(orgId, id, reviewedBy, body?.reviewerNote);
  }

  /**
   * Server-derived reviewer attribution (audit B8). Reads the Clerk user id
   * that OrgScopeGuard stamped on the request after JWT verification — the
   * same principal source suppression.controller.ts uses. Body-supplied
   * `reviewedBy` is deliberately ignored: it was client-controlled and made
   * the review audit trail forgeable.
   */
  private reviewerFromRequest(req: Request): string {
    const clerkUserId = (req as unknown as Record<string, unknown>).clerkUserId;
    if (typeof clerkUserId !== "string" || clerkUserId.length === 0) {
      throw new UnauthorizedException("Missing authenticated user context");
    }
    return clerkUserId;
  }
}

function parseStatus(value: string): OutreachArtifactStatus {
  const normalized = value.toUpperCase();
  const allowed = Object.values(OutreachArtifactStatus) as string[];
  if (!allowed.includes(normalized)) {
    throw new BadRequestException(
      `Invalid status "${value}". Allowed: ${allowed.join(",")}`,
    );
  }
  return normalized as OutreachArtifactStatus;
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(`Expected an integer from 1 to ${max}`);
  }
  return parsed;
}
