import { Injectable, NotFoundException } from "@nestjs/common";
import { Plan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrgsService {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    name: string;
    slug?: string;
    clerkUserId: string;
    email: string;
    userName?: string;
  }) {
    const slug =
      data.slug ||
      data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
        "-" +
        Date.now().toString(36);

    const existingUser = await this.prisma.user.findUnique({
      where: { clerkId: data.clerkUserId },
    });
    if (existingUser) {
      const org = await this.prisma.org.findUnique({
        where: { id: existingUser.orgId },
        include: { users: true },
      });
      return org;
    }

    // Clerk's default JWT template omits the email claim, so `data.email` is
    // often "". User.email is @unique, so reuse-of-empty-string would collide
    // across users. Fall back to a deterministic per-user placeholder.
    const email =
      data.email && data.email.length > 0
        ? data.email
        : `${data.clerkUserId}@no-email.workforceos.local`;

    return this.prisma.org.create({
      data: {
        name: data.name,
        slug,
        plan: "TRIAL",
        trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        users: {
          create: {
            email,
            name: data.userName || data.name,
            role: "OWNER",
            clerkId: data.clerkUserId,
          },
        },
      },
      include: { users: true },
    });
  }

  async findOne(id: string) {
    const org = await this.prisma.org.findUnique({
      where: { id },
      include: { users: true, agents: true, integrations: true },
    });
    if (!org) throw new NotFoundException("Org not found");
    return org;
  }

  async findByClerkUser(clerkId: string) {
    const user = await this.prisma.user.findUnique({
      where: { clerkId },
      include: { org: { include: { agents: true, integrations: true } } },
    });
    if (!user) return null;
    return user.org;
  }

  async update(id: string, data: { name?: string; plan?: string; website?: string }) {
    return this.prisma.org.update({
      where: { id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.plan && { plan: data.plan as Plan }),
        ...(data.website !== undefined && { website: data.website || null }),
      },
    });
  }

  async getStats(orgId: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [
      activeAgents,
      pausedAgents,
      totalAgents,
      totalRuns,
      runsToday,
      runsThisWeek,
      completedRuns,
      integrationCount,
      tokenAgg,
      tokenTodayAgg,
      costAgg,
      costTodayAgg,
    ] = await Promise.all([
      this.prisma.agent.count({ where: { orgId, status: "ACTIVE" } }),
      this.prisma.agent.count({ where: { orgId, status: "PAUSED" } }),
      this.prisma.agent.count({ where: { orgId } }),
      this.prisma.agentRun.count({ where: { orgId } }),
      this.prisma.agentRun.count({ where: { orgId, startedAt: { gte: todayStart } } }),
      this.prisma.agentRun.count({ where: { orgId, startedAt: { gte: weekStart } } }),
      this.prisma.agentRun.count({ where: { orgId, status: "COMPLETED" } }),
      this.prisma.integration.count({ where: { orgId, status: "CONNECTED" } }),
      this.prisma.agentRun.aggregate({ where: { orgId }, _sum: { tokensUsed: true } }),
      this.prisma.agentRun.aggregate({
        where: { orgId, startedAt: { gte: todayStart } },
        _sum: { tokensUsed: true },
      }),
      this.prisma.agentRun.aggregate({ where: { orgId }, _sum: { cost: true } }),
      this.prisma.agentRun.aggregate({
        where: { orgId, startedAt: { gte: todayStart } },
        _sum: { cost: true },
      }),
    ]);

    const successRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 100) : 0;

    const runsByDayRaw: Array<{ day: string; status: string; cnt: string }> = await this.prisma
      .$queryRaw`
      SELECT date_trunc('day', "startedAt")::date::text as day, status, COUNT(*)::text as cnt
      FROM "AgentRun"
      WHERE "orgId" = ${orgId} AND "startedAt" >= ${weekStart}
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

    const tokensByDayRaw: Array<{ day: string; tokens: string; cost: string }> = await this.prisma
      .$queryRaw`
      SELECT date_trunc('day', "startedAt")::date::text as day,
             COALESCE(SUM("tokensUsed"), 0)::text as tokens,
             COALESCE(SUM(cost), 0)::text as cost
      FROM "AgentRun"
      WHERE "orgId" = ${orgId} AND "startedAt" >= ${weekStart}
      GROUP BY day ORDER BY day ASC
    `;

    const tokenDayMap = new Map<string, { date: string; tokens: number; cost: number }>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split("T")[0];
      tokenDayMap.set(key, { date: key, tokens: 0, cost: 0 });
    }
    for (const row of tokensByDayRaw) {
      const entry = tokenDayMap.get(row.day);
      if (entry) {
        entry.tokens = parseInt(row.tokens);
        entry.cost = parseFloat(row.cost);
      }
    }
    const tokensByDay = Array.from(tokenDayMap.values());

    const topAgentsRaw: Array<{
      id: string;
      name: string;
      domain: string;
      runs: string;
      completed: string;
      tokens: string;
    }> = await this.prisma.$queryRaw`
      SELECT a.id, a.name, a.domain::text,
             COUNT(r.id)::text as runs,
             COUNT(CASE WHEN r.status = 'COMPLETED' THEN 1 END)::text as completed,
             COALESCE(AVG(r."tokensUsed"), 0)::text as tokens
      FROM "Agent" a LEFT JOIN "AgentRun" r ON r."agentId" = a.id AND r."startedAt" >= ${weekStart}
      WHERE a."orgId" = ${orgId}
      GROUP BY a.id, a.name, a.domain
      ORDER BY runs DESC LIMIT 5
    `;

    const topAgents = topAgentsRaw.map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      runs: parseInt(a.runs),
      successRate:
        parseInt(a.runs) > 0
          ? Math.round((parseInt(a.completed) / parseInt(a.runs)) * 100)
          : 0,
      avgTokens: Math.round(parseFloat(a.tokens)),
    }));

    const recentFailures = await this.prisma.agentRun.findMany({
      where: { orgId, status: "FAILED" },
      include: {
        agent: { select: { name: true } },
        logs: { where: { level: "ERROR" }, take: 1, orderBy: { createdAt: "desc" } },
      },
      orderBy: { startedAt: "desc" },
      take: 5,
    });
    const recentFailuresMapped = recentFailures.map((f) => ({
      runId: f.id,
      agentName: f.agent.name,
      error: f.logs[0]?.message || "Unknown error",
      timestamp: f.startedAt.toISOString(),
    }));

    const domainCounts = await this.prisma.agent.groupBy({
      by: ["domain"],
      where: { orgId },
      _count: true,
    });
    const agentsByDomain: Record<string, number> = { SALES: 0, MARKETING: 0, OPS: 0 };
    for (const d of domainCounts) agentsByDomain[d.domain] = d._count;

    const domainRunCounts: Array<{ domain: string; cnt: string }> = await this.prisma.$queryRaw`
      SELECT a.domain::text, COUNT(r.id)::text as cnt
      FROM "Agent" a LEFT JOIN "AgentRun" r ON r."agentId" = a.id AND r."startedAt" >= ${weekStart}
      WHERE a."orgId" = ${orgId}
      GROUP BY a.domain
    `;
    const runsByDomain: Record<string, number> = { SALES: 0, MARKETING: 0, OPS: 0 };
    for (const d of domainRunCounts) runsByDomain[d.domain] = parseInt(d.cnt);

    return {
      activeAgents,
      pausedAgents,
      totalAgents,
      totalRuns,
      runsToday,
      runsThisWeek,
      successRate,
      integrations: integrationCount,
      tokensUsed: tokenAgg._sum.tokensUsed || 0,
      tokensToday: tokenTodayAgg._sum.tokensUsed || 0,
      totalCost: costAgg._sum.cost || 0,
      costToday: costTodayAgg._sum.cost || 0,
      runsByDay,
      tokensByDay,
      topAgents,
      recentFailures: recentFailuresMapped,
      agentsByDomain,
      runsByDomain,
    };
  }
}
