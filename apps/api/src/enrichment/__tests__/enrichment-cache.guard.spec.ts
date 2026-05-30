import { describe, expect, it, vi } from "vitest";
import { EnrichmentLicenseScope } from "@prisma/client";
import { withEnrichmentCache } from "../enrichment-cache.guard";

function factStub(overrides: Partial<any> = {}) {
  return {
    id: "ef_1",
    orgId: "org_1",
    provider: "tavily",
    lookupKey: "query:test",
    field: "search",
    value: { ok: true },
    fetchedAt: new Date("2026-05-29T00:00:00.000Z"),
    ttlExpiresAt: null,
    confidence: null,
    costCredits: null,
    costUsd: null,
    licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
    graphRunId: null,
    createdAt: new Date("2026-05-29T00:00:00.000Z"),
    updatedAt: new Date("2026-05-29T00:00:00.000Z"),
    ...overrides,
  };
}

describe("withEnrichmentCache", () => {
  it("returns cached fact and short-circuits fetcher", async () => {
    const enrichmentFacts = {
      getCachedFact: vi.fn().mockResolvedValue(factStub()),
      recordFact: vi.fn(),
    };
    const evidenceLedger = {
      enrichmentCacheHit: vi.fn().mockResolvedValue(undefined),
      enrichmentFactRecorded: vi.fn().mockResolvedValue(undefined),
    };
    const fetcher = vi.fn();

    const fact = await withEnrichmentCache(
      {
        enrichmentFacts: enrichmentFacts as any,
        evidenceLedger: evidenceLedger as any,
        orgId: "org_1",
        runId: "run_1",
        provider: "tavily",
        lookupKey: "query:test",
        field: "search",
        ttlMs: 1000,
        costCredits: 1,
        licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
      },
      fetcher,
    );

    expect(fact.value).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(0);
    expect(enrichmentFacts.recordFact).toHaveBeenCalledTimes(0);
    expect(evidenceLedger.enrichmentCacheHit).toHaveBeenCalledTimes(1);
    expect(evidenceLedger.enrichmentFactRecorded).toHaveBeenCalledTimes(1);
  });

  it("on cache miss, calls fetcher then records fact", async () => {
    const enrichmentFacts = {
      getCachedFact: vi.fn().mockResolvedValue(null),
      recordFact: vi.fn(async (args: any) => factStub({ value: args.value })),
    };
    const evidenceLedger = {
      enrichmentCacheHit: vi.fn().mockResolvedValue(undefined),
      enrichmentFactRecorded: vi.fn().mockResolvedValue(undefined),
    };
    const fetcher = vi.fn(async () => ({ ok: "fresh" }));

    const fact = await withEnrichmentCache(
      {
        enrichmentFacts: enrichmentFacts as any,
        evidenceLedger: evidenceLedger as any,
        orgId: "org_1",
        runId: "run_1",
        provider: "tavily",
        lookupKey: "query:test",
        field: "search",
        ttlMs: 1000,
        costCredits: 1,
        licenseScope: EnrichmentLicenseScope.INTERNAL_ONLY,
      },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(enrichmentFacts.recordFact).toHaveBeenCalledTimes(1);
    expect(fact.value).toEqual({ ok: "fresh" });
    expect(evidenceLedger.enrichmentCacheHit).toHaveBeenCalledTimes(0);
    expect(evidenceLedger.enrichmentFactRecorded).toHaveBeenCalledTimes(1);
  });
});

