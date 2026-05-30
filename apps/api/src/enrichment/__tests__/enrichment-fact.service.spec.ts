import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { EnrichmentLicenseScope, Prisma } from "@prisma/client";
import { EnrichmentFactService } from "../enrichment-fact.service";

type EnrichmentFactRow = {
  id: string;
  orgId: string;
  provider: string;
  lookupKey: string;
  field: string;
  value: Prisma.InputJsonValue;
  fetchedAt: Date;
  ttlExpiresAt: Date | null;
  confidence: number | null;
  costCredits: number | null;
  costUsd: Prisma.Decimal | null;
  licenseScope: EnrichmentLicenseScope;
  graphRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function keyOf(input: { orgId: string; provider: string; lookupKey: string; field: string }): string {
  return `${input.orgId}|${input.provider}|${input.lookupKey}|${input.field}`;
}

class FakePrismaService {
  private nextId = 1;
  private store = new Map<string, EnrichmentFactRow>();

  readonly enrichmentFact = {
    upsert: vi.fn(async (args: any) => {
      const where = args.where.orgId_provider_lookupKey_field as {
        orgId: string;
        provider: string;
        lookupKey: string;
        field: string;
      };
      const key = keyOf(where);
      const existing = this.store.get(key);
      const now = new Date();

      const base: EnrichmentFactRow =
        existing ??
        ({
          id: `ef_${this.nextId++}`,
          orgId: where.orgId,
          provider: where.provider,
          lookupKey: where.lookupKey,
          field: where.field,
          value: null,
          fetchedAt: now,
          ttlExpiresAt: null,
          confidence: null,
          costCredits: null,
          costUsd: null,
          licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
          graphRunId: null,
          createdAt: now,
          updatedAt: now,
        } as EnrichmentFactRow);

      const data = existing ? args.update : args.create;
      const row: EnrichmentFactRow = {
        ...base,
        ...data,
        ttlExpiresAt: data.ttlExpiresAt ?? null,
        confidence: data.confidence ?? null,
        costCredits: data.costCredits ?? null,
        costUsd: data.costUsd ?? null,
        graphRunId: data.graphRunId ?? null,
        updatedAt: now,
      };

      this.store.set(key, row);
      return row;
    }),
    findUnique: vi.fn(async (args: any) => {
      const where = args.where.orgId_provider_lookupKey_field as {
        orgId: string;
        provider: string;
        lookupKey: string;
        field: string;
      };
      return this.store.get(keyOf(where)) ?? null;
    }),
    findMany: vi.fn(async (args: any) => {
      const orgId = args.where.orgId as string;
      const lookupKey = args.where.lookupKey as string;
      const rows = Array.from(this.store.values()).filter(
        (r) => r.orgId === orgId && r.lookupKey === lookupKey,
      );
      return rows.sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime());
    }),
    aggregate: vi.fn(async (args: any) => {
      const orgId = args.where.orgId as string;
      const gte = args.where.fetchedAt.gte as Date;
      const lt = args.where.fetchedAt.lt as Date;
      let sum = new Prisma.Decimal(0);
      for (const row of this.store.values()) {
        if (row.orgId !== orgId) continue;
        if (row.fetchedAt < gte || row.fetchedAt >= lt) continue;
        if (!row.costUsd) continue;
        sum = sum.plus(row.costUsd);
      }
      return { _sum: { costUsd: sum.equals(0) ? null : sum } };
    }),
  };
}

describe("EnrichmentFactService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
  });

  it("recordFact upserts by (orgId, provider, lookupKey, field)", async () => {
    const prisma = new FakePrismaService();
    const svc = new EnrichmentFactService(prisma as any);

    const first = await svc.recordFact({
      orgId: "org_a",
      provider: "tavily",
      lookupKey: "query:test",
      field: "search",
      value: { ok: 1 },
      ttlMs: 1000,
      licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
    });

    vi.setSystemTime(new Date("2026-05-29T12:00:02.000Z"));

    const second = await svc.recordFact({
      orgId: "org_a",
      provider: "tavily",
      lookupKey: "query:test",
      field: "search",
      value: { ok: 2 },
      ttlMs: 2000,
      licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
    });

    expect(second.id).toBe(first.id);
    expect(second.value).toEqual({ ok: 2 });
    expect(second.fetchedAt.toISOString()).toBe("2026-05-29T12:00:02.000Z");
    expect(second.ttlExpiresAt?.toISOString()).toBe("2026-05-29T12:00:04.000Z");
  });

  it("getCachedFact returns within TTL and null past TTL", async () => {
    const prisma = new FakePrismaService();
    const svc = new EnrichmentFactService(prisma as any);

    await svc.recordFact({
      orgId: "org_a",
      provider: "tavily",
      lookupKey: "query:test",
      field: "search",
      value: { ok: true },
      ttlMs: 1000,
      licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
    });

    const cached = await svc.getCachedFact({
      orgId: "org_a",
      provider: "tavily",
      lookupKey: "query:test",
      field: "search",
    });
    expect(cached).toBeTruthy();

    vi.setSystemTime(new Date("2026-05-29T12:00:02.000Z"));
    const expired = await svc.getCachedFact({
      orgId: "org_a",
      provider: "tavily",
      lookupKey: "query:test",
      field: "search",
    });
    expect(expired).toBeNull();
  });

  it("enforces tenant isolation by orgId", async () => {
    const prisma = new FakePrismaService();
    const svc = new EnrichmentFactService(prisma as any);

    await svc.recordFact({
      orgId: "org_a",
      provider: "tavily",
      lookupKey: "query:test",
      field: "search",
      value: { ok: true },
      ttlMs: 1000,
      licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
    });

    const otherOrg = await svc.getCachedFact({
      orgId: "org_b",
      provider: "tavily",
      lookupKey: "query:test",
      field: "search",
    });

    expect(otherOrg).toBeNull();
  });

  it("rejects licenseScope=SHAREABLE_AGGREGATE in this sprint", async () => {
    const prisma = new FakePrismaService();
    const svc = new EnrichmentFactService(prisma as any);

    await expect(
      svc.recordFact({
        orgId: "org_a",
        provider: "tavily",
        lookupKey: "query:test",
        field: "search",
        value: { ok: true },
        licenseScope: EnrichmentLicenseScope.SHAREABLE_AGGREGATE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

