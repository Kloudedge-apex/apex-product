import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class IntegrationsService {
  constructor(private prisma: PrismaService) {}

  async findAll(orgId: string) {
    return this.prisma.integration.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(data: { orgId: string; provider: string; credentials: Record<string, unknown> }) {
    return this.prisma.integration.create({
      data: {
        orgId: data.orgId,
        provider: data.provider,
        credentials: data.credentials as any,
        status: "CONNECTED",
      },
    });
  }

  async remove(id: string) {
    return this.prisma.integration.delete({ where: { id } });
  }

  async updateStatus(id: string, status: "PENDING" | "CONNECTED" | "ERROR" | "REVOKED") {
    return this.prisma.integration.update({
      where: { id },
      data: { status },
    });
  }
}
