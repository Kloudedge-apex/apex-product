import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OrgsService {
  constructor(private prisma: PrismaService) {}

  async create(data: { name: string; slug: string; clerkUserId: string; email: string; userName?: string }) {
    const org = await this.prisma.org.create({
      data: {
        name: data.name,
        slug: data.slug,
        plan: "TRIAL",
        trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days
        users: {
          create: {
            email: data.email,
            name: data.userName,
            role: "OWNER",
            clerkId: data.clerkUserId,
          },
        },
      },
      include: { users: true },
    });
    return org;
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

  async update(id: string, data: { name?: string; plan?: any }) {
    return this.prisma.org.update({
      where: { id },
      data,
    });
  }

  async getStats(orgId: string) {
    const [agentCount, runCount, integrationCount, tokenSum] = await Promise.all([
      this.prisma.agent.count({ where: { orgId } }),
      this.prisma.agentRun.count({ where: { orgId } }),
      this.prisma.integration.count({ where: { orgId, status: "CONNECTED" } }),
      this.prisma.agentRun.aggregate({ where: { orgId }, _sum: { tokensUsed: true } }),
    ]);
    return {
      activeAgents: agentCount,
      totalRuns: runCount,
      integrations: integrationCount,
      tokensUsed: tokenSum._sum.tokensUsed || 0,
    };
  }
}
