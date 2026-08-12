import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  BadRequestException,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { OrgId } from "../common/org-context.decorator";
import { AdminOrManagerGuard } from "../common/admin-or-manager.guard";
import { GraphService } from "./graph.service";
import { GraphRunStatus } from "@prisma/client";

@Controller("graph")
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get("runs")
  list(
    @OrgId() orgId: string | undefined,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
    @Query("status") statusRaw?: string,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    // Backwards-compatible opt-in: no page controls keeps the legacy array;
    // supplying either control returns the paginated response envelope.
    if (pageRaw !== undefined || limitRaw !== undefined || statusRaw !== undefined) {
      const status = parseGraphRunStatus(statusRaw);
      return this.graph.listGraphRuns(orgId, {
        page: parsePositiveInt(pageRaw, 1, 10_000),
        limit: parsePositiveInt(limitRaw, 20, 100),
        ...(status ? { status } : {}),
      });
    }
    return this.graph.listGraphRuns(orgId);
  }

  @Get("runs/:id")
  get(@OrgId() orgId: string | undefined, @Param("id") id: string) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.graph.getGraphRun(orgId, id);
  }

  @Post("runs/:id/approve")
  @UseGuards(AdminOrManagerGuard)
  approve(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() _body: { approvedBy?: string },
    @Req() req: Request,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.graph.resumePipelineGraph(id, orgId, {
      approved: true,
      approvedBy: reviewerFromRequest(req),
    });
  }

  @Post("runs/:id/reject")
  @UseGuards(AdminOrManagerGuard)
  reject(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() _body: { approvedBy?: string },
    @Req() req: Request,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.graph.resumePipelineGraph(id, orgId, {
      approved: false,
      approvedBy: reviewerFromRequest(req),
    });
  }
}

function reviewerFromRequest(req: Request): string {
  const clerkUserId = (req as unknown as Record<string, unknown>).clerkUserId;
  if (typeof clerkUserId !== "string" || clerkUserId.length === 0) {
    throw new UnauthorizedException("Missing authenticated user context");
  }
  return clerkUserId;
}

function parseGraphRunStatus(value: string | undefined): GraphRunStatus | undefined {
  if (value === undefined) return undefined;
  if (!Object.values(GraphRunStatus).includes(value as GraphRunStatus)) {
    throw new BadRequestException("Invalid graph run status");
  }
  return value as GraphRunStatus;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BadRequestException(`Expected an integer from 1 to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new BadRequestException(`Expected an integer from 1 to ${max}`);
  }
  return parsed;
}
