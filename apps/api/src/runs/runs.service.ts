import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, RunStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class RunsService {
  constructor(private prisma: PrismaService) {}

  async findByOrg(
    orgId: string,
    opts: {
      limit?: number;
      offset?: number;
      status?: string;
      agentId?: string;
      from?: string;
      to?: string;
      search?: string;
    } = {},
  ) {
    const { limit = 50, offset = 0, status, agentId, from, to, search } = opts;

    const where: Prisma.AgentRunWhereInput = { orgId };
    if (status) {
      const statuses = status
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (statuses.length > 0) {
        where.status = { in: statuses as RunStatus[] };
      }
    }
    if (agentId) where.agentId = agentId;
    if (from || to) {
      where.startedAt = {};
      if (from) (where.startedAt as Prisma.DateTimeFilter).gte = new Date(from);
      if (to) (where.startedAt as Prisma.DateTimeFilter).lte = new Date(to);
    }

    // Search applies to agent.name and log messages. Doing this in SQL keeps
    // pagination correct — previously search filtered after paging, which made
    // `total` inconsistent with `runs`.
    if (search && search.length > 0) {
      where.OR = [
        { agent: { is: { name: { contains: search, mode: "insensitive" } } } },
        { logs: { some: { message: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const [runs, total] = await this.prisma.$transaction([
      this.prisma.agentRun.findMany({
        where,
        include: {
          agent: { select: { name: true, domain: true } },
          logs: { orderBy: { createdAt: "desc" }, take: 20 },
          _count: { select: { logs: true } },
        },
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.agentRun.count({ where }),
    ]);

    const results = runs.map((run) => {
      const stepCount = run.logs.filter(
        (l) => l.level === "INFO" && l.message.startsWith("Step"),
      ).length;
      return { ...run, stepCount };
    });

    return { runs: results, total, limit, offset };
  }

  async findByAgent(agentId: string, orgId: string, limit = 50) {
    return this.prisma.agentRun.findMany({
      where: { agentId, orgId },
      include: { logs: { orderBy: { createdAt: "desc" } } },
      orderBy: { startedAt: "desc" },
      take: Math.min(limit, 100),
    });
  }

  async findOne(id: string, orgId: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { id, orgId },
      include: {
        agent: { select: { id: true, name: true, domain: true, templateId: true } },
        logs: { orderBy: { createdAt: "asc" } },
        steps: { orderBy: { stepIndex: "asc" } },
      },
    });
    if (!run) throw new NotFoundException("Run not found");
    return run;
  }

  async create(orgId: string, data: { agentId: string }) {
    return this.prisma.agentRun.create({
      data: {
        agentId: data.agentId,
        orgId,
        status: "QUEUED",
      },
    });
  }

  async updateStatus(
    id: string,
    status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
    result?: Prisma.InputJsonValue,
    tokensUsed?: number,
    cost?: number,
  ) {
    return this.prisma.agentRun.update({
      where: { id },
      data: {
        status,
        ...(status === "COMPLETED" || status === "FAILED"
          ? { completedAt: new Date() }
          : {}),
        ...(result !== undefined && { result }),
        ...(tokensUsed && { tokensUsed }),
        ...(cost && { cost }),
      },
    });
  }

  async addLog(
    runId: string,
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    return this.prisma.agentLog.create({
      data: { runId, level, message, metadata },
    });
  }
}
