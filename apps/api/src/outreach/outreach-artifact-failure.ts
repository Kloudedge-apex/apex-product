import { OutreachArtifactStatus, type Prisma } from "@prisma/client";

/**
 * Reserved marker written by workers released before the first-class FAILED
 * status existed. The compatibility release also emits this marker together
 * with failedAt/failureReason until the first-class write gate is attested.
 * Readers classify only those provenance-bearing compatibility rows.
 */
export const LEGACY_AUTO_FAILED_PREFIX = "auto-failed:";

export interface ArtifactFailureView {
  readonly status: OutreachArtifactStatus;
  readonly reviewerNote?: string | null;
  readonly failureReason?: string | null;
  readonly failedAt?: Date | null;
  readonly updatedAt?: Date;
}

export function hasLegacyAutoFailedMarker(
  artifact: Pick<ArtifactFailureView, "status" | "reviewerNote">,
): boolean {
  return (
    artifact.status === OutreachArtifactStatus.REJECTED &&
    artifact.reviewerNote?.startsWith(LEGACY_AUTO_FAILED_PREFIX) === true
  );
}

export function isLegacyAutoFailedArtifact(
  artifact: Pick<ArtifactFailureView, "status" | "reviewerNote" | "failedAt">,
): boolean {
  return hasLegacyAutoFailedMarker(artifact) && artifact.failedAt != null;
}

export function isFailedArtifact(artifact: ArtifactFailureView): boolean {
  return (
    artifact.status === OutreachArtifactStatus.FAILED ||
    isLegacyAutoFailedArtifact(artifact)
  );
}

export function artifactFailureReason(
  artifact: ArtifactFailureView,
): string | null {
  if (artifact.status === OutreachArtifactStatus.FAILED) {
    return artifact.failureReason?.trim() || null;
  }
  if (!isLegacyAutoFailedArtifact(artifact)) return null;
  return (
    artifact.reviewerNote?.slice(LEGACY_AUTO_FAILED_PREFIX.length).trim() ||
    "Legacy retry exhaustion without a recorded reason"
  );
}

export function artifactFailedAt(artifact: ArtifactFailureView): Date | null {
  if (!isFailedArtifact(artifact)) return null;
  return artifact.failedAt ?? artifact.updatedAt ?? null;
}

export function isReservedFailureNote(
  note: string | null | undefined,
): boolean {
  return note?.trimStart().startsWith(LEGACY_AUTO_FAILED_PREFIX) === true;
}

export function failedArtifactWhere(): Prisma.OutreachArtifactWhereInput {
  return {
    OR: [
      { status: OutreachArtifactStatus.FAILED },
      {
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: { startsWith: LEGACY_AUTO_FAILED_PREFIX },
        failedAt: { not: null },
      },
    ],
  };
}

export function humanRejectedArtifactWhere(): Prisma.OutreachArtifactWhereInput {
  return {
    status: OutreachArtifactStatus.REJECTED,
    OR: [
      { reviewerNote: null },
      {
        NOT: {
          reviewerNote: { startsWith: LEGACY_AUTO_FAILED_PREFIX },
        },
      },
    ],
  };
}

/** Database predicate for the API's effective status during rolling deploy. */
export function effectiveArtifactStatusWhere(
  status: OutreachArtifactStatus,
): Prisma.OutreachArtifactWhereInput {
  if (status === OutreachArtifactStatus.FAILED) return failedArtifactWhere();
  if (status === OutreachArtifactStatus.REJECTED)
    return humanRejectedArtifactWhere();
  return { status };
}

/** Rows whose reviewedAt represents a human decision, including later suppression. */
export function reviewedDecisionArtifactWhere(): Prisma.OutreachArtifactWhereInput {
  return {
    OR: [
      {
        status: {
          notIn: [
            OutreachArtifactStatus.REJECTED,
            OutreachArtifactStatus.SUPPRESSED,
          ],
        },
      },
      humanRejectedArtifactWhere(),
      {
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewedAt: { not: null },
      },
      {
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: { startsWith: LEGACY_AUTO_FAILED_PREFIX },
        failedAt: { not: null },
      },
    ],
  };
}

/** Current statuses proving that an artifact passed human approval. */
export const POST_APPROVAL_ARTIFACT_STATUSES = [
  OutreachArtifactStatus.APPROVED,
  OutreachArtifactStatus.SENDING,
  OutreachArtifactStatus.SENT,
  OutreachArtifactStatus.SIMULATED,
  OutreachArtifactStatus.DELIVERY_UNKNOWN,
  OutreachArtifactStatus.FAILED,
] as const;

/** Status or lifecycle evidence proving that an artifact passed approval. */
export function approvedOutcomeArtifactWhere(): Prisma.OutreachArtifactWhereInput {
  return {
    OR: [
      { status: { in: [...POST_APPROVAL_ARTIFACT_STATUSES] } },
      {
        status: OutreachArtifactStatus.SUPPRESSED,
        reviewedAt: { not: null },
      },
      {
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: { startsWith: LEGACY_AUTO_FAILED_PREFIX },
        failedAt: { not: null },
      },
    ],
  };
}
