import type { EvaluatorTargetType, LlmRequestStatus, Prisma } from "@prisma/client";

export const EVIDENCE_EVENT_KIND = {
  graphRunStarted: "graph_run_started",
  graphRunCompleted: "graph_run_completed",
  leadSourced: "lead.sourced",
  leadScored: "lead.scored",
  messageDrafted: "message.drafted",
  qaPass: "qa.pass",
  qaFail: "qa.fail",
  approvalRequested: "approval.requested",
  approvalGranted: "approval.granted",
  approvalDenied: "approval.denied",
  artifactPersisted: "artifact.persisted",
  artifactStatusTransition: "artifact_status_transition",
  messageSent: "message.sent",
  outreachSendPersistenceFailed: "outreach_send_persistence_failed",
  outreachSuppressed: "outreach_suppressed",
  suppressionCreated: "suppression_created",
  suppressionRevoked: "suppression_revoked",
  crmSynced: "crm.synced",
  replyClassified: "reply_classified",
  replyClassificationNeedsReview: "reply_classification_needs_review",
  enrichmentFactRecorded: "enrichment_fact_recorded",
  enrichmentCacheHit: "enrichment_cache_hit",
  llmRequestRecorded: "llm_request_recorded",
  usageRollupCompleted: "usage_rollup_completed",
  usageRollupFailed: "usage_rollup_failed",
  evaluatorRunRecorded: "evaluator_run_recorded",
  goldenSetSeeded: "golden_set_seeded",
  replyFlaggedForReview: "reply_flagged_for_review",
} as const;

export type EvidenceEventKind =
  (typeof EVIDENCE_EVENT_KIND)[keyof typeof EVIDENCE_EVENT_KIND];

export type EvidenceRefType =
  | "workflow_run"
  | "graph_run"
  | "org"
  | "person"
  | "reply"
  | "outreach_artifact"
  | "outreach_tool_call"
  | "suppression_entry"
  | "crm_object";

export interface LeadSourcedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.leadSourced;
  readonly companies: number;
  readonly people: number;
  readonly duration_ms?: number;
}

export interface GraphRunStartedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.graphRunStarted;
  readonly orgId: string;
  readonly graphRunId: string;
  readonly supervisorPlan: Prisma.InputJsonValue;
}

export interface GraphRunCompletedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.graphRunCompleted;
  readonly orgId: string;
  readonly graphRunId: string;
  readonly status: string;
  readonly durationMs: number;
}

export interface LeadScoredPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.leadScored;
  readonly scored: number;
  readonly duration_ms?: number;
}

export interface MessageDraftedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.messageDrafted;
  readonly model: string;
  readonly tokens_used: number;
  readonly cost_usd: number;
  readonly duration_ms?: number;
}

export interface QaPassPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.qaPass;
  readonly duration_ms?: number;
}

export interface QaFailPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.qaFail;
  readonly issues: readonly string[];
  readonly duration_ms?: number;
}

export interface ApprovalRequestedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.approvalRequested;
  readonly candidate_count: number;
}

export interface ApprovalGrantedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.approvalGranted;
  readonly approved_by?: string;
}

export interface ApprovalDeniedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.approvalDenied;
  readonly denied_by?: string;
}

export interface ArtifactPersistedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.artifactPersisted;
  readonly status:
    | "DRAFT"
    | "PENDING_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "QUEUED"
    | "SENT"
    | "REPLIED"
    | "BOUNCED"
    | "SUPPRESSED";
  readonly channel: "EMAIL" | "LINKEDIN" | "HUBSPOT_NOTE";
}

export interface ArtifactStatusTransitionPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.artifactStatusTransition;
  readonly orgId: string;
  readonly artifactId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason: string;
}

export interface MessageSentPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.messageSent;
  /**
   * Optional: present when the send originated from an approved
   * OutreachArtifact. Null/absent when the send was emitted directly from an
   * in-loop agent tool call (no artifact intermediary).
   */
  readonly artifact_id?: string | null;
  readonly channel: "EMAIL" | "LINKEDIN" | "HUBSPOT_NOTE";
  readonly recipient_ref?: string;
  readonly subject?: string;
  readonly send_receipt_id?: string;
  readonly provider?: string;
}

export interface OutreachSendPersistenceFailedPayload
  extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.outreachSendPersistenceFailed;
  readonly artifact_id: string;
  readonly provider?: string | null;
  readonly send_receipt_id?: string | null;
  readonly error: string;
}

export interface OutreachSuppressedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.outreachSuppressed;
  readonly artifact_id: string;
  readonly suppression_entry_ids: readonly string[];
  readonly kinds: readonly string[];
}

export interface SuppressionCreatedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.suppressionCreated;
  readonly suppression_entry_id: string;
  readonly scope: string;
  readonly suppression_kind: string;
  readonly source: string;
}

export interface SuppressionRevokedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.suppressionRevoked;
  readonly suppression_entry_id: string;
  readonly scope: string;
  readonly suppression_kind: string;
}

export interface CrmSyncedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.crmSynced;
  readonly provider: "hubspot" | "salesforce";
  readonly entity_type: "contact" | "deal" | "note";
  readonly entity_id: string;
  readonly operation: "create" | "update" | "delete";
  readonly org_id_external?: string;
  readonly fields_changed?: readonly string[];
}

export interface ReplyClassifiedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.replyClassified;
  readonly replyId: string;
  readonly intent: string;
  readonly confidence: number;
  readonly classifierName: string;
}

export interface ReplyClassificationNeedsReviewPayload
  extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.replyClassificationNeedsReview;
  readonly replyId: string;
  readonly llmIntent: string;
  readonly llmConfidence: number;
}

export interface EnrichmentFactRecordedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.enrichmentFactRecorded;
  readonly orgId: string;
  readonly provider: string;
  readonly lookupKey: string;
  readonly field: string;
  readonly cached: boolean;
  readonly costUsd?: number | string | null;
  readonly licenseScope: string;
}

export interface EnrichmentCacheHitPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.enrichmentCacheHit;
  readonly orgId: string;
  readonly provider: string;
  readonly lookupKey: string;
  readonly field: string;
  readonly age_ms: number;
}

export interface LlmRequestRecordedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.llmRequestRecorded;
  readonly orgId: string;
  readonly model: string;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly status: LlmRequestStatus;
}

export interface UsageRollupTotals extends Prisma.InputJsonObject {
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

export interface UsageRollupCompletedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.usageRollupCompleted;
  readonly orgId: string;
  readonly granularity: "hour" | "day";
  readonly bucket: string;
  readonly totals: UsageRollupTotals;
}

export interface UsageRollupFailedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.usageRollupFailed;
  readonly orgId: string;
  readonly granularity: "hour" | "day";
  readonly bucket: string;
  readonly error: string;
}

export interface EvaluatorRunRecordedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.evaluatorRunRecorded;
  readonly orgId: string;
  readonly evaluatorName: string;
  readonly targetType: EvaluatorTargetType;
  readonly targetId: string;
  readonly score: number;
  readonly passed: boolean;
}

export interface GoldenSetSeededPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.goldenSetSeeded;
  readonly orgId: string;
  readonly evaluatorName: string;
  readonly count: number;
}

export interface ReplyFlaggedForReviewPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.replyFlaggedForReview;
  readonly orgId: string;
  readonly replyId: string;
  readonly intent: string;
  readonly reason: string;
}

export type EvidenceEventPayload =
  | GraphRunStartedPayload
  | GraphRunCompletedPayload
  | LeadSourcedPayload
  | LeadScoredPayload
  | MessageDraftedPayload
  | QaPassPayload
  | QaFailPayload
  | ApprovalRequestedPayload
  | ApprovalGrantedPayload
  | ApprovalDeniedPayload
  | ArtifactPersistedPayload
  | ArtifactStatusTransitionPayload
  | MessageSentPayload
  | OutreachSendPersistenceFailedPayload
  | OutreachSuppressedPayload
  | SuppressionCreatedPayload
  | SuppressionRevokedPayload
  | CrmSyncedPayload
  | ReplyClassifiedPayload
  | EnrichmentFactRecordedPayload
  | EnrichmentCacheHitPayload
  | ReplyClassificationNeedsReviewPayload
  | LlmRequestRecordedPayload
  | UsageRollupCompletedPayload
  | UsageRollupFailedPayload
  | EvaluatorRunRecordedPayload
  | GoldenSetSeededPayload
  | ReplyFlaggedForReviewPayload;
