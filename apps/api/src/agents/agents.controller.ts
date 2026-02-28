import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from "@nestjs/common";
import { AgentsService } from "./agents.service";
import { PrismaService } from "../prisma/prisma.service";

@Controller("agents")
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly prisma: PrismaService,
  ) {}

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

  // Trigger a run for an agent
  @Post(":id/runs")
  async triggerRun(@Param("id") agentId: string, @Body() body?: { orgId?: string }) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error("Agent not found");
    const orgId = body?.orgId || agent.orgId;
    const run = await this.prisma.agentRun.create({
      data: { agentId, orgId, status: "QUEUED" },
    });
    await this.prisma.agentLog.create({
      data: { runId: run.id, level: "INFO", message: "Run queued for execution" },
    });
    return run;
  }

  // Get runs for an agent
  @Get(":id/runs")
  async getAgentRuns(@Param("id") agentId: string) {
    return this.prisma.agentRun.findMany({
      where: { agentId },
      include: { logs: { take: 5, orderBy: { createdAt: "desc" } } },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  }
}
