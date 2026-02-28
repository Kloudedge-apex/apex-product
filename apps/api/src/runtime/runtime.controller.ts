import { Controller, Post, Get, Param, Body } from "@nestjs/common";
import { RuntimeService } from "./runtime.service";

@Controller("runtime")
export class RuntimeController {
  constructor(private readonly runtime: RuntimeService) {}

  @Post("trigger/:agentId")
  triggerRun(@Param("agentId") agentId: string, @Body() body: { orgId: string }) {
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
