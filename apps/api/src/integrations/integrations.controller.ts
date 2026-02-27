import { Controller, Get, Post, Delete, Param, Body, Query } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";

@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  findAll(@Query("orgId") orgId: string) {
    return this.integrationsService.findAll(orgId);
  }

  @Post()
  create(@Body() body: { orgId: string; provider: string; credentials: Record<string, unknown> }) {
    return this.integrationsService.create(body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.integrationsService.remove(id);
  }
}
