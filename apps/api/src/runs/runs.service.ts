import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class RunsService {
  constructor(private prisma: PrismaService) {}

  async findByOrg(orgId: string, limit = 50) {
    return this.prisma.agentRun.findMany({
      where: { orgId },
      include: { agent: { select: { name: true, domain: true } }, logs: { take: 5, orderBy: { createdAt: "desc" } } },
      orderBy: { startedAt: "desc" },
      take: limit,
    });
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
