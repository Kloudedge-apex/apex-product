import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { getAllTemplates, getTemplateBySlug, getTemplatesByDomain, AgentTemplateConfig } from "./templates";

@Injectable()
export class AgentsService {
  constructor(private prisma: PrismaService) {}

  async findAll(orgId: string) {
    return this.prisma.agent.findMany({
      where: { orgId },
      include: { template: true, _count: { select: { runs: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(id: string, orgId?: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: {
        template: true,
        runs: { take: 10, orderBy: { startedAt: "desc" }, include: { logs: { take: 50, orderBy: { createdAt: "desc" } } } },
      },
    });
    if (!agent) throw new NotFoundException("Agent not found");
    if (orgId && agent.orgId !== orgId) throw new ForbiddenException();
    return agent;
  }

  async create(data: {
    orgId: string;
    templateId: string;
    name: string;
    domain: "SALES" | "MARKETING" | "OPS";
    config: Record<string, unknown>;
    schedule?: string;
  }) {
    return this.prisma.agent.create({
      data: {
        orgId: data.orgId,
        templateId: data.templateId,
        name: data.name,
        domain: data.domain,
        config: data.config as any,
        schedule: data.schedule,
        status: "PAUSED",
      },
      include: { template: true },
    });
  }

  async update(id: string, data: { name?: string; config?: Record<string, unknown>; schedule?: string }) {
    return this.prisma.agent.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.config && { config: data.config as any }),
        ...(data.schedule && { schedule: data.schedule }),
      },
    });
  }

  async remove(id: string) {
    return this.prisma.agent.delete({ where: { id } });
  }

  async deploy(id: string) {
    return this.prisma.agent.update({
      where: { id },
      data: { status: "ACTIVE" },
    });
  }

  async pause(id: string) {
    return this.prisma.agent.update({
      where: { id },
      data: { status: "PAUSED" },
    });
  }

  async getTemplates(domain?: string) {
    return this.prisma.agentTemplate.findMany({
      where: domain ? { domain: domain as any } : {},
      orderBy: { name: "asc" },
    });
  }

  /** Get all in-code template configs (with full system prompts, tools, etc.) */
  getTemplateConfigs(domain?: string): AgentTemplateConfig[] {
    if (domain) return getTemplatesByDomain(domain);
    return getAllTemplates();
  }

  /** Get a single template config by slug */
  getTemplateConfig(slug: string): AgentTemplateConfig {
    const template = getTemplateBySlug(slug);
    if (!template) throw new NotFoundException(`Template "${slug}" not found`);
    return template;
  }

  /** Create an agent from a template slug */
  async createFromTemplate(data: {
    orgId: string;
    templateSlug: string;
    name?: string;
    configOverrides?: Record<string, unknown>;
    schedule?: string;
  }) {
    const templateConfig = getTemplateBySlug(data.templateSlug);
    if (!templateConfig) {
      throw new BadRequestException(`Unknown template slug: "${data.templateSlug}"`);
    }

    // Find or create the DB template record
    let dbTemplate = await this.prisma.agentTemplate.findFirst({
      where: { name: templateConfig.name, domain: templateConfig.domain },
    });

    if (!dbTemplate) {
      dbTemplate = await this.prisma.agentTemplate.create({
        data: {
          name: templateConfig.name,
          domain: templateConfig.domain,
          description: templateConfig.description,
          defaultConfig: templateConfig.defaultConfig as unknown as Prisma.InputJsonValue,
          requiredIntegrations: templateConfig.requiredIntegrations,
        },
      });
    }

    const mergedConfig = {
      ...templateConfig.defaultConfig,
      ...data.configOverrides,
      systemPrompt: templateConfig.systemPrompt,
      availableTools: templateConfig.availableTools,
    };

    return this.prisma.agent.create({
      data: {
        orgId: data.orgId,
        templateId: dbTemplate.id,
        name: data.name || templateConfig.name,
        domain: templateConfig.domain,
        config: mergedConfig as unknown as Prisma.InputJsonValue,
        schedule: data.schedule || templateConfig.defaultSchedule,
        status: "PAUSED",
      },
      include: { template: true },
    });
  }

  async getAnalytics(agentId: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

    const [totalRuns, runsLast7, runsLast30, completedRuns, tokenAgg, costAgg, memoryCount] = await Promise.all([
      this.prisma.agentRun.count({ where: { agentId } }),
      this.prisma.agentRun.count({ where: { agentId, startedAt: { gte: weekStart } } }),
      this.prisma.agentRun.count({ where: { agentId, startedAt: { gte: monthStart } } }),
      this.prisma.agentRun.count({ where: { agentId, status: "COMPLETED" } }),
      this.prisma.agentRun.aggregate({ where: { agentId }, _sum: { tokensUsed: true } }),
      this.prisma.agentRun.aggregate({ where: { agentId }, _sum: { cost: true } }),
      this.prisma.agentMemory.count({ where: { agentId } }),
    ]);

    const successRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

    // Average execution time (completed runs only)
    const avgTimeRaw: Array<{ avg_ms: string }> = await this.prisma.$queryRawUnsafe(`
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000), 0)::text as avg_ms
      FROM "AgentRun" WHERE "agentId" = $1 AND status = 'COMPLETED' AND "completedAt" IS NOT NULL
    `, agentId);
    const avgExecutionTime = Math.round(parseFloat(avgTimeRaw[0]?.avg_ms || "0"));

    const avgTokensPerRun = totalRuns > 0 ? Math.round((tokenAgg._sum.tokensUsed || 0) / totalRuns) : 0;

    // Runs by day (last 7 days)
    const runsByDayRaw: Array<{ day: string; status: string; cnt: string }> = await this.prisma.$queryRawUnsafe(`
      SELECT date_trunc('day', "startedAt")::date::text as day, status, COUNT(*)::text as cnt
      FROM "AgentRun" WHERE "agentId" = $1 AND "startedAt" >= $2
      GROUP BY day, status ORDER BY day ASC
    `, agentId, weekStart);

    const dayMap = new Map<string, { date: string; total: number; completed: number; failed: number }>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      dayMap.set(key, { date: key, total: 0, completed: 0, failed: 0 });
    }
    for (const row of runsByDayRaw) {
      const entry = dayMap.get(row.day);
      if (entry) {
        const count = parseInt(row.cnt);
        entry.total += count;
        if (row.status === "COMPLETED") entry.completed += count;
        if (row.status === "FAILED") entry.failed += count;
      }
    }
    const runsByDay = Array.from(dayMap.values());

    // Recent runs
    const recentRunsRaw = await this.prisma.agentRun.findMany({
      where: { agentId },
      include: { _count: { select: { logs: true } } },
      orderBy: { startedAt: "desc" },
      take: 5,
    });
    const recentRuns = recentRunsRaw.map((r) => ({
      id: r.id, status: r.status,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() || null,
      tokensUsed: r.tokensUsed,
      steps: r._count.logs,
    }));

    // Tool usage: parse logs for "Tool call -> toolname"
    const toolLogs: Array<{ message: string }> = await this.prisma.$queryRawUnsafe(`
      SELECT l.message FROM "AgentLog" l
      JOIN "AgentRun" r ON r.id = l."runId"
      WHERE r."agentId" = $1 AND l.message LIKE 'Tool call%'
    `, agentId);

    const toolUsage: Record<string, number> = {};
    for (const log of toolLogs) {
      const match = log.message.match(/Tool call -> (\w+)/);
      if (match) {
        toolUsage[match[1]] = (toolUsage[match[1]] || 0) + 1;
      }
    }

    return {
      totalRuns, runsLast7Days: runsLast7, runsLast30Days: runsLast30,
      successRate, avgExecutionTime, avgTokensPerRun,
      totalTokens: tokenAgg._sum.tokensUsed || 0,
      totalCost: costAgg._sum.cost || 0,
      runsByDay, memoryKeys: memoryCount, recentRuns, toolUsage,
    };
  }
}
