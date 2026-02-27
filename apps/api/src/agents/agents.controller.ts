import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from "@nestjs/common";
import { AgentsService } from "./agents.service";

@Controller("agents")
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Get("templates")
  getTemplates(@Query("domain") domain?: string) {
    return this.agentsService.getTemplates(domain);
  }

  @Get()
  findAll(@Query("orgId") orgId: string) {
    return this.agentsService.findAll(orgId);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.agentsService.findOne(id);
  }

  @Post()
  create(@Body() body: {
    orgId: string;
    templateId: string;
    name: string;
    domain: "SALES" | "MARKETING" | "OPS";
    config: Record<string, unknown>;
    schedule?: string;
  }) {
    return this.agentsService.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: { name?: string; config?: Record<string, unknown>; schedule?: string }) {
    return this.agentsService.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.agentsService.remove(id);
  }

  @Post(":id/deploy")
  deploy(@Param("id") id: string) {
    return this.agentsService.deploy(id);
  }

  @Post(":id/pause")
  pause(@Param("id") id: string) {
    return this.agentsService.pause(id);
  }
}
