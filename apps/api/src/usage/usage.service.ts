import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { EmailEventKind, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";

export type UsageGranularity = "hour" | "day";

export interface RollupHourInput {
  readonly orgId: string;
  readonly hourBucket: Date;
}

export interface RollupDayInput {
  readonly orgId: string;
  readonly dayBucket: Date;
}

export interface OrgUsageRow {
  readonly orgId: string;
  readonly granularity: UsageGranularity;
  readonly bucket: Date;
  readonly llmRequests: number;
  readonly llmTokensIn: number;
  readonly llmTokensOut: number;
  readonly llmCachedTokensIn: number;
  readonly llmCostUsd: number;
  readonly enrichmentCalls: number;
  readonly enrichmentCostUsd: number;
  readonly emailsSent: number;
  readonly emailsBounced: number;
  readonly emailsReplied: number;
  readonly emailsSuppressed: number;
  readonly computedAt?: Date;
}

export interface OrgUsageSummary {
  readonly orgId: string;
  readonly days: number;
  readonly totalCostUsd: number;
  readonly llmRequests: number;
  readonly llmTokensIn: number;
  readonly llmTokensOut: number;
  readonly llmCachedTokensIn: number;
  readonly enrichmentCalls: number;
  readonly enrichmentCostUsd: number;
  readonly emailsSent: number;
  readonly emailsBounced: number;
  readonly emailsReplied: number;
  readonly emailsSuppressed: number;
}

function startOfUtcHour(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      0,
      0,
      0,
    ),
  );
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 60 * 60 * 1000);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function toNumberSafe(v: bigint | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toCostNumber(v: Prisma.Decimal | string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const str = typeof v === "string" ? v : v.toString();
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
  ) {}

  async rollupHour(input: RollupHourInput): Promise<OrgUsageRow> {
    const orgId = input.orgId;
    const bucket = startOfUtcHour(input.hourBucket);
    const end = addHours(bucket, 1);

    if (!orgId) throw new BadRequestException("orgId required");

    try {
      const [llmAgg, llmErrorCount, llmPercentiles, enrichAgg, emailAgg] =
        await Promise.all([
          this.prisma.llmRequestFact.aggregate({
            where: { orgId, createdAt: { gte: bucket, lt: end } },
            _count: { _all: true },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cachedInputTokens: true,
              costUsd: true,
            },
          }),
          this.prisma.llmRequestFact.count({
            where: { orgId, createdAt: { gte: bucket, lt: end }, status: { not: "OK" } },
          }),
          this.getLatencyPercentilesMs({ orgId, from: bucket, to: end }),
          this.prisma.enrichmentFact.aggregate({
            where: { orgId, fetchedAt: { gte: bucket, lt: end } },
            _count: { _all: true },
            _sum: { costUsd: true },
          }),
          this.prisma.emailEvent.groupBy({
            by: ["kind"],
            where: {
              orgId,
              occurredAt: { gte: bucket, lt: end },
              kind: { in: ["SENT", "BOUNCED", "REPLIED", "SUPPRESSED"] },
            },
            _count: { _all: true },
          }),
        ]);

      const llmRequests = llmAgg._count._all ?? 0;
      const llmTokensIn = Math.max(0, Math.floor(llmAgg._sum.inputTokens ?? 0));
      const llmTokensOut = Math.max(0, Math.floor(llmAgg._sum.outputTokens ?? 0));
      const llmCachedTokensIn = Math.max(0, Math.floor(llmAgg._sum.cachedInputTokens ?? 0));
      const llmCostUsd = llmAgg._sum.costUsd ?? new Prisma.Decimal(0);

      const enrichmentCalls = enrichAgg._count._all ?? 0;
      const enrichmentCostUsd = enrichAgg._sum.costUsd ?? new Prisma.Decimal(0);

      const emailsSent = emailAgg.find((r) => r.kind === "SENT")?._count._all ?? 0;
      const emailsBounced = emailAgg.find((r) => r.kind === "BOUNCED")?._count._all ?? 0;
      const emailsReplied = emailAgg.find((r) => r.kind === "REPLIED")?._count._all ?? 0;
      const emailsSuppressed = emailAgg.find((r) => r.kind === "SUPPRESSED")?._count._all ?? 0;

      // Store combined total cost in rollup table (LLM + enrichment).
      const totalCostUsd = new Prisma.Decimal(llmCostUsd).plus(enrichmentCostUsd);

      await this.prisma.orgHourlyUsage.upsert({
        where: { orgId_bucketStart: { orgId, bucketStart: bucket } },
        create: {
          orgId,
          bucketStart: bucket,
          requests: llmRequests,
          inputTokens: BigInt(llmTokensIn),
          outputTokens: BigInt(llmTokensOut),
          cachedInputTokens: BigInt(llmCachedTokensIn),
          totalCostUsd: totalCostUsd.toFixed(6),
          errorCount: llmErrorCount,
          p50LatencyMs: llmPercentiles.p50,
          p95LatencyMs: llmPercentiles.p95,
          p99LatencyMs: llmPercentiles.p99,
          computedAt: bucket,
        },
        update: {
          requests: llmRequests,
          inputTokens: BigInt(llmTokensIn),
          outputTokens: BigInt(llmTokensOut),
          cachedInputTokens: BigInt(llmCachedTokensIn),
          totalCostUsd: totalCostUsd.toFixed(6),
          errorCount: llmErrorCount,
          p50LatencyMs: llmPercentiles.p50,
          p95LatencyMs: llmPercentiles.p95,
          p99LatencyMs: llmPercentiles.p99,
          computedAt: bucket,
        },
        select: { computedAt: true },
      });

      const row: OrgUsageRow = {
        orgId,
        granularity: "hour",
        bucket,
        llmRequests,
        llmTokensIn,
        llmTokensOut,
        llmCachedTokensIn,
        llmCostUsd: toCostNumber(llmCostUsd),
        enrichmentCalls,
        enrichmentCostUsd: toCostNumber(enrichmentCostUsd),
        emailsSent,
        emailsBounced,
        emailsReplied,
        emailsSuppressed,
        computedAt: bucket,
      };

      void this.evidenceLedger?.usageRollupCompleted({
        orgId,
        granularity: "hour",
        bucket,
        totals: {
          totalCostUsd: toCostNumber(totalCostUsd),
          llmRequests: row.llmRequests,
          llmTokensIn: row.llmTokensIn,
          llmTokensOut: row.llmTokensOut,
          llmCachedTokensIn: row.llmCachedTokensIn,
          enrichmentCalls: row.enrichmentCalls,
          enrichmentCostUsd: row.enrichmentCostUsd,
          emailsSent: row.emailsSent,
          emailsBounced: row.emailsBounced,
          emailsReplied: row.emailsReplied,
          emailsSuppressed: row.emailsSuppressed,
        },
      });

      return row;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.evidenceLedger?.usageRollupFailed({
        orgId,
        granularity: "hour",
        bucket,
        error: message,
      });
      throw err;
    }
  }

  async rollupDay(input: RollupDayInput): Promise<OrgUsageRow> {
    const orgId = input.orgId;
    const bucket = startOfUtcDay(input.dayBucket);
    const end = addDays(bucket, 1);

    if (!orgId) throw new BadRequestException("orgId required");

    try {
      const [hourlyAgg, llmPercentiles, enrichAgg, emailAgg] = await Promise.all([
        this.prisma.orgHourlyUsage.aggregate({
          where: { orgId, bucketStart: { gte: bucket, lt: end } },
          _sum: {
            requests: true,
            inputTokens: true,
            outputTokens: true,
            cachedInputTokens: true,
            totalCostUsd: true,
            errorCount: true,
          },
        }),
        this.getLatencyPercentilesMs({ orgId, from: bucket, to: end }),
        this.prisma.enrichmentFact.aggregate({
          where: { orgId, fetchedAt: { gte: bucket, lt: end } },
          _count: { _all: true },
          _sum: { costUsd: true },
        }),
        this.prisma.emailEvent.groupBy({
          by: ["kind"],
          where: {
            orgId,
            occurredAt: { gte: bucket, lt: end },
            kind: { in: ["SENT", "BOUNCED", "REPLIED", "SUPPRESSED"] },
          },
          _count: { _all: true },
        }),
      ]);

      const requests = hourlyAgg._sum.requests ?? 0;
      const inputTokens = toNumberSafe(hourlyAgg._sum.inputTokens ?? 0n);
      const outputTokens = toNumberSafe(hourlyAgg._sum.outputTokens ?? 0n);
      const cachedInputTokens = toNumberSafe(hourlyAgg._sum.cachedInputTokens ?? 0n);
      const totalCostUsd = hourlyAgg._sum.totalCostUsd ?? new Prisma.Decimal(0);
      const errorCount = hourlyAgg._sum.errorCount ?? 0;

      await this.prisma.orgDailyUsage.upsert({
        where: { orgId_bucketStart: { orgId, bucketStart: bucket } },
        create: {
          orgId,
          bucketStart: bucket,
          requests,
          inputTokens: BigInt(inputTokens),
          outputTokens: BigInt(outputTokens),
          cachedInputTokens: BigInt(cachedInputTokens),
          totalCostUsd: new Prisma.Decimal(totalCostUsd).toFixed(6),
          errorCount,
          p50LatencyMs: llmPercentiles.p50,
          p95LatencyMs: llmPercentiles.p95,
          p99LatencyMs: llmPercentiles.p99,
          computedAt: bucket,
        },
        update: {
          requests,
          inputTokens: BigInt(inputTokens),
          outputTokens: BigInt(outputTokens),
          cachedInputTokens: BigInt(cachedInputTokens),
          totalCostUsd: new Prisma.Decimal(totalCostUsd).toFixed(6),
          errorCount,
          p50LatencyMs: llmPercentiles.p50,
          p95LatencyMs: llmPercentiles.p95,
          p99LatencyMs: llmPercentiles.p99,
          computedAt: bucket,
        },
        select: { computedAt: true },
      });

      const enrichmentCalls = enrichAgg._count._all ?? 0;
      const enrichmentCostUsd = enrichAgg._sum.costUsd ?? new Prisma.Decimal(0);

      const emailsSent = emailAgg.find((r) => r.kind === "SENT")?._count._all ?? 0;
      const emailsBounced = emailAgg.find((r) => r.kind === "BOUNCED")?._count._all ?? 0;
      const emailsReplied = emailAgg.find((r) => r.kind === "REPLIED")?._count._all ?? 0;
      const emailsSuppressed = emailAgg.find((r) => r.kind === "SUPPRESSED")?._count._all ?? 0;

      // totalCostUsd already includes enrichment, so split LLM cost at read-time.
      const llmCostUsd = Math.max(0, toCostNumber(totalCostUsd) - toCostNumber(enrichmentCostUsd));

      const row: OrgUsageRow = {
        orgId,
        granularity: "day",
        bucket,
        llmRequests: requests,
        llmTokensIn: inputTokens,
        llmTokensOut: outputTokens,
        llmCachedTokensIn: cachedInputTokens,
        llmCostUsd,
        enrichmentCalls,
        enrichmentCostUsd: toCostNumber(enrichmentCostUsd),
        emailsSent,
        emailsBounced,
        emailsReplied,
        emailsSuppressed,
        computedAt: bucket,
      };

      void this.evidenceLedger?.usageRollupCompleted({
        orgId,
        granularity: "day",
        bucket,
        totals: {
          totalCostUsd: toCostNumber(totalCostUsd),
          llmRequests: row.llmRequests,
          llmTokensIn: row.llmTokensIn,
          llmTokensOut: row.llmTokensOut,
          llmCachedTokensIn: row.llmCachedTokensIn,
          enrichmentCalls: row.enrichmentCalls,
          enrichmentCostUsd: row.enrichmentCostUsd,
          emailsSent: row.emailsSent,
          emailsBounced: row.emailsBounced,
          emailsReplied: row.emailsReplied,
          emailsSuppressed: row.emailsSuppressed,
        },
      });

      return row;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.evidenceLedger?.usageRollupFailed({
        orgId,
        granularity: "day",
        bucket,
        error: message,
      });
      throw err;
    }
  }

  async getOrgUsage(input: {
    readonly orgId: string;
    readonly granularity: UsageGranularity;
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly OrgUsageRow[]> {
    const orgId = input.orgId;
    if (!orgId) throw new BadRequestException("orgId required");
    if (!(input.from instanceof Date) || Number.isNaN(input.from.getTime())) {
      throw new BadRequestException("from must be a valid date");
    }
    if (!(input.to instanceof Date) || Number.isNaN(input.to.getTime())) {
      throw new BadRequestException("to must be a valid date");
    }
    if (input.to <= input.from) throw new BadRequestException("to must be after from");

    if (input.granularity === "hour") {
      return this.getOrgHourlyUsageRows({ orgId, from: input.from, to: input.to });
    }
    return this.getOrgDailyUsageRows({ orgId, from: input.from, to: input.to });
  }

  async getOrgUsageSummary(input: {
    readonly orgId: string;
    readonly days: number;
  }): Promise<OrgUsageSummary> {
    const orgId = input.orgId;
    if (!orgId) throw new BadRequestException("orgId required");
    const days = Number.isFinite(input.days) ? Math.floor(input.days) : 0;
    if (days <= 0 || days > 365) throw new BadRequestException("days must be between 1 and 365");

    const today = startOfUtcDay(new Date());
    const from = addDays(today, -days);
    const to = addDays(today, 1);

    const [dailyAgg, enrichAgg, emailAgg] = await Promise.all([
      this.prisma.orgDailyUsage.aggregate({
        where: { orgId, bucketStart: { gte: from, lt: to } },
        _sum: {
          requests: true,
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
          totalCostUsd: true,
        },
      }),
      this.prisma.enrichmentFact.aggregate({
        where: { orgId, fetchedAt: { gte: from, lt: to } },
        _count: { _all: true },
        _sum: { costUsd: true },
      }),
      this.prisma.emailEvent.groupBy({
        by: ["kind"],
        where: {
          orgId,
          occurredAt: { gte: from, lt: to },
          kind: { in: ["SENT", "BOUNCED", "REPLIED", "SUPPRESSED"] },
        },
        _count: { _all: true },
      }),
    ]);

    const enrichmentCalls = enrichAgg._count._all ?? 0;
    const enrichmentCostUsd = enrichAgg._sum.costUsd ?? new Prisma.Decimal(0);
    const emailsSent = emailAgg.find((r) => r.kind === "SENT")?._count._all ?? 0;
    const emailsBounced = emailAgg.find((r) => r.kind === "BOUNCED")?._count._all ?? 0;
    const emailsReplied = emailAgg.find((r) => r.kind === "REPLIED")?._count._all ?? 0;
    const emailsSuppressed = emailAgg.find((r) => r.kind === "SUPPRESSED")?._count._all ?? 0;

    const totalCostUsd = dailyAgg._sum.totalCostUsd ?? new Prisma.Decimal(0);
    const llmRequests = dailyAgg._sum.requests ?? 0;
    const llmTokensIn = toNumberSafe(dailyAgg._sum.inputTokens ?? 0n);
    const llmTokensOut = toNumberSafe(dailyAgg._sum.outputTokens ?? 0n);
    const llmCachedTokensIn = toNumberSafe(dailyAgg._sum.cachedInputTokens ?? 0n);

    return {
      orgId,
      days,
      totalCostUsd: toCostNumber(totalCostUsd),
      llmRequests,
      llmTokensIn,
      llmTokensOut,
      llmCachedTokensIn,
      enrichmentCalls,
      enrichmentCostUsd: toCostNumber(enrichmentCostUsd),
      emailsSent,
      emailsBounced,
      emailsReplied,
      emailsSuppressed,
    };
  }

  private async getOrgHourlyUsageRows(input: {
    readonly orgId: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly OrgUsageRow[]> {
    const from = startOfUtcHour(input.from);
    const to = startOfUtcHour(input.to);

    const [hourlyRows, enrichFacts, emailEvents] = await Promise.all([
      this.prisma.orgHourlyUsage.findMany({
        where: { orgId: input.orgId, bucketStart: { gte: from, lt: to } },
        orderBy: { bucketStart: "asc" },
      }),
      this.prisma.enrichmentFact.findMany({
        where: { orgId: input.orgId, fetchedAt: { gte: from, lt: to } },
        select: { fetchedAt: true, costUsd: true },
      }),
      this.prisma.emailEvent.findMany({
        where: {
          orgId: input.orgId,
          occurredAt: { gte: from, lt: to },
          kind: { in: ["SENT", "BOUNCED", "REPLIED", "SUPPRESSED"] },
        },
        select: { occurredAt: true, kind: true },
      }),
    ]);

    const enrichByHour = new Map<string, { calls: number; cost: Prisma.Decimal }>();
    for (const fact of enrichFacts) {
      const b = startOfUtcHour(fact.fetchedAt).toISOString();
      const current = enrichByHour.get(b) ?? { calls: 0, cost: new Prisma.Decimal(0) };
      current.calls += 1;
      if (fact.costUsd) current.cost = current.cost.plus(fact.costUsd);
      enrichByHour.set(b, current);
    }

    const emailByHour = new Map<string, Record<EmailEventKind, number>>();
    for (const evt of emailEvents) {
      const b = startOfUtcHour(evt.occurredAt).toISOString();
      const current =
        emailByHour.get(b) ??
        ({
          SENT: 0,
          DELIVERED: 0,
          BOUNCED: 0,
          DEFERRED: 0,
          OPENED: 0,
          CLICKED: 0,
          REPLIED: 0,
          COMPLAINED: 0,
          UNSUBSCRIBED: 0,
          SUPPRESSED: 0,
        } as Record<EmailEventKind, number>);
      current[evt.kind] = (current[evt.kind] ?? 0) + 1;
      emailByHour.set(b, current);
    }

    return hourlyRows.map((r) => {
      const key = r.bucketStart.toISOString();
      const enrich = enrichByHour.get(key) ?? { calls: 0, cost: new Prisma.Decimal(0) };
      const emails = emailByHour.get(key) ?? ({} as Record<EmailEventKind, number>);
      const totalCost = r.totalCostUsd ?? new Prisma.Decimal(0);
      const llmCostUsd = Math.max(0, toCostNumber(totalCost) - toCostNumber(enrich.cost));
      return {
        orgId: r.orgId,
        granularity: "hour",
        bucket: r.bucketStart,
        llmRequests: r.requests,
        llmTokensIn: toNumberSafe(r.inputTokens),
        llmTokensOut: toNumberSafe(r.outputTokens),
        llmCachedTokensIn: toNumberSafe(r.cachedInputTokens),
        llmCostUsd,
        enrichmentCalls: enrich.calls,
        enrichmentCostUsd: toCostNumber(enrich.cost),
        emailsSent: emails.SENT ?? 0,
        emailsBounced: emails.BOUNCED ?? 0,
        emailsReplied: emails.REPLIED ?? 0,
        emailsSuppressed: emails.SUPPRESSED ?? 0,
        computedAt: r.computedAt,
      };
    });
  }

  private async getOrgDailyUsageRows(input: {
    readonly orgId: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<readonly OrgUsageRow[]> {
    const from = startOfUtcDay(input.from);
    const to = startOfUtcDay(input.to);

    const [dailyRows, enrichFacts, emailEvents] = await Promise.all([
      this.prisma.orgDailyUsage.findMany({
        where: { orgId: input.orgId, bucketStart: { gte: from, lt: to } },
        orderBy: { bucketStart: "asc" },
      }),
      this.prisma.enrichmentFact.findMany({
        where: { orgId: input.orgId, fetchedAt: { gte: from, lt: to } },
        select: { fetchedAt: true, costUsd: true },
      }),
      this.prisma.emailEvent.findMany({
        where: {
          orgId: input.orgId,
          occurredAt: { gte: from, lt: to },
          kind: { in: ["SENT", "BOUNCED", "REPLIED", "SUPPRESSED"] },
        },
        select: { occurredAt: true, kind: true },
      }),
    ]);

    const enrichByDay = new Map<string, { calls: number; cost: Prisma.Decimal }>();
    for (const fact of enrichFacts) {
      const b = startOfUtcDay(fact.fetchedAt).toISOString();
      const current = enrichByDay.get(b) ?? { calls: 0, cost: new Prisma.Decimal(0) };
      current.calls += 1;
      if (fact.costUsd) current.cost = current.cost.plus(fact.costUsd);
      enrichByDay.set(b, current);
    }

    const emailByDay = new Map<string, Record<EmailEventKind, number>>();
    for (const evt of emailEvents) {
      const b = startOfUtcDay(evt.occurredAt).toISOString();
      const current =
        emailByDay.get(b) ??
        ({
          SENT: 0,
          DELIVERED: 0,
          BOUNCED: 0,
          DEFERRED: 0,
          OPENED: 0,
          CLICKED: 0,
          REPLIED: 0,
          COMPLAINED: 0,
          UNSUBSCRIBED: 0,
          SUPPRESSED: 0,
        } as Record<EmailEventKind, number>);
      current[evt.kind] = (current[evt.kind] ?? 0) + 1;
      emailByDay.set(b, current);
    }

    return dailyRows.map((r) => {
      const key = r.bucketStart.toISOString();
      const enrich = enrichByDay.get(key) ?? { calls: 0, cost: new Prisma.Decimal(0) };
      const emails = emailByDay.get(key) ?? ({} as Record<EmailEventKind, number>);
      const totalCost = r.totalCostUsd ?? new Prisma.Decimal(0);
      const llmCostUsd = Math.max(0, toCostNumber(totalCost) - toCostNumber(enrich.cost));
      return {
        orgId: r.orgId,
        granularity: "day",
        bucket: r.bucketStart,
        llmRequests: r.requests,
        llmTokensIn: toNumberSafe(r.inputTokens),
        llmTokensOut: toNumberSafe(r.outputTokens),
        llmCachedTokensIn: toNumberSafe(r.cachedInputTokens),
        llmCostUsd,
        enrichmentCalls: enrich.calls,
        enrichmentCostUsd: toCostNumber(enrich.cost),
        emailsSent: emails.SENT ?? 0,
        emailsBounced: emails.BOUNCED ?? 0,
        emailsReplied: emails.REPLIED ?? 0,
        emailsSuppressed: emails.SUPPRESSED ?? 0,
        computedAt: r.computedAt,
      };
    });
  }

  private async getLatencyPercentilesMs(input: {
    readonly orgId: string;
    readonly from: Date;
    readonly to: Date;
  }): Promise<{ p50: number; p95: number; p99: number }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ p50: unknown; p95: unknown; p99: unknown }>
    >(Prisma.sql`
      SELECT
        COALESCE((percentile_cont(0.50) WITHIN GROUP (ORDER BY "latencyMs"))::int, 0) AS p50,
        COALESCE((percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs"))::int, 0) AS p95,
        COALESCE((percentile_cont(0.99) WITHIN GROUP (ORDER BY "latencyMs"))::int, 0) AS p99
      FROM "LlmRequestFact"
      WHERE "orgId" = ${input.orgId}
        AND "createdAt" >= ${input.from}
        AND "createdAt" < ${input.to}
    `);
    const row = rows[0];
    const p50 = row ? Number(row.p50) : 0;
    const p95 = row ? Number(row.p95) : 0;
    const p99 = row ? Number(row.p99) : 0;
    return {
      p50: Number.isFinite(p50) ? Math.max(0, Math.floor(p50)) : 0,
      p95: Number.isFinite(p95) ? Math.max(0, Math.floor(p95)) : 0,
      p99: Number.isFinite(p99) ? Math.max(0, Math.floor(p99)) : 0,
    };
  }
}
