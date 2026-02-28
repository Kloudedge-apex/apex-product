import { Controller, Post, Get, Param, Body } from "@nestjs/common";
import { RuntimeService } from "./runtime.service";

@Controller("agents")
export class RuntimeController {
  constructor(private readonly runtime: RuntimeService) {}

  @Post(":id/runs")
  triggerRun(@Param("id") agentId: string, @Body() body: { orgId: string }) {
    return this.runtime.triggerRun(agentId, body.orgId);
  }

  @Post(":id/runs/:runId/cancel")
  cancelRun(@Param("runId") runId: string) {
    return this.runtime.cancelRun(runId);
  }

  @Get("queue/stats")
  getQueueStats() {
    return this.runtime.getQueueStats();
  }
}
