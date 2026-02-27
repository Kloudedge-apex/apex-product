import { Controller, Get, Post, Delete, Param, Body, Query } from "@nestjs/common";
import { IntegrationsService } from "./integrations.service";

@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  findAll(@Query("orgId") orgId: string) {
    return this.integrationsService.findAll(orgId);
  }

  @Post("connect")
  connect(@Body() body: { orgId: string; provider: string }) {
    return this.integrationsService.connect(body);
  }

  @Delete(":id")
  disconnect(@Param("id") id: string) {
    return this.integrationsService.disconnect(id);
  }
}
