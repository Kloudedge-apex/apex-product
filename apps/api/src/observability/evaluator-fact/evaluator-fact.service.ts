import { Inject, Injectable, Logger } from "@nestjs/common";
import { EvaluatorTargetType, Prisma, type EvaluatorRun } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { EvidenceLedgerService } from "../evidence-ledger.service";

/**
 * Minimal Prisma surface this service depends on. Lets specs hand-roll a fake
 * client without dragging in the full PrismaService.
 */
export interface EvaluatorFactPrisma {
  readonly evaluatorRun: {
    create(args: Prisma.EvaluatorRunCreateArgs): Promise<EvaluatorRun>;
    findMany(args: Prisma.EvaluatorRunFindManyArgs): Promise<readonly EvaluatorRun[]>;
    groupBy(
      args: Prisma.EvaluatorRunGroupByArgs,
    ): Promise<
      readonly {
        readonly evaluatorName: string;
        readonly passed: boolean;
        readonly _count: { readonly _all: number };
      }[]
    >;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toJsonSafe(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): Prisma.InputJsonValue {
  if (value === null) return "[null]";
  if (value === undefined) return "[undefined]";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((v) => toJsonSafe(v, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);

    if (!isPlainObject(value)) return String(value);
    const out: Record<string, Prisma.InputJsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonSafe(v, seen);
    }
    return out;
  }

  return String(value);
}

function mergeEvidence(
  evidence: Prisma.InputJsonValue | undefined,
  extras: Readonly<Record<string, unknown>>,
): Prisma.InputJsonValue {
  const safeExtras: Record<string, Prisma.InputJsonValue> = {};
  for (const [k, v] of Object.entries(extras)) {
    safeExtras[k] = toJsonSafe(v);
  }

  if (isPlainObject(evidence)) {
    const safeEvidence: Record<string, Prisma.InputJsonValue> = {};
    for (const [k, v] of Object.entries(evidence)) {
      safeEvidence[k] = toJsonSafe(v);
    }
    return { ...safeEvidence, ...safeExtras };
  }
  if (evidence === null || evidence === undefined) return { ...safeExtras };
  // Preserve non-object evidence without losing it.
  return { raw: toJsonSafe(evidence), ...safeExtras };
}

@Injectable()
export class EvaluatorFactService {
  private readonly logger = new Logger(EvaluatorFactService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: EvaluatorFactPrisma,
    private readonly evidenceLedger: EvidenceLedgerService,
  ) {}

  private isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.EVALUATOR_PERSIST_ENABLED !== "false";
  }

  async recordEvaluatorRun(input: {
    readonly orgId: string;
    readonly targetType: EvaluatorTargetType;
    readonly targetId: string;
    readonly evaluatorName: string;
    readonly evaluatorVersion: string;
    readonly score: number;
    readonly passed: boolean;
    readonly reason?: string | null;
    readonly latencyMs: number;
    readonly evidence?: Prisma.InputJsonValue;
    readonly langsmithFeedbackId?: string | null;
  }): Promise<void> {
    if (!this.isEnabled()) return;
    if (!input.orgId || !input.targetId || !input.evaluatorName || !input.evaluatorVersion) return;

    try {
      const evidence = mergeEvidence(input.evidence, {
        langsmith_feedback_id: input.langsmithFeedbackId ?? null,
      });

      await this.prisma.evaluatorRun.create({
        data: {
          orgId: input.orgId,
          targetType: input.targetType,
          targetId: input.targetId,
          evaluatorName: input.evaluatorName,
          evaluatorVersion: input.evaluatorVersion,
          score: input.score,
          passed: input.passed,
          reason: input.reason ?? null,
          latencyMs: input.latencyMs,
          evidence,
        },
      });

      void this.evidenceLedger.evaluatorRunRecorded({
        orgId: input.orgId,
        evaluatorName: input.evaluatorName,
        targetType: input.targetType,
        targetId: input.targetId,
        score: input.score,
        passed: input.passed,
      });
    } catch (err) {
      this.logger.warn(
        `failed to persist EvaluatorRun org=${input.orgId} evaluator=${input.evaluatorName} target=${input.targetType}:${input.targetId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async getRecentRuns(input: {
    readonly orgId: string;
    readonly evaluatorName?: string;
    readonly targetType?: EvaluatorTargetType;
    readonly limit?: number;
  }): Promise<readonly EvaluatorRun[]> {
    const limit = Math.max(1, Math.min(500, input.limit ?? 50));
    return this.prisma.evaluatorRun.findMany({
      where: {
        orgId: input.orgId,
        ...(input.evaluatorName ? { evaluatorName: input.evaluatorName } : {}),
        ...(input.targetType ? { targetType: input.targetType } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async getFailRateByEvaluator(input: {
    readonly orgId: string;
    readonly sinceDays: number;
  }): Promise<
    readonly {
      readonly evaluatorName: string;
      readonly totalRuns: number;
      readonly failedRuns: number;
      /** Fraction in [0,1]. */
      readonly failRate: number;
    }[]
  > {
    const days = Number.isFinite(input.sinceDays) ? Math.max(1, input.sinceDays) : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const grouped = await this.prisma.evaluatorRun.groupBy({
      by: ["evaluatorName", "passed"],
      where: { orgId: input.orgId, createdAt: { gte: since } },
      _count: { _all: true },
    });

    const totals = new Map<string, { total: number; failed: number }>();
    for (const row of grouped) {
      const prev = totals.get(row.evaluatorName) ?? { total: 0, failed: 0 };
      prev.total += row._count._all;
      if (row.passed === false) prev.failed += row._count._all;
      totals.set(row.evaluatorName, prev);
    }

    return [...totals.entries()]
      .map(([evaluatorName, v]) => ({
        evaluatorName,
        totalRuns: v.total,
        failedRuns: v.failed,
        failRate: v.total > 0 ? v.failed / v.total : 0,
      }))
      .sort((a, b) => b.failRate - a.failRate);
  }
}
