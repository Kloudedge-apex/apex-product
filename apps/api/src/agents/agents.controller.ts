import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Inject, forwardRef } from "@nestjs/common";
import { AgentsService } from "./agents.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeService } from "../runtime/runtime.service";
import { MemoryService } from "../runtime/memory.service";

@Controller("agents")
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => RuntimeService))
    private readonly runtime: RuntimeService,
    private readonly memoryService: MemoryService,
  ) {}

  @Get("templates")
  getTemplates(@Query("domain") domain?: string) {
    return this.agentsService.getTemplates(domain);
  }

  @Get()
  findAll(@Query("orgId") orgId: string) {
    return this.agentsService.findAll(orgId);
  }

  @Get(":id/analytics")
  getAnalytics(@Param("id") id: string) {
    return this.agentsService.getAnalytics(id);
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

  // Trigger a run for an agent (goes through the runtime queue + worker)
  @Post(":id/runs")
  async triggerRun(@Param("id") agentId: string, @Body() body?: { orgId?: string }) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error("Agent not found");
    const orgId = body?.orgId || agent.orgId;
    return this.runtime.triggerRun(agentId, orgId);
  }

  // Get runs for an agent
  @Get(":id/runs")
  async getAgentRuns(@Param("id") agentId: string) {
    return this.prisma.agentRun.findMany({
      where: { agentId },
      include: { logs: { orderBy: { createdAt: "asc" } } },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
  }

  // Get agent memories
  @Get(":id/memories")
  async getMemories(@Param("id") agentId: string) {
    return this.memoryService.getAll(agentId);
  }

  // Update a memory entry
  @Post(":id/memories")
  async setMemory(@Param("id") agentId: string, @Body() body: { key: string; value: unknown }) {
    await this.memoryService.set(agentId, body.key, body.value);
    return { success: true };
  }

  // Delete a memory entry
  @Delete(":id/memories/:key")
  async deleteMemory(@Param("id") agentId: string, @Param("key") key: string) {
    await this.memoryService.delete(agentId, key);
    return { success: true };
  }

  // Clear all memories
  @Delete(":id/memories")
  async clearMemories(@Param("id") agentId: string) {
    await this.memoryService.deleteAll(agentId);
    return { success: true };
  }
}
