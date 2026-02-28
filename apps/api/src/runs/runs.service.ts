import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class RunsService {
  constructor(private prisma: PrismaService) {}

  async findByOrg(orgId: string, opts: {
    limit?: number; offset?: number; status?: string;
    agentId?: string; from?: string; to?: string; search?: string;
  } = {}) {
    const { limit = 50, offset = 0, status, agentId, from, to, search } = opts;
    const where: any = { orgId };
    if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      where.status = { in: statuses };
    }
    if (agentId) where.agentId = agentId;
    if (from || to) {
      where.startedAt = {};
      if (from) where.startedAt.gte = new Date(from);
      if (to) where.startedAt.lte = new Date(to);
    }

    const runs = await this.prisma.agentRun.findMany({
      where,
      include: {
        agent: { select: { name: true, domain: true } },
        logs: { orderBy: { createdAt: "desc" }, take: 20 },
        _count: { select: { logs: true } },
      },
      orderBy: { startedAt: "desc" },
      take: limit,
      skip: offset,
    });

    // Step count and search filter
    let results = runs.map((run) => {
      const stepCount = run.logs.filter((l) => l.level === "INFO" && l.message.startsWith("Step")).length;
      return { ...run, stepCount };
    });

    if (search) {
      const q = search.toLowerCase();
      results = results.filter((r) =>
        r.agent?.name?.toLowerCase().includes(q) ||
        r.logs.some((l) => l.message.toLowerCase().includes(q)) ||
        (r.result && JSON.stringify(r.result).toLowerCase().includes(q))
      );
    }

    const total = await this.prisma.agentRun.count({ where });
    return { runs: results, total, limit, offset };
  }

  async findByAgent(agentId: string, limit = 50) {
    return this.prisma.agentRun.findMany({
      where: { agentId },
      include: { logs: { orderBy: { createdAt: "desc" } } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
  }

  async findOne(id: string) {
    return this.prisma.agentRun.findUnique({
      where: { id },
      include: { agent: true, logs: { orderBy: { createdAt: "asc" } } },
    });
  }

  async create(data: { agentId: string; orgId: string }) {
    return this.prisma.agentRun.create({
      data: {
        agentId: data.agentId,
        orgId: data.orgId,
        status: "QUEUED",
      },
    });
  }

  async updateStatus(id: string, status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED", result?: any, tokensUsed?: number, cost?: number) {
    return this.prisma.agentRun.update({
      where: { id },
      data: {
        status,
        ...(status === "COMPLETED" || status === "FAILED" ? { completedAt: new Date() } : {}),
        ...(result && { result }),
        ...(tokensUsed && { tokensUsed }),
        ...(cost && { cost }),
      },
    });
  }

  async addLog(runId: string, level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, metadata?: any) {
    return this.prisma.agentLog.create({
      data: { runId, level, message, metadata },
    });
  }
}
