import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MemoryService {
  constructor(private prisma: PrismaService) {}

  async get(agentId: string, key: string): Promise<unknown | null> {
    const memory = await this.prisma.agentMemory.findUnique({
      where: { agentId_key: { agentId, key } },
    });
    return memory?.value ?? null;
  }

  async set(agentId: string, key: string, value: unknown): Promise<void> {
    await this.prisma.agentMemory.upsert({
      where: { agentId_key: { agentId, key } },
      update: { value: value as any },
      create: { agentId, key, value: value as any },
    });
  }

  async getAll(agentId: string): Promise<Record<string, unknown>> {
    const memories = await this.prisma.agentMemory.findMany({
      where: { agentId },
      orderBy: { updatedAt: "desc" },
    });
    const result: Record<string, unknown> = {};
    for (const m of memories) {
      result[m.key] = m.value;
    }
    return result;
  }

  async delete(agentId: string, key: string): Promise<void> {
    await this.prisma.agentMemory.deleteMany({
      where: { agentId, key },
    });
  }

  async deleteAll(agentId: string): Promise<void> {
    await this.prisma.agentMemory.deleteMany({
      where: { agentId },
    });
  }

  // Convenience: get list of contacted leads
  async getContactedLeads(agentId: string): Promise<string[]> {
    const value = await this.get(agentId, "contacted_leads");
    if (Array.isArray(value)) return value;
    return [];
  }

  // Convenience: add a contacted lead
  async addContactedLead(agentId: string, email: string): Promise<void> {
    const leads = await this.getContactedLeads(agentId);
    if (!leads.includes(email)) {
      leads.push(email);
      await this.set(agentId, "contacted_leads", leads);
    }
  }

  // Convenience: get last run summary
  async getLastRunSummary(agentId: string): Promise<string | null> {
    const value = await this.get(agentId, "last_run_summary");
    return typeof value === "string" ? value : null;
  }

  // Convenience: set last run summary
  async setLastRunSummary(agentId: string, summary: string): Promise<void> {
    await this.set(agentId, "last_run_summary", summary);
  }
}
