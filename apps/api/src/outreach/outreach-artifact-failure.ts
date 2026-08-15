import { OutreachArtifactStatus, type Prisma } from "@prisma/client";

/**
 * Reserved marker written by workers released before the first-class FAILED
 * status existed. The compatibility release also emits this marker together
 * with failedAt/failureReason until the first-class write gate is attested.
 * Readers classify only those provenance-bearing compatibility rows.
 */
export const LEGACY_AUTO_FAILED_PREFIX = "auto-failed:";

/**
 * Compatibility representation for an ambiguous provider outcome while old
 * readers or rollback images may not understand the DELIVERY_UNKNOWN enum.
 * REJECTED is intentionally used only as the physical storage state: current
 * readers expose these provenance-bearing rows as DELIVERY_UNKNOWN and never
 * as a human rejection.
 */
export const LEGACY_DELIVERY_UNKNOWN_PREFIX = "delivery-unknown:";

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

export function isLegacyDeliveryUnknownArtifact(
  artifact: Pick<ArtifactFailureView, "status" | "reviewerNote">,
): boolean {
  return (
    artifact.status === OutreachArtifactStatus.REJECTED &&
    artifact.reviewerNote?.startsWith(LEGACY_DELIVERY_UNKNOWN_PREFIX) === true
  );
}

/**
 * The one shared projection from rolling-deploy storage state to the status
 * understood by current readers. No API or policy path should interpret a
 * reserved compatibility marker from the physical REJECTED value directly.
 */
export function effectiveArtifactStatus(
  artifact: Pick<
    ArtifactFailureView,
    "status" | "reviewerNote" | "failedAt"
  >,
): OutreachArtifactStatus {
  if (isLegacyDeliveryUnknownArtifact(artifact)) {
    return OutreachArtifactStatus.DELIVERY_UNKNOWN;
  }
  if (isLegacyAutoFailedArtifact(artifact)) {
    return OutreachArtifactStatus.FAILED;
  }
  return artifact.status;
}

export function isFailedArtifact(artifact: ArtifactFailureView): boolean {
  return effectiveArtifactStatus(artifact) === OutreachArtifactStatus.FAILED;
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
  const normalized = note?.trimStart();
  return (
    normalized?.startsWith(LEGACY_AUTO_FAILED_PREFIX) === true ||
    normalized?.startsWith(LEGACY_DELIVERY_UNKNOWN_PREFIX) === true
  );
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
        AND: [
          {
            NOT: {
              reviewerNote: { startsWith: LEGACY_AUTO_FAILED_PREFIX },
            },
          },
          {
            NOT: {
              reviewerNote: { startsWith: LEGACY_DELIVERY_UNKNOWN_PREFIX },
            },
          },
        ],
      },
    ],
  };
}

export function deliveryUnknownArtifactWhere(): Prisma.OutreachArtifactWhereInput {
  return {
    OR: [
      { status: OutreachArtifactStatus.DELIVERY_UNKNOWN },
      {
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: { startsWith: LEGACY_DELIVERY_UNKNOWN_PREFIX },
      },
    ],
  };
}

/** Database predicate for the API's effective status during rolling deploy. */
export function effectiveArtifactStatusWhere(
  status: OutreachArtifactStatus,
): Prisma.OutreachArtifactWhereInput {
  if (status === OutreachArtifactStatus.FAILED) return failedArtifactWhere();
  if (status === OutreachArtifactStatus.DELIVERY_UNKNOWN)
    return deliveryUnknownArtifactWhere();
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
      {
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: { startsWith: LEGACY_DELIVERY_UNKNOWN_PREFIX },
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
      {
        status: OutreachArtifactStatus.REJECTED,
        reviewerNote: { startsWith: LEGACY_DELIVERY_UNKNOWN_PREFIX },
      },
    ],
  };
}
