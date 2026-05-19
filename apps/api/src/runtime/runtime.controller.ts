import {
  Controller,
  Post,
  Get,
  Param,
  NotFoundException,
} from "@nestjs/common";
import { RuntimeService } from "./runtime.service";
import { PrismaService } from "../prisma/prisma.service";
import { OrgId } from "../common/org-context.decorator";

@Controller("runtime")
export class RuntimeController {
  constructor(
    private readonly runtime: RuntimeService,
    private readonly prisma: PrismaService,
  ) {}

  @Post("trigger/:agentId")
  async triggerRun(
    @OrgId() orgId: string,
    @Param("agentId") agentId: string,
  ) {
    const owned = await this.prisma.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException("Agent not found");
    return this.runtime.triggerRun(agentId, orgId);
  }

  @Post("cancel/:runId")
  async cancelRun(
    @OrgId() orgId: string,
    @Param("runId") runId: string,
  ) {
    const owned = await this.prisma.agentRun.findFirst({
      where: { id: runId, orgId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException("Run not found");
    return this.runtime.cancelRun(runId);
  }

  @Get("queue/stats")
  getQueueStats() {
    return this.runtime.getQueueStats();
  }
}
