import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { OutreachArtifactStatus } from "@prisma/client";
import { OrgId } from "../common/org-context.decorator";
import { OutreachArtifactsService } from "./outreach-artifacts.service";

interface ApproveBody {
  reviewedBy?: string;
}

interface RejectBody {
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
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const parsed = status ? parseStatus(status) : undefined;
    return this.artifacts.listForOrg(orgId, { status: parsed });
  }

  @Get("outreach-artifacts/:id")
  get(@OrgId() orgId: string | undefined, @Param("id") id: string) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.artifacts.get(orgId, id);
  }

  @Post("outreach-artifacts/:id/approve")
  approve(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() body: ApproveBody,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const reviewedBy = body?.reviewedBy?.trim();
    if (!reviewedBy) {
      throw new BadRequestException("reviewedBy is required");
    }
    return this.artifacts.approve(orgId, id, reviewedBy);
  }

  @Post("outreach-artifacts/:id/reject")
  reject(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() body: RejectBody,
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    const reviewedBy = body?.reviewedBy?.trim();
    if (!reviewedBy) {
      throw new BadRequestException("reviewedBy is required");
    }
    return this.artifacts.reject(orgId, id, reviewedBy, body?.reviewerNote);
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
