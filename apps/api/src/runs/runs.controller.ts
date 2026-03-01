import { Controller, Get, Post, Param, Query, Body } from "@nestjs/common";
import { RunsService } from "./runs.service";
import { ListRunsQueryDto, CreateRunDto } from "../common/dto/runs.dto";

@Controller("runs")
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Get()
  findByOrg(@Query() query: ListRunsQueryDto) {
    return this.runsService.findByOrg(query.orgId, {
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
  findByAgent(@Param("agentId") agentId: string, @Query("limit") limit?: number) {
    return this.runsService.findByAgent(agentId, limit ?? 50);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.runsService.findOne(id);
  }

  @Post()
  create(@Body() body: CreateRunDto) {
    return this.runsService.create(body);
  }
}
