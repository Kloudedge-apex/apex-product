import { Controller, Post, Get, Param, Body, Query, NotFoundException } from "@nestjs/common";
import { RuntimeService } from "./runtime.service";
import { TriggerRunBodyDto } from "../common/dto/runtime.dto";
import { PrismaService } from "../prisma/prisma.service";

@Controller("runtime")
export class RuntimeController {
  constructor(
    private readonly runtime: RuntimeService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("trigger/:agentId")
  triggerRun(@Param("agentId") agentId: string, @Body() body: TriggerRunBodyDto) {
    return this.runtime.triggerRun(agentId, body.orgId);
  }

  @Post("cancel/:runId")
  cancelRun(@Param("runId") runId: string) {
    return this.runtime.cancelRun(runId);
  }

  @Get("queue/stats")
  getQueueStats() {
    return this.runtime.getQueueStats();
  }
}
