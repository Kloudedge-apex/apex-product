import type { EnrichmentFact, Prisma } from "@prisma/client";
import type { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import type { EnrichmentFactService, RecordFactInput } from "./enrichment-fact.service";

export interface WithEnrichmentCacheOptions extends Omit<RecordFactInput, "value"> {
  readonly runId?: string | null;
  readonly evidenceLedger?: EvidenceLedgerService;
  readonly enrichmentFacts: EnrichmentFactService;
}

export async function withEnrichmentCache<TValue extends Prisma.InputJsonValue>(
  opts: WithEnrichmentCacheOptions,
  freshFetcher: () => Promise<TValue>,
): Promise<EnrichmentFact> {
  const cached = await opts.enrichmentFacts.getCachedFact({
    orgId: opts.orgId,
    provider: opts.provider,
    lookupKey: opts.lookupKey,
    field: opts.field,
  });

  if (cached) {
    const ageMs = Date.now() - cached.fetchedAt.getTime();
    await opts.evidenceLedger?.enrichmentCacheHit({
      orgId: opts.orgId,
      runId: opts.runId ?? null,
      provider: opts.provider,
      lookupKey: opts.lookupKey,
      field: opts.field,
      ageMs,
    });
    await opts.evidenceLedger?.enrichmentFactRecorded({
      orgId: opts.orgId,
      runId: opts.runId ?? null,
      provider: opts.provider,
      lookupKey: opts.lookupKey,
      field: opts.field,
      cached: true,
      costUsd: cached.costUsd,
      licenseScope: cached.licenseScope,
    });
    return cached;
  }

  const value = await freshFetcher();
  const fact = await opts.enrichmentFacts.recordFact({
    orgId: opts.orgId,
    provider: opts.provider,
    lookupKey: opts.lookupKey,
    field: opts.field,
    value,
    ttlMs: opts.ttlMs,
    confidence: opts.confidence,
    costCredits: opts.costCredits,
    costUsd: opts.costUsd,
    licenseScope: opts.licenseScope,
  });

  await opts.evidenceLedger?.enrichmentFactRecorded({
    orgId: opts.orgId,
    runId: opts.runId ?? null,
    provider: opts.provider,
    lookupKey: opts.lookupKey,
    field: opts.field,
    cached: false,
    costUsd: fact.costUsd,
    licenseScope: fact.licenseScope,
  });

  return fact;
}

