import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LLMService } from "./llm.service";

export interface SemanticMemoryHit {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  distance: number;
  createdAt: Date;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private prisma: PrismaService,
    private llm: LLMService,
  ) {}

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

  /**
   * Persist a chunk of free-form text along with its embedding so future
   * runs can retrieve it by semantic similarity. Silently no-ops when no
   * embedding provider is configured (dev/test); production callers will
   * have failed loud earlier when LLMService was constructed.
   */
  async addSemantic(
    agentId: string,
    content: string,
    metadata: Record<string, unknown> | null = null,
  ): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;

    const embedding = await this.llm.embed(trimmed);
    if (!embedding) return;

    const vectorLiteral = `[${embedding.join(",")}]`;
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "AgentMemoryEmbedding" ("id", "agentId", "content", "embedding", "metadata", "createdAt")
        VALUES (
          ${`mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`},
          ${agentId},
          ${trimmed},
          ${vectorLiteral}::vector,
          ${metadata as any}::jsonb,
          NOW()
        )
      `;
    } catch (err) {
      this.logger.warn(
        `Failed to persist semantic memory for ${agentId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Retrieve the top-K semantically similar memories for a given query text.
   * Returns an empty array when no embedding provider is configured or when
   * the agent has no semantic memory entries.
   */
  async searchSemantic(
    agentId: string,
    query: string,
    topK: number = 5,
  ): Promise<SemanticMemoryHit[]> {
    const embedding = await this.llm.embed(query);
    if (!embedding) return [];

    const vectorLiteral = `[${embedding.join(",")}]`;
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{
          id: string;
          content: string;
          metadata: Record<string, unknown> | null;
          distance: number;
          createdAt: Date;
        }>
      >`
        SELECT "id", "content", "metadata", "createdAt",
               ("embedding" <=> ${vectorLiteral}::vector) AS "distance"
        FROM "AgentMemoryEmbedding"
        WHERE "agentId" = ${agentId}
        ORDER BY "embedding" <=> ${vectorLiteral}::vector
        LIMIT ${topK}
      `;
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        metadata: r.metadata,
        distance: Number(r.distance),
        createdAt: r.createdAt,
      }));
    } catch (err) {
      this.logger.warn(
        `Semantic search failed for ${agentId}: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
