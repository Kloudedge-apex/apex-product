import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  getAllTemplates,
  getTemplateBySlug,
  getTemplatesByDomain,
  AgentTemplateConfig,
} from "./templates";

/**
 * Every method here is org-scoped: callers pass the verified `orgId` set by
 * `OrgScopeGuard`, and lookups always include `orgId` in the `where` clause
 * so a foreign agent id resolves to NotFound instead of returning another
 * tenant's data.
 */
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

  async findOne(id: string, orgId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id, orgId },
      include: {
        template: true,
        runs: {
          take: 10,
          orderBy: { startedAt: "desc" },
          include: {
            logs: { take: 50, orderBy: { createdAt: "desc" } },
          },
        },
      },
    });
    if (!agent) throw new NotFoundException("Agent not found");
    return agent;
  }

  async create(
    orgId: string,
    data: {
      templateId: string;
      name: string;
      domain: "SALES" | "MARKETING" | "OPS";
      config: Record<string, unknown>;
      schedule?: string;
    },
  ) {
    return this.prisma.agent.create({
      data: {
        orgId,
        templateId: data.templateId,
        name: data.name,
        domain: data.domain,
        config: data.config as unknown as Prisma.InputJsonValue,
        schedule: data.schedule,
        status: "PAUSED",
      },
      include: { template: true },
    });
  }

  async update(
    id: string,
    orgId: string,
    data: { name?: string; config?: Record<string, unknown>; schedule?: string },
  ) {
    await this.ensureOwned(id, orgId);
    return this.prisma.agent.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.config && { config: data.config as unknown as Prisma.InputJsonValue }),
        ...(data.schedule && { schedule: data.schedule }),
      },
    });
  }

  async remove(id: string, orgId: string) {
    await this.ensureOwned(id, orgId);
    return this.prisma.agent.delete({ where: { id } });
  }

  async deploy(id: string, orgId: string) {
    await this.ensureOwned(id, orgId);
    return this.prisma.agent.update({
      where: { id },
      data: { status: "ACTIVE" },
    });
  }

  async pause(id: string, orgId: string) {
    await this.ensureOwned(id, orgId);
    return this.prisma.agent.update({
      where: { id },
      data: { status: "PAUSED" },
    });
  }

  async getTemplates(domain?: string) {
    const count = await this.prisma.agentTemplate.count();
    if (count === 0) {
      const inCode = getAllTemplates();
      await this.prisma.agentTemplate.createMany({
        data: inCode.map((t) => ({
          name: t.name,
          domain: t.domain as "SALES" | "MARKETING" | "OPS",
          description: t.description,
          defaultConfig: t.defaultConfig as unknown as Prisma.InputJsonValue,
          requiredIntegrations: t.requiredIntegrations,
        })),
        skipDuplicates: true,
      });
    }

    return this.prisma.agentTemplate.findMany({
      where: domain ? { domain: domain as "SALES" | "MARKETING" | "OPS" } : {},
      orderBy: { name: "asc" },
    });
  }

  getTemplateConfigs(domain?: string): AgentTemplateConfig[] {
    if (domain) return getTemplatesByDomain(domain);
    return getAllTemplates();
  }

  getTemplateConfig(slug: string): AgentTemplateConfig {
    const template = getTemplateBySlug(slug);
    if (!template) throw new NotFoundException(`Template "${slug}" not found`);
    return template;
  }

  async createFromTemplate(
    orgId: string,
    data: {
      templateSlug: string;
      name?: string;
      configOverrides?: Record<string, unknown>;
      schedule?: string;
    },
  ) {
    const templateConfig = getTemplateBySlug(data.templateSlug);
    if (!templateConfig) {
      throw new BadRequestException(`Unknown template slug: "${data.templateSlug}"`);
    }

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
        orgId,
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

  async getAnalytics(agentId: string, orgId: string) {
    await this.ensureOwned(agentId, orgId);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

    const [totalRuns, runsLast7, runsLast30, completedRuns, tokenAgg, costAgg, memoryCount] =
      await Promise.all([
        this.prisma.agentRun.count({ where: { agentId, orgId } }),
        this.prisma.agentRun.count({
          where: { agentId, orgId, startedAt: { gte: weekStart } },
        }),
        this.prisma.agentRun.count({
          where: { agentId, orgId, startedAt: { gte: monthStart } },
        }),
        this.prisma.agentRun.count({
          where: { agentId, orgId, status: "COMPLETED" },
        }),
        this.prisma.agentRun.aggregate({
          where: { agentId, orgId },
          _sum: { tokensUsed: true },
        }),
        this.prisma.agentRun.aggregate({
          where: { agentId, orgId },
          _sum: { cost: true },
        }),
        this.prisma.agentMemory.count({ where: { agentId } }),
      ]);

    const successRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

    const avgTimeRaw: Array<{ avg_ms: string }> = await this.prisma.$queryRaw`
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000), 0)::text as avg_ms
      FROM "AgentRun"
      WHERE "agentId" = ${agentId} AND "orgId" = ${orgId}
        AND status = 'COMPLETED' AND "completedAt" IS NOT NULL
    `;
    const avgExecutionTime = Math.round(parseFloat(avgTimeRaw[0]?.avg_ms || "0"));

    const avgTokensPerRun =
      totalRuns > 0 ? Math.round((tokenAgg._sum.tokensUsed || 0) / totalRuns) : 0;

    const runsByDayRaw: Array<{ day: string; status: string; cnt: string }> = await this.prisma
      .$queryRaw`
      SELECT date_trunc('day', "startedAt")::date::text as day, status, COUNT(*)::text as cnt
      FROM "AgentRun"
      WHERE "agentId" = ${agentId} AND "orgId" = ${orgId} AND "startedAt" >= ${weekStart}
      GROUP BY day, status ORDER BY day ASC
    `;

    const dayMap = new Map<
      string,
      { date: string; total: number; completed: number; failed: number }
    >();
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

    const recentRunsRaw = await this.prisma.agentRun.findMany({
      where: { agentId, orgId },
      include: { _count: { select: { logs: true } } },
      orderBy: { startedAt: "desc" },
      take: 5,
    });
    const recentRuns = recentRunsRaw.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() || null,
      tokensUsed: r.tokensUsed,
      steps: r._count.logs,
    }));

    const toolLogs: Array<{ message: string }> = await this.prisma.$queryRaw`
      SELECT l.message
      FROM "AgentLog" l
      JOIN "AgentRun" r ON r.id = l."runId"
      WHERE r."agentId" = ${agentId} AND r."orgId" = ${orgId}
        AND l.message LIKE 'Tool call%'
    `;

    const toolUsage: Record<string, number> = {};
    for (const log of toolLogs) {
      const match = log.message.match(/Tool call -> (\w+)/);
      if (match) toolUsage[match[1]] = (toolUsage[match[1]] || 0) + 1;
    }

    return {
      totalRuns,
      runsLast7Days: runsLast7,
      runsLast30Days: runsLast30,
      successRate,
      avgExecutionTime,
      avgTokensPerRun,
      totalTokens: tokenAgg._sum.tokensUsed || 0,
      totalCost: costAgg._sum.cost || 0,
      runsByDay,
      memoryKeys: memoryCount,
      recentRuns,
      toolUsage,
    };
  }

  /** Throws NotFoundException if `agentId` doesn't belong to `orgId`. */
  private async ensureOwned(agentId: string, orgId: string): Promise<void> {
    const found = await this.prisma.agent.findFirst({
      where: { id: agentId, orgId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException("Agent not found");
  }
}
