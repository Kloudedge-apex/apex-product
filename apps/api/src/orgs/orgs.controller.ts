import { Controller, Get, Post, Patch, Param, Body, Query } from "@nestjs/common";
import { OrgsService } from "./orgs.service";

@Controller("orgs")
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @Post()
  create(@Body() body: { name: string; slug?: string; clerkUserId: string; email: string; userName?: string }) {
    return this.orgsService.create(body);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.orgsService.findOne(id);
  }

  @Get("by-clerk/:clerkId")
  findByClerkUser(@Param("clerkId") clerkId: string) {
    return this.orgsService.findByClerkUser(clerkId);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: { name?: string; plan?: string }) {
    return this.orgsService.update(id, body);
  }

  @Get(":id/stats")
  getStats(@Param("id") id: string) {
    return this.orgsService.getStats(id);
  }
}
