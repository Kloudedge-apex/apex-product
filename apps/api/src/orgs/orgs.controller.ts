import { Controller, Get, Post, Patch, Param, Body } from "@nestjs/common";
import { OrgsService } from "./orgs.service";
import { CreateOrgDto, UpdateOrgDto } from "../common/dto/orgs.dto";

@Controller("orgs")
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @Post()
  create(@Body() body: CreateOrgDto) {
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
  update(@Param("id") id: string, @Body() body: UpdateOrgDto) {
    return this.orgsService.update(id, body);
  }

  @Get(":id/stats")
  getStats(@Param("id") id: string) {
    return this.orgsService.getStats(id);
  }
}
