import { Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

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
}
