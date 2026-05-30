import { BadRequestException, Injectable } from "@nestjs/common";
import { EnrichmentLicenseScope, Prisma, type EnrichmentFact } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface RecordFactInput {
  readonly orgId: string;
  readonly provider: string;
  readonly lookupKey: string;
  readonly field: string;
  readonly value: Prisma.InputJsonValue;
  readonly ttlMs?: number;
  readonly confidence?: number;
  readonly costCredits?: number;
  readonly costUsd?: Prisma.Decimal | number | string;
  readonly licenseScope: EnrichmentLicenseScope;
}

export interface GetCachedFactInput {
  readonly orgId: string;
  readonly provider: string;
  readonly lookupKey: string;
  readonly field: string;
}

@Injectable()
export class EnrichmentFactService {
  constructor(private readonly prisma: PrismaService) {}

  async recordFact(input: RecordFactInput): Promise<EnrichmentFact> {
    if (input.licenseScope === EnrichmentLicenseScope.SHAREABLE_AGGREGATE) {
      throw new BadRequestException(
        "licenseScope=SHAREABLE_AGGREGATE is forbidden in this sprint",
      );
    }

    const now = new Date();
    const ttlExpiresAt =
      typeof input.ttlMs === "number" ? new Date(now.getTime() + input.ttlMs) : null;

    return this.prisma.enrichmentFact.upsert({
      where: {
        orgId_provider_lookupKey_field: {
          orgId: input.orgId,
          provider: input.provider,
          lookupKey: input.lookupKey,
          field: input.field,
        },
      },
      create: {
        orgId: input.orgId,
        provider: input.provider,
        lookupKey: input.lookupKey,
        field: input.field,
        value: input.value,
        fetchedAt: now,
        ttlExpiresAt,
        confidence: input.confidence,
        costCredits: input.costCredits,
        costUsd: input.costUsd,
        licenseScope: input.licenseScope,
      },
      update: {
        value: input.value,
        fetchedAt: now,
        ttlExpiresAt,
        confidence: input.confidence,
        costCredits: input.costCredits,
        costUsd: input.costUsd,
        licenseScope: input.licenseScope,
      },
    });
  }

  async getCachedFact(input: GetCachedFactInput): Promise<EnrichmentFact | null> {
    const fact = await this.prisma.enrichmentFact.findUnique({
      where: {
        orgId_provider_lookupKey_field: {
          orgId: input.orgId,
          provider: input.provider,
          lookupKey: input.lookupKey,
          field: input.field,
        },
      },
    });

    if (!fact) return null;
    if (fact.ttlExpiresAt && fact.ttlExpiresAt.getTime() <= Date.now()) return null;
    return fact;
  }

  async getFactsForLead(input: {
    readonly orgId: string;
    readonly leadId?: string;
  }): Promise<EnrichmentFact[]> {
    if (!input.leadId) return [];

    return this.prisma.enrichmentFact.findMany({
      where: {
        orgId: input.orgId,
        lookupKey: `lead:${input.leadId}`,
      },
      orderBy: { fetchedAt: "desc" },
    });
  }

  async getMonthlyEnrichmentCost(input: {
    readonly orgId: string;
  }): Promise<Prisma.Decimal> {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const startOfNextMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    );

    const agg = await this.prisma.enrichmentFact.aggregate({
      where: {
        orgId: input.orgId,
        fetchedAt: { gte: startOfMonth, lt: startOfNextMonth },
      },
      _sum: { costUsd: true },
    });

    return agg._sum.costUsd ?? new Prisma.Decimal(0);
  }
}
