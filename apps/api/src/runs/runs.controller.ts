import { Controller, Get, Post, Param, Query, Body } from "@nestjs/common";
import { RunsService } from "./runs.service";

@Controller("runs")
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Get()
  findByOrg(@Query("orgId") orgId: string, @Query("limit") limit?: string) {
    return this.runsService.findByOrg(orgId, limit ? parseInt(limit) : 50);
  }

  @Get("agent/:agentId")
  findByAgent(@Param("agentId") agentId: string, @Query("limit") limit?: string) {
    return this.runsService.findByAgent(agentId, limit ? parseInt(limit) : 50);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.runsService.findOne(id);
  }

  @Post()
  create(@Body() body: { agentId: string; orgId: string }) {
    return this.runsService.create(body);
  }
}
