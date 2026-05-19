import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Inject,
  forwardRef,
  NotFoundException,
} from "@nestjs/common";
import { AgentsService } from "./agents.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeService } from "../runtime/runtime.service";
import { MemoryService } from "../runtime/memory.service";
import { OrgId } from "../common/org-context.decorator";
import {
  CreateAgentDto,
  UpdateAgentDto,
  SetMemoryDto,
  CreateFromTemplateDto,
} from "../common/dto/agents.dto";

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

  @Get("template-configs")
  getTemplateConfigs(@Query("domain") domain?: string) {
    return this.agentsService.getTemplateConfigs(domain);
  }

  @Get("template-configs/:slug")
  getTemplateConfig(@Param("slug") slug: string) {
    return this.agentsService.getTemplateConfig(slug);
  }

  @Post("from-template")
  createFromTemplate(@OrgId() orgId: string, @Body() body: CreateFromTemplateDto) {
    return this.agentsService.createFromTemplate(orgId, {
      templateSlug: body.templateSlug,
      name: body.name,
      configOverrides: body.configOverrides,
      schedule: body.schedule,
    });
  }

  @Get()
  findAll(@OrgId() orgId: string) {
    return this.agentsService.findAll(orgId);
  }

  @Get(":id/analytics")
  getAnalytics(@OrgId() orgId: string, @Param("id") id: string) {
    return this.agentsService.getAnalytics(id, orgId);
  }

  @Get(":id")
  findOne(@OrgId() orgId: string, @Param("id") id: string) {
    return this.agentsService.findOne(id, orgId);
  }

  @Post()
  create(@OrgId() orgId: string, @Body() body: CreateAgentDto) {
    return this.agentsService.create(orgId, {
      templateId: body.templateId,
      name: body.name,
      domain: body.domain,
      config: body.config,
      schedule: body.schedule,
    });
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id") id: string,
    @Body() body: UpdateAgentDto,
  ) {
    return this.agentsService.update(id, orgId, body);
  }

  @Delete(":id")
  remove(@OrgId() orgId: string, @Param("id") id: string) {
    return this.agentsService.remove(id, orgId);
  }

  @Post(":id/deploy")
  deploy(@OrgId() orgId: string, @Param("id") id: string) {
    return this.agentsService.deploy(id, orgId);
  }

  @Post(":id/pause")
  pause(@OrgId() orgId: string, @Param("id") id: string) {
    return this.agentsService.pause(id, orgId);
  }

  @Post(":id/runs")
  async triggerRun(@OrgId() orgId: string, @Param("id") agentId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException("Agent not found");
    return this.runtime.triggerRun(agentId, orgId);
  }

  @Get(":id/runs")
  async getAgentRuns(
    @OrgId() orgId: string,
    @Param("id") agentId: string,
    @Query("limit") limit?: number,
  ) {
    // Verify the agent belongs to the caller's org before listing its runs.
    const owned = await this.prisma.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException("Agent not found");

    const take = Math.min(limit || 50, 100);
    const [runs, total] = await Promise.all([
      this.prisma.agentRun.findMany({
        where: { agentId, orgId },
        include: {
          logs: { orderBy: { createdAt: "asc" } },
          steps: { orderBy: { stepIndex: "asc" } },
          _count: { select: { steps: true, logs: true } },
        },
        orderBy: { startedAt: "desc" },
        take,
      }),
      this.prisma.agentRun.count({ where: { agentId, orgId } }),
    ]);
    return { runs, total };
  }

  @Get(":id/memories")
  async getMemories(@OrgId() orgId: string, @Param("id") agentId: string) {
    await this.ensureAgent(agentId, orgId);
    return this.memoryService.getAll(agentId);
  }

  @Post(":id/memories")
  async setMemory(
    @OrgId() orgId: string,
    @Param("id") agentId: string,
    @Body() body: SetMemoryDto,
  ) {
    await this.ensureAgent(agentId, orgId);
    await this.memoryService.set(agentId, body.key, body.value);
    return { success: true };
  }

  @Delete(":id/memories/:key")
  async deleteMemory(
    @OrgId() orgId: string,
    @Param("id") agentId: string,
    @Param("key") key: string,
  ) {
    await this.ensureAgent(agentId, orgId);
    await this.memoryService.delete(agentId, key);
    return { success: true };
  }

  @Delete(":id/memories")
  async clearMemories(@OrgId() orgId: string, @Param("id") agentId: string) {
    await this.ensureAgent(agentId, orgId);
    await this.memoryService.deleteAll(agentId);
    return { success: true };
  }

  private async ensureAgent(agentId: string, orgId: string): Promise<void> {
    const found = await this.prisma.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException("Agent not found");
  }
}
