import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  OutreachArtifactStatus,
  OutreachChannel,
  OutreachSuppressionReason,
  Prisma,
  VerificationResult,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { acquireOrgSendReservationLock } from "./outreach-send-reservation-lock";

/**
 * Suppression list for outbound (CAN-SPAM / GDPR e-Privacy compliance).
 *
 * Audit P0 #3. Two paths:
 *   • `isSuppressedInTransaction(...)` — the send worker's authoritative,
 *     fail-closed read under the org dispatch-reservation lock.
 *   • `isSuppressed(...)` — fail-closed read for callers outside a reservation.
 *   • `suppress(...)` — idempotently writes under that same org lock. Called
 *     by public unsubscribe, provider bounce/complaint, and operator tooling.
 */
export interface SuppressionRow {
  readonly id: string;
  readonly recipientRef: string;
  readonly reason: OutreachSuppressionReason;
  readonly source: string | null;
  readonly createdAt: Date;
}

export interface ManualSuppressionActor {
  readonly userId: string;
  readonly clerkUserId: string;
}

export interface PersistedManualSuppression {
  readonly id: string;
  readonly recipientRef: string;
  readonly reason: OutreachSuppressionReason;
  readonly source: string | null;
  /** True only when this request inserted the suppression row. */
  readonly created: boolean;
  /** True only when this request upgraded a legacy gmail_reply marker. */
  readonly upgraded: boolean;
}

export interface ArtifactManualSuppressionResult {
  readonly artifact: {
    readonly id: string;
    /** Current persisted state after the guarded status transition. */
    readonly status: OutreachArtifactStatus;
    readonly statusChanged: boolean;
  };
  readonly suppression: PersistedManualSuppression;
}

export type BulkPersonSuppressionSkipReason =
  | "NOT_FOUND_OR_CROSS_ORG"
  | "MISSING_EMAIL"
  | "AMBIGUOUS_EMAIL";

export type BulkPersonSuppressionOutcome =
  | {
      readonly personId: string;
      readonly status: "SUPPRESSED";
      readonly suppression: PersistedManualSuppression;
    }
  | {
      readonly personId: string;
      readonly status: "SKIPPED";
      readonly reason: BulkPersonSuppressionSkipReason;
    };

export interface BulkManualSuppressionResult {
  /** Number of IDs received, including duplicates. */
  readonly requestedCount: number;
  /** Number of distinct IDs processed; duplicate IDs are idempotently folded. */
  readonly uniqueCount: number;
  /** Rows inserted or legacy gmail_reply rows upgraded by this request. */
  readonly affectedCount: number;
  /** People already protected by a real suppression row. */
  readonly alreadySuppressedCount: number;
  readonly skippedCount: number;
  readonly results: BulkPersonSuppressionOutcome[];
}

const ARTIFACT_STATUSES_SAFE_TO_SUPPRESS: readonly OutreachArtifactStatus[] = [
  OutreachArtifactStatus.DRAFT,
  OutreachArtifactStatus.PENDING_REVIEW,
  OutreachArtifactStatus.APPROVED,
];
// REJECTED and FAILED are intentionally absent: manual recipient suppression
// is recorded, but must not erase terminal human-decision or dispatch-failure
// truth on the artifact. This also preserves legacy auto-failed REJECTED rows.

interface PersonEmailCandidate {
  readonly id: string;
  readonly email: string;
  readonly verified: boolean;
  readonly verificationResult: VerificationResult;
}

interface SuppressionHit {
  readonly id: string;
  readonly reason: OutreachSuppressionReason;
  readonly source: string | null;
}

@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Page through suppression rows for an org, newest first. */
  async listForOrg(
    orgId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ rows: SuppressionRow[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.outreachSuppression.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        recipientRef: true,
        reason: true,
        source: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    return {
      rows: slice,
      nextCursor: hasMore ? slice[slice.length - 1].id : null,
    };
  }

  /**
   * Admin unsuppress — removes only a MANUAL row so future sends to this
   * recipient may proceed. Recipient opt-outs, complaints, and provider
   * bounces stay fail-closed until a durable re-consent/reverification
   * workflow exists. The public /u/:token endpoint never deletes. Returns
   * false when the row does not exist OR belongs to a different org (no
   * enumeration leak).
   */
  async unsuppress(orgId: string, suppressionId: string): Promise<boolean> {
    const row = await this.prisma.$transaction(async (tx) => {
      await acquireOrgSendReservationLock(tx, orgId);
      const persisted = await tx.outreachSuppression.findUnique({
        where: { id: suppressionId },
        select: { id: true, orgId: true, recipientRef: true, reason: true },
      });
      if (!persisted || persisted.orgId !== orgId) return null;
      if (persisted.reason !== OutreachSuppressionReason.MANUAL) {
        throw new ConflictException(
          `Suppression ${suppressionId} cannot be removed because ${persisted.reason} requires a durable re-consent or reverification workflow`,
        );
      }
      await tx.outreachSuppression.delete({ where: { id: suppressionId } });
      return persisted;
    });
    if (!row) return false;
    this.logger.log(
      `Unsuppressed org=${orgId} recipient=${row.recipientRef} (id=${suppressionId})`,
    );
    return true;
  }

  /**
   * Suppress the recipient stored on one org-owned email artifact.
   *
   * The recipient and org are never accepted from the client. The artifact
   * status transition is a compare-and-swap over statuses that are both
   * unsent and not in flight. If a worker has already claimed APPROVED as
   * SENDING, or the artifact has reached any delivered/unknown terminal
   * state, the suppression row is still persisted for future outreach but
   * that artifact is left untouched. A final read returns the actual state
   * that survived the race rather than predicting what the update did.
   */
  async suppressArtifactRecipient(input: {
    readonly orgId: string;
    readonly artifactId: string;
    readonly actor: ManualSuppressionActor;
  }): Promise<ArtifactManualSuppressionResult> {
    const artifact = await this.prisma.outreachArtifact.findFirst({
      where: { id: input.artifactId, orgId: input.orgId },
      select: {
        id: true,
        channel: true,
        recipientRef: true,
      },
    });
    if (!artifact) {
      // A foreign-org id is intentionally indistinguishable from a missing id.
      throw new NotFoundException(
        `OutreachArtifact ${input.artifactId} not found`,
      );
    }
    if (artifact.channel !== OutreachChannel.EMAIL) {
      throw new BadRequestException(
        `OutreachArtifact ${input.artifactId} is not an email artifact`,
      );
    }

    const recipientRef = normalizeEmailRef(artifact.recipientRef);
    if (!recipientRef) {
      throw new BadRequestException(
        `OutreachArtifact ${input.artifactId} has no usable persisted recipient`,
      );
    }

    const write = await this.suppress({
      orgId: input.orgId,
      recipientRef,
      reason: OutreachSuppressionReason.MANUAL,
      source: "admin_manual",
      metadata: {
        actorUserId: input.actor.userId,
        actorClerkId: input.actor.clerkUserId,
        action: "artifact_recipient_suppressed",
        artifactId: artifact.id,
      },
    });

    // CAS against only unsent, non-in-flight states. In particular, a SENDING
    // worker claim can never be overwritten by this admin request.
    const statusWrite = await this.prisma.outreachArtifact.updateMany({
      where: {
        id: artifact.id,
        orgId: input.orgId,
        status: { in: [...ARTIFACT_STATUSES_SAFE_TO_SUPPRESS] },
      },
      data: { status: OutreachArtifactStatus.SUPPRESSED },
    });

    const [persistedArtifact, persistedSuppression] = await Promise.all([
      this.prisma.outreachArtifact.findFirst({
        where: { id: artifact.id, orgId: input.orgId },
        select: { id: true, status: true },
      }),
      this.prisma.outreachSuppression.findUnique({
        where: {
          orgId_recipientRef: { orgId: input.orgId, recipientRef },
        },
        select: {
          id: true,
          recipientRef: true,
          reason: true,
          source: true,
        },
      }),
    ]);

    if (!persistedArtifact) {
      throw new NotFoundException(
        `OutreachArtifact ${input.artifactId} not found`,
      );
    }
    if (!persistedSuppression) {
      throw new ServiceUnavailableException(
        "Manual suppression was written but could not be verified",
      );
    }

    return {
      artifact: {
        id: persistedArtifact.id,
        status: persistedArtifact.status,
        statusChanged: statusWrite.count === 1,
      },
      suppression: {
        ...persistedSuppression,
        created: write.created,
        upgraded: write.upgraded === true,
      },
    };
  }

  /**
   * Bulk-suppress selected org-owned people without accepting email or org
   * identity from the client. Person ownership is derived through Company;
   * Person has no direct orgId column in the legacy lead schema.
   *
   * Email resolution is deterministic and fail-closed. A single verified
   * VALID address wins over weaker candidates. Otherwise a tier must contain
   * exactly one distinct address; multiple equally credible addresses are
   * reported as AMBIGUOUS_EMAIL and none are suppressed for that person.
   */
  async suppressPeople(input: {
    readonly orgId: string;
    readonly personIds: readonly string[];
    readonly actor: ManualSuppressionActor;
  }): Promise<BulkManualSuppressionResult> {
    const personIds = [...new Set(input.personIds)];
    const people = await this.prisma.person.findMany({
      where: {
        id: { in: personIds },
        company: { orgId: input.orgId },
      },
      select: {
        id: true,
        emails: {
          select: {
            id: true,
            email: true,
            verified: true,
            verificationResult: true,
          },
          orderBy: { id: "asc" },
        },
      },
    });
    const peopleById = new Map(people.map((person) => [person.id, person]));
    const results: BulkPersonSuppressionOutcome[] = [];
    let affectedCount = 0;
    let alreadySuppressedCount = 0;

    for (const personId of personIds) {
      const person = peopleById.get(personId);
      if (!person) {
        results.push({
          personId,
          status: "SKIPPED",
          reason: "NOT_FOUND_OR_CROSS_ORG",
        });
        continue;
      }

      const resolution = resolvePersonEmail(person.emails);
      if (resolution.recipientRef === null) {
        results.push({
          personId,
          status: "SKIPPED",
          reason: resolution.reason,
        });
        continue;
      }

      const write = await this.suppress({
        orgId: input.orgId,
        recipientRef: resolution.recipientRef,
        reason: OutreachSuppressionReason.MANUAL,
        source: "admin_manual",
        metadata: {
          actorUserId: input.actor.userId,
          actorClerkId: input.actor.clerkUserId,
          action: "person_suppressed",
          personId,
        },
      });
      const persisted = await this.prisma.outreachSuppression.findUnique({
        where: {
          orgId_recipientRef: {
            orgId: input.orgId,
            recipientRef: resolution.recipientRef,
          },
        },
        select: {
          id: true,
          recipientRef: true,
          reason: true,
          source: true,
        },
      });
      if (!persisted) {
        throw new ServiceUnavailableException(
          `Manual suppression for Person ${personId} could not be verified`,
        );
      }

      const suppression: PersistedManualSuppression = {
        ...persisted,
        created: write.created,
        upgraded: write.upgraded === true,
      };
      if (suppression.created || suppression.upgraded) {
        affectedCount += 1;
      } else {
        alreadySuppressedCount += 1;
      }
      results.push({ personId, status: "SUPPRESSED", suppression });
    }

    const skippedCount = results.filter(
      (result) => result.status === "SKIPPED",
    ).length;
    return {
      requestedCount: input.personIds.length,
      uniqueCount: personIds.length,
      affectedCount,
      alreadySuppressedCount,
      skippedCount,
      results,
    };
  }

  async isSuppressed(
    orgId: string,
    recipientRef: string,
    options: { allowLegacyReplyStop?: boolean } = {},
  ): Promise<boolean> {
    if (!recipientRef) return false;
    const key = recipientRef.toLowerCase().trim();
    if (!key) return false;
    return this.isSuppressedFromLookup(orgId, key, options, () =>
      this.prisma.outreachSuppression.findUnique({
        where: { orgId_recipientRef: { orgId, recipientRef: key } },
        select: { id: true, reason: true, source: true },
      }),
    );
  }

  /**
   * Authoritative suppression read for an already-locked send reservation.
   * Query failures still fail closed; in PostgreSQL they may also abort the
   * surrounding transaction, which prevents the SENDING claim entirely.
   */
  async isSuppressedInTransaction(
    tx: Prisma.TransactionClient,
    orgId: string,
    recipientRef: string,
    options: { allowLegacyReplyStop?: boolean } = {},
  ): Promise<boolean> {
    if (!recipientRef) return false;
    const key = recipientRef.toLowerCase().trim();
    if (!key) return false;
    return this.isSuppressedFromLookup(orgId, key, options, () =>
      tx.outreachSuppression.findUnique({
        where: { orgId_recipientRef: { orgId, recipientRef: key } },
        select: { id: true, reason: true, source: true },
      }),
    );
  }

  private async isSuppressedFromLookup(
    orgId: string,
    key: string,
    options: { allowLegacyReplyStop?: boolean },
    lookup: () => Promise<SuppressionHit | null>,
  ): Promise<boolean> {
    try {
      const hit = await lookup();
      if (!hit) return false;
      // Pre-conversation Gmail ingestion wrote a normal prospect reply as a
      // MANUAL legal suppression. New code stores sequenceStoppedAt instead.
      // Preserve those rows as historical sequence-stop evidence, but allow a
      // human-approved REPLY artifact through that exact legacy marker only.
      if (
        options.allowLegacyReplyStop === true &&
        hit.reason === OutreachSuppressionReason.MANUAL &&
        hit.source === "gmail_reply"
      ) {
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(
        `Suppression query failed for org=${orgId} recipient=${key}: ${err instanceof Error ? err.message : "unknown"} — failing closed (treat as suppressed)`,
      );
      // Fail-closed: do NOT permit an outbound when we cannot verify the
      // recipient is unsuppressed. Compliance > deliverability.
      return true;
    }
  }

  async suppress(input: {
    readonly orgId: string;
    readonly recipientRef: string;
    readonly reason: OutreachSuppressionReason;
    readonly source: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ created: boolean; upgraded?: true }> {
    const key = input.recipientRef.toLowerCase().trim();
    if (!key) {
      return { created: false };
    }
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await acquireOrgSendReservationLock(tx, input.orgId);
        const existing = await tx.outreachSuppression.findUnique({
          where: {
            orgId_recipientRef: { orgId: input.orgId, recipientRef: key },
          },
          select: { id: true, reason: true, source: true },
        });
        if (existing) {
          const isLegacyReplyStop =
            existing.reason === OutreachSuppressionReason.MANUAL &&
            existing.source === "gmail_reply";
          const incomingIsLegacyReplyStop =
            input.reason === OutreachSuppressionReason.MANUAL &&
            input.source === "gmail_reply";
          const incomingIsProtected =
            input.reason !== OutreachSuppressionReason.MANUAL;
          const existingIsRemovableManual =
            existing.reason === OutreachSuppressionReason.MANUAL;
          if (
            (isLegacyReplyStop && !incomingIsLegacyReplyStop) ||
            (existingIsRemovableManual && incomingIsProtected)
          ) {
            // Protected recipient actions must replace every removable MANUAL
            // marker, including admin_manual. Otherwise a later admin delete
            // could erase an unsubscribe/bounce/complaint merely because the
            // recipient happened to be manually suppressed first. A non-legacy
            // MANUAL action still replaces the historical gmail_reply marker.
            await tx.outreachSuppression.update({
              where: { id: existing.id },
              data: {
                reason: input.reason,
                source: input.source,
                metadata: input.metadata as never,
              },
            });
            return { created: false, upgraded: true as const };
          }
          // Once a row carries a protected reason, keep its first legal source
          // canonical on subsequent duplicate events. Removable MANUAL rows
          // are promoted above whenever stronger recipient/provider evidence
          // arrives.
          return { created: false };
        }
        await tx.outreachSuppression.create({
          data: {
            orgId: input.orgId,
            recipientRef: key,
            reason: input.reason,
            source: input.source,
            metadata: input.metadata as never,
          },
        });
        return { created: true };
      });
      if (result.created) {
        this.logger.log(
          `Suppressed org=${input.orgId} recipient=${key} reason=${input.reason} source=${input.source}`,
        );
      }
      return result;
    } catch (err) {
      this.logger.error(
        `Failed to upsert suppression for org=${input.orgId} recipient=${key}: ${err instanceof Error ? err.message : "unknown"}`,
      );
      throw err;
    }
  }
}

function normalizeEmailRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    /\s/.test(normalized)
  ) {
    return null;
  }
  const at = normalized.indexOf("@");
  if (
    at <= 0 ||
    at !== normalized.lastIndexOf("@") ||
    at === normalized.length - 1
  ) {
    return null;
  }
  return normalized;
}

function resolvePersonEmail(candidates: readonly PersonEmailCandidate[]):
  | { readonly recipientRef: string; readonly reason?: never }
  | {
      readonly recipientRef: null;
      readonly reason: "MISSING_EMAIL" | "AMBIGUOUS_EMAIL";
    } {
  const byAddress = new Map<string, PersonEmailCandidate>();
  for (const candidate of candidates) {
    if (candidate.verificationResult === VerificationResult.INVALID) continue;
    const normalized = normalizeEmailRef(candidate.email);
    if (!normalized) continue;
    const previous = byAddress.get(normalized);
    if (!previous || candidateIsStronger(candidate, previous)) {
      byAddress.set(normalized, candidate);
    }
  }

  const usable = [...byAddress.entries()].map(([recipientRef, candidate]) => ({
    recipientRef,
    candidate,
  }));
  if (usable.length === 0) {
    return { recipientRef: null, reason: "MISSING_EMAIL" };
  }

  const tiers = [
    usable.filter(
      ({ candidate }) =>
        candidate.verified &&
        candidate.verificationResult === VerificationResult.VALID,
    ),
    usable.filter(({ candidate }) => candidate.verified),
    usable.filter(
      ({ candidate }) =>
        candidate.verificationResult === VerificationResult.VALID,
    ),
    usable,
  ];
  for (const tier of tiers) {
    if (tier.length === 1) {
      return { recipientRef: tier[0].recipientRef };
    }
    if (tier.length > 1) {
      return { recipientRef: null, reason: "AMBIGUOUS_EMAIL" };
    }
  }

  return { recipientRef: null, reason: "MISSING_EMAIL" };
}

function candidateIsStronger(
  candidate: PersonEmailCandidate,
  previous: PersonEmailCandidate,
): boolean {
  const rank = (value: PersonEmailCandidate): number => {
    if (
      value.verified &&
      value.verificationResult === VerificationResult.VALID
    ) {
      return 3;
    }
    if (value.verified) return 2;
    if (value.verificationResult === VerificationResult.VALID) return 1;
    return 0;
  };
  const candidateRank = rank(candidate);
  const previousRank = rank(previous);
  return (
    candidateRank > previousRank ||
    (candidateRank === previousRank && candidate.id < previous.id)
  );
}
