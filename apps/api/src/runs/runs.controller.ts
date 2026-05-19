import { Controller, Get, Post, Param, Query, Body, NotFoundException } from "@nestjs/common";
import { RunsService } from "./runs.service";
import { PrismaService } from "../prisma/prisma.service";
import { OrgId } from "../common/org-context.decorator";
import { ListRunsQueryDto, CreateRunDto } from "../common/dto/runs.dto";

@Controller("runs")
export class RunsController {
  constructor(
    private readonly runsService: RunsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  findByOrg(@OrgId() orgId: string, @Query() query: ListRunsQueryDto) {
    return this.runsService.findByOrg(orgId, {
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      status: query.status,
      agentId: query.agentId,
      from: query.from,
      to: query.to,
      search: query.search,
    });
  }

  @Get("agent/:agentId")
  findByAgent(
    @OrgId() orgId: string,
    @Param("agentId") agentId: string,
    @Query("limit") limit?: number,
  ) {
    return this.runsService.findByAgent(agentId, orgId, limit ?? 50);
  }

  @Get(":id")
  findOne(@OrgId() orgId: string, @Param("id") id: string) {
    return this.runsService.findOne(id, orgId);
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: CreateRunDto) {
    // Verify the agent belongs to this org before queuing a run for it.
    const owned = await this.prisma.agent.findFirst({
      where: { id: body.agentId, orgId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException("Agent not found");
    return this.runsService.create(orgId, { agentId: body.agentId });
  }
}
