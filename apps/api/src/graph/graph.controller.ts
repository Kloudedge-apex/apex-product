import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  BadRequestException,
} from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";
import { GraphService } from "./graph.service";

@Controller("graph")
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get("runs")
  list(@OrgId() orgId: string | undefined) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.graph.listGraphRuns(orgId);
  }

  @Get("runs/:id")
  get(@OrgId() orgId: string | undefined, @Param("id") id: string) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.graph.getGraphRun(orgId, id);
  }

  @Post("runs/:id/approve")
  approve(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() body: { approvedBy?: string },
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.graph.resumePipelineGraph(id, orgId, {
      approved: true,
      approvedBy: body?.approvedBy,
    });
  }

  @Post("runs/:id/reject")
  reject(
    @OrgId() orgId: string | undefined,
    @Param("id") id: string,
    @Body() body: { approvedBy?: string },
  ) {
    if (!orgId) throw new BadRequestException("orgId required");
    return this.graph.resumePipelineGraph(id, orgId, {
      approved: false,
      approvedBy: body?.approvedBy,
    });
  }
}
