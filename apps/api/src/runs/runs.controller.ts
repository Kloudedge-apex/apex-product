import { Controller, Get, Post, Param, Query } from "@nestjs/common";
import { RunsService } from "./runs.service";

@Controller("runs")
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Get()
  findAll(@Query("agentId") agentId: string, @Query("orgId") orgId: string) {
    return this.runsService.findAll(agentId, orgId);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.runsService.findOne(id);
  }

  @Get(":id/logs")
  getLogs(@Param("id") id: string) {
    return this.runsService.getLogs(id);
  }

  @Post(":agentId/trigger")
  trigger(@Param("agentId") agentId: string) {
    return this.runsService.trigger(agentId);
  }
}
