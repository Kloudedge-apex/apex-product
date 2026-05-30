import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma, LlmRequestStatus } from "@prisma/client";
import { UsageService } from "../usage.service";

describe("UsageService", () => {
  const ORG_A = "org_a";
  const ORG_B = "org_b";

  const hourBucket = new Date("2026-05-29T10:23:45Z");
  const hourStart = new Date("2026-05-29T10:00:00Z");
  const hourEnd = new Date("2026-05-29T11:00:00Z");

  const llmFacts = [
    {
      orgId: ORG_A,
      createdAt: new Date("2026-05-29T10:00:01Z"),
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
      costUsd: new Prisma.Decimal("0.100000"),
      status: LlmRequestStatus.OK,
      latencyMs: 100,
    },
    {
      orgId: ORG_A,
      createdAt: new Date("2026-05-29T10:59:59Z"),
      inputTokens: 20,
      outputTokens: 15,
      cachedInputTokens: 0,
      costUsd: new Prisma.Decimal("0.200000"),
      status: LlmRequestStatus.ERROR,
      latencyMs: 400,
    },
    {
      orgId: ORG_B,
      createdAt: new Date("2026-05-29T10:30:00Z"),
      inputTokens: 999,
      outputTokens: 999,
      cachedInputTokens: 999,
      costUsd: new Prisma.Decimal("9.999999"),
      status: LlmRequestStatus.OK,
      latencyMs: 999,
    },
  ] as const;

  const enrichmentFacts = [
    {
      orgId: ORG_A,
      fetchedAt: new Date("2026-05-29T10:10:00Z"),
      costUsd: new Prisma.Decimal("0.0500"),
    },
    {
      orgId: ORG_A,
      fetchedAt: new Date("2026-05-29T10:20:00Z"),
      costUsd: null,
    },
    {
      orgId: ORG_B,
      fetchedAt: new Date("2026-05-29T10:15:00Z"),
      costUsd: new Prisma.Decimal("1.0000"),
    },
  ] as const;

  const emailEvents = [
    { orgId: ORG_A, occurredAt: new Date("2026-05-29T10:01:00Z"), kind: "SENT" },
    { orgId: ORG_A, occurredAt: new Date("2026-05-29T10:02:00Z"), kind: "SENT" },
    { orgId: ORG_A, occurredAt: new Date("2026-05-29T10:03:00Z"), kind: "SENT" },
    { orgId: ORG_A, occurredAt: new Date("2026-05-29T10:04:00Z"), kind: "BOUNCED" },
    { orgId: ORG_A, occurredAt: new Date("2026-05-29T10:05:00Z"), kind: "REPLIED" },
    { orgId: ORG_A, occurredAt: new Date("2026-05-29T10:06:00Z"), kind: "REPLIED" },
    { orgId: ORG_A, occurredAt: new Date("2026-05-29T10:07:00Z"), kind: "SUPPRESSED" },
    { orgId: ORG_B, occurredAt: new Date("2026-05-29T10:08:00Z"), kind: "SENT" },
  ] as const;

  let hourlyUpserts: ReturnType<typeof vi.fn>;
  let hourlyFindMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hourlyUpserts = vi.fn().mockResolvedValue({ computedAt: new Date("2026-05-29T12:00:00Z") });
    hourlyFindMany = vi.fn().mockResolvedValue([
      {
        orgId: ORG_A,
        bucketStart: hourStart,
        requests: 2,
        inputTokens: 30n,
        outputTokens: 20n,
        cachedInputTokens: 2n,
        totalCostUsd: new Prisma.Decimal("0.350000"),
        computedAt: new Date("2026-05-29T12:00:00Z"),
      },
    ]);
  });

  it("rollupHour aggregates facts + is idempotent", async () => {
    const prisma = {
      llmRequestFact: {
        aggregate: vi.fn().mockImplementation(async ({ where }: any) => {
          const rows = llmFacts.filter(
            (r) =>
              r.orgId === where.orgId &&
              r.createdAt >= where.createdAt.gte &&
              r.createdAt < where.createdAt.lt,
          );
          const sum = rows.reduce(
            (acc, r) => {
              acc.inputTokens += r.inputTokens;
              acc.outputTokens += r.outputTokens;
              acc.cachedInputTokens += r.cachedInputTokens;
              acc.costUsd = acc.costUsd.plus(r.costUsd);
              return acc;
            },
            {
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              costUsd: new Prisma.Decimal(0),
            },
          );
          return {
            _count: { _all: rows.length },
            _sum: {
              inputTokens: sum.inputTokens,
              outputTokens: sum.outputTokens,
              cachedInputTokens: sum.cachedInputTokens,
              costUsd: sum.costUsd,
            },
          };
        }),
        count: vi.fn().mockImplementation(async ({ where }: any) => {
          const rows = llmFacts.filter(
            (r) =>
              r.orgId === where.orgId &&
              r.createdAt >= where.createdAt.gte &&
              r.createdAt < where.createdAt.lt &&
              r.status !== LlmRequestStatus.OK,
          );
          return rows.length;
        }),
      },
      enrichmentFact: {
        aggregate: vi.fn().mockImplementation(async ({ where }: any) => {
          const rows = enrichmentFacts.filter(
            (r) =>
              r.orgId === where.orgId &&
              r.fetchedAt >= where.fetchedAt.gte &&
              r.fetchedAt < where.fetchedAt.lt,
          );
          const sumCost = rows.reduce(
            (acc, r) => (r.costUsd ? acc.plus(r.costUsd) : acc),
            new Prisma.Decimal(0),
          );
          return { _count: { _all: rows.length }, _sum: { costUsd: sumCost } };
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      emailEvent: {
        groupBy: vi.fn().mockImplementation(async ({ where }: any) => {
          const rows = emailEvents.filter(
            (r) =>
              r.orgId === where.orgId &&
              r.occurredAt >= where.occurredAt.gte &&
              r.occurredAt < where.occurredAt.lt &&
              where.kind.in.includes(r.kind),
          );
          const counts = new Map<string, number>();
          for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
          return Array.from(counts.entries()).map(([kind, count]) => ({
            kind,
            _count: { _all: count },
          }));
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      orgHourlyUsage: {
        upsert: hourlyUpserts,
        findMany: hourlyFindMany,
        aggregate: vi.fn(),
      },
      orgDailyUsage: {
        upsert: vi.fn(),
        findMany: vi.fn(),
        aggregate: vi.fn(),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ p50: 100, p95: 200, p99: 300 }]),
    } as any;

    const evidence = {
      usageRollupCompleted: vi.fn().mockResolvedValue(undefined),
      usageRollupFailed: vi.fn().mockResolvedValue(undefined),
    } as any;

    const svc = new UsageService(prisma, evidence);

    const first = await svc.rollupHour({ orgId: ORG_A, hourBucket });
    const second = await svc.rollupHour({ orgId: ORG_A, hourBucket });

    expect(first).toEqual({
      orgId: ORG_A,
      granularity: "hour",
      bucket: hourStart,
      llmRequests: 2,
      llmTokensIn: 30,
      llmTokensOut: 20,
      llmCachedTokensIn: 2,
      llmCostUsd: 0.3,
      enrichmentCalls: 2,
      enrichmentCostUsd: 0.05,
      emailsSent: 3,
      emailsBounced: 1,
      emailsReplied: 2,
      emailsSuppressed: 1,
      computedAt: expect.any(Date),
    });

    expect(second.llmRequests).toBe(2);
    expect(hourlyUpserts).toHaveBeenCalledTimes(2);

    const firstUpsert = hourlyUpserts.mock.calls[0]?.[0];
    const secondUpsert = hourlyUpserts.mock.calls[1]?.[0];
    expect(firstUpsert?.update).toEqual(secondUpsert?.update);

    expect(evidence.usageRollupCompleted).toHaveBeenCalledTimes(2);
    expect(evidence.usageRollupFailed).not.toHaveBeenCalled();
  });

  it("getOrgUsage is org-scoped (cross-tenant isolation)", async () => {
    const prisma = {
      orgHourlyUsage: { findMany: hourlyFindMany },
      enrichmentFact: { findMany: vi.fn().mockResolvedValue([]) },
      emailEvent: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const svc = new UsageService(prisma, undefined);

    await svc.getOrgUsage({ orgId: ORG_A, granularity: "hour", from: hourStart, to: hourEnd });

    expect(hourlyFindMany).toHaveBeenCalledTimes(1);
    expect(hourlyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orgId: ORG_A }) }),
    );
  });
});

