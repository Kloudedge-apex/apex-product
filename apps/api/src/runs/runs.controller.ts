import { Controller, Get, Post, Param, Query, Body } from "@nestjs/common";
import { RunsService } from "./runs.service";

@Controller("runs")
export class RunsController {
  constructor(private readonly runsService: RunsService) {}

  @Get()
  findByOrg(
    @Query("orgId") orgId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("status") status?: string,
    @Query("agentId") agentId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("search") search?: string,
  ) {
    return this.runsService.findByOrg(orgId, {
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
      status: status || undefined,
      agentId: agentId || undefined,
      from: from || undefined,
      to: to || undefined,
      search: search || undefined,
    });
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
