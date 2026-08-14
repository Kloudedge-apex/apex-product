import {
  OutreachArtifactPurpose,
  OutreachArtifactStatus,
  OutreachChannel,
  type OutreachArtifact,
  type Prisma,
} from "@prisma/client";
import { ApiProperty } from "@nestjs/swagger";
import {
  effectiveArtifactStatus,
  hasLegacyAutoFailedMarker,
  isLegacyAutoFailedArtifact,
} from "./outreach-artifact-failure";

/**
 * A historical auto-failure marker without failedAt is not sufficient proof
 * that the row exhausted delivery retries. Expose that ambiguity explicitly
 * instead of presenting it as either a human rejection or a terminal failure.
 */
export const RECONCILIATION_REQUIRED_STATUS =
  "RECONCILIATION_REQUIRED" as const;

export type OutreachArtifactReadStatus =
  | OutreachArtifactStatus
  | typeof RECONCILIATION_REQUIRED_STATUS;

const OUTREACH_ARTIFACT_READ_STATUSES = [
  ...Object.values(OutreachArtifactStatus),
  RECONCILIATION_REQUIRED_STATUS,
] as const;

/**
 * Public read shape for an outreach artifact.
 *
 * `status` is the effective API status, not necessarily the rolling-deploy
 * storage representation. The physical status is deliberately not exposed as
 * a second status field: callers get one coherent state machine while the API
 * remains compatible with rows written before first-class FAILED writes were
 * enabled.
 */
export class OutreachArtifactResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orgId!: string;

  @ApiProperty({ type: String, nullable: true })
  graphRunId!: string | null;

  @ApiProperty({
    enum: OutreachArtifactPurpose,
    enumName: "OutreachArtifactPurpose",
  })
  purpose!: OutreachArtifactPurpose;

  @ApiProperty({ type: String, nullable: true })
  conversationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerThreadId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  replyToMessageId!: string | null;

  @ApiProperty()
  toolName!: string;

  @ApiProperty({ enum: OutreachChannel, enumName: "OutreachChannel" })
  channel!: OutreachChannel;

  @ApiProperty({ type: String, nullable: true })
  recipientRef!: string | null;

  @ApiProperty({ type: String, nullable: true })
  subject!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bodyText!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bodyHtml!: string | null;

  @ApiProperty({ type: "object", additionalProperties: true })
  payload!: Prisma.JsonValue;

  @ApiProperty({
    enum: OUTREACH_ARTIFACT_READ_STATUSES,
    enumName: "OutreachArtifactReadStatus",
  })
  status!: OutreachArtifactReadStatus;

  @ApiProperty({ type: String, nullable: true })
  reviewerNote!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reviewedBy!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  reviewedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  failureReason!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  failedAt!: Date | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  sentAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  sendReceiptId!: string | null;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: Date;
}

export class OutreachArtifactPageResponseDto {
  @ApiProperty({ type: () => [OutreachArtifactResponseDto] })
  items!: OutreachArtifactResponseDto[];

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  limit!: number;
}

/** Convert one persisted row into the single effective public read shape. */
export function toOutreachArtifactResponse(
  artifact: OutreachArtifact,
): OutreachArtifactResponseDto {
  let status: OutreachArtifactReadStatus = effectiveArtifactStatus(artifact);

  if (
    hasLegacyAutoFailedMarker(artifact) &&
    !isLegacyAutoFailedArtifact(artifact)
  ) {
    status = RECONCILIATION_REQUIRED_STATUS;
  }

  return { ...artifact, status };
}
