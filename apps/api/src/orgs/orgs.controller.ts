import { Controller, Get, Post, Patch, Param, Body } from "@nestjs/common";
import { OrgsService } from "./orgs.service";

@Controller("orgs")
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.orgsService.findOne(id);
  }

  @Post()
  create(@Body() body: { name: string; slug: string }) {
    return this.orgsService.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.orgsService.update(id, body);
  }
}
