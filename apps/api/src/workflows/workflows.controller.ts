import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { WorkflowRunStatus } from "@prisma/client";
import { OrgId, ClerkUserId } from "../common/org-context.decorator";
import { WorkflowTemplatesService } from "./workflow-templates.service";
import { WorkflowRunsService } from "./workflow-runs.service";

@Controller("workflows")
export class WorkflowsController {
  constructor(
    private readonly templates: WorkflowTemplatesService,
    private readonly runs: WorkflowRunsService,
  ) {}

  @Get("templates")
  listTemplates() {
    return this.templates.listActive();
  }

  @Get("templates/:slug")
  getTemplate(@Param("slug") slug: string) {
    return this.templates.getBySlug(slug);
  }

  @Post(":slug/runs")
  startRun(
    @OrgId() orgId: string,
    @ClerkUserId() clerkUserId: string | undefined,
    @Param("slug") slug: string,
    @Body() body: { input?: Record<string, unknown> } | undefined,
  ) {
    const input = body?.input;
    if (!input || typeof input !== "object") {
      throw new BadRequestException("Request body must include input object");
    }
    return this.runs.start({
      orgId,
      slug,
      input,
      startedBy: clerkUserId,
    });
  }

  @Get("runs")
  listRuns(
    @OrgId() orgId: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedStatus =
      status && status in WorkflowRunStatus
        ? (status as WorkflowRunStatus)
        : undefined;
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.runs.list(orgId, {
      status: parsedStatus,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get("runs/:id")
  async getRun(@OrgId() orgId: string, @Param("id") id: string) {
    // Sync from underlying GraphRun on each read so callers always see the
    // freshest status without a separate polling endpoint.
    return this.runs.syncStatusFromGraph(orgId, id);
  }
}
