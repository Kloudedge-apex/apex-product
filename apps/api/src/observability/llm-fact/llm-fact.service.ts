import { Injectable, Logger, Optional } from "@nestjs/common";
import { LlmRequestStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { EvidenceLedgerService } from "../evidence-ledger.service";

@Injectable()
export class LlmFactService {
  private readonly logger = new Logger(LlmFactService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
  ) {}

  /**
   * Best-effort persistence of per-call billing facts. Never throws: failures
   * are logged and swallowed so LLM calls cannot fail because billing logging
   * failed.
   */
  async recordRequest(input: {
    readonly orgId: string;
    readonly campaignId?: string | null;
    readonly leadId?: string | null;
    readonly artifactId?: string | null;
    readonly graphRunId?: string | null;
    readonly nodeName?: string | null;
    readonly promptVersion?: string | null;
    readonly evalBundleVersion?: string | null;
    readonly model: string;
    // Present in newer schema designs; ignored by current Prisma model.
    readonly provider?: string | null;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number | null;
    readonly latencyMs: number;
    readonly costUsd: number;
    readonly langsmithRunId?: string | null;
    readonly status: LlmRequestStatus;
    // Present in newer schema designs; folded into `errorMessage` when set.
    readonly errorKind?: string | null;
    readonly requestedAt: Date;
    readonly completedAt: Date;
  }): Promise<void> {
    if (!input.orgId) return;

    const latencyMs = Number.isFinite(input.latencyMs)
      ? Math.max(0, Math.floor(input.latencyMs))
      : Math.max(0, input.completedAt.getTime() - input.requestedAt.getTime());

    const costUsd =
      Number.isFinite(input.costUsd) && input.costUsd > 0 ? input.costUsd : 0;

    const errorMessage =
      input.status === LlmRequestStatus.OK
        ? null
        : this.formatErrorMessage(input.errorKind ?? undefined);

    try {
      await this.prisma.llmRequestFact.create({
        data: {
          orgId: input.orgId,
          campaignId: input.campaignId ?? null,
          leadId: input.leadId ?? null,
          artifactId: input.artifactId ?? null,
          graphRunId: input.graphRunId ?? null,
          nodeName: input.nodeName ?? null,
          promptVersion: input.promptVersion ?? null,
          evalBundleVersion: input.evalBundleVersion ?? null,
          model: input.model,
          inputTokens: Math.max(0, Math.floor(input.inputTokens)),
          outputTokens: Math.max(0, Math.floor(input.outputTokens)),
          cachedInputTokens: Math.max(0, Math.floor(input.cachedInputTokens ?? 0)),
          latencyMs,
          // Store as string to preserve Decimal precision.
          costUsd: costUsd.toFixed(6),
          langsmithRunId: input.langsmithRunId ?? null,
          status: input.status,
          errorMessage,
          createdAt: input.requestedAt,
        },
      });

      void this.evidenceLedger?.llmRequestRecorded({
        orgId: input.orgId,
        model: input.model,
        costUsd,
        latencyMs,
        status: input.status,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist LlmRequestFact (orgId=${input.orgId} model=${input.model} status=${input.status}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async getMonthlyLlmSpend(input: { readonly orgId: string }): Promise<Prisma.Decimal> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    try {
      const res = await this.prisma.llmRequestFact.aggregate({
        where: { orgId: input.orgId, createdAt: { gte: start, lt: end } },
        _sum: { costUsd: true },
      });
      return res._sum.costUsd ?? new Prisma.Decimal(0);
    } catch (err) {
      this.logger.warn(
        `getMonthlyLlmSpend failed (orgId=${input.orgId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return new Prisma.Decimal(0);
    }
  }

  private formatErrorMessage(errorKind?: string): string {
    const kind = errorKind && errorKind.length > 0 ? errorKind : "unknown";
    // Keep it short; LlmRequestFact.errorMessage is intended for rollup/debug,
    // not full stack traces.
    return kind.slice(0, 120);
  }
}
