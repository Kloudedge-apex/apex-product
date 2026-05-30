import { Injectable, Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import type { EnrichmentLicenseScope, EvaluatorTargetType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  EVIDENCE_EVENT_KIND,
  type EvidenceEventPayload,
  type EvidenceRefType,
} from "./evidence-event.types";

interface AppendEventInput<TPayload extends EvidenceEventPayload> {
  readonly orgId: string;
  readonly runId?: string | null;
  readonly kind: TPayload["kind"];
  readonly refType: EvidenceRefType;
  readonly refId: string;
  readonly payload: TPayload;
}

@Injectable()
export class EvidenceLedgerService {
  private readonly logger = new Logger(EvidenceLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.EVIDENCE_LEDGER_ENABLED !== "false";
  }

  private async append<TPayload extends EvidenceEventPayload>(
    input: AppendEventInput<TPayload>,
  ): Promise<void> {
    if (!this.isEnabled()) return;

    const active = trace.getActiveSpan();
    const traceId = active?.spanContext().traceId;

    try {
      await this.prisma.evidenceEvent.create({
        data: {
          orgId: input.orgId,
          runId: input.runId ?? null,
          traceId: traceId ?? null,
          kind: input.kind,
          refType: input.refType,
          refId: input.refId,
          payload: input.payload,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to append EvidenceEvent kind=${input.kind} refType=${input.refType} refId=${input.refId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async graphRunStarted(input: {
    readonly orgId: string;
    readonly graphRunId: string;
    readonly supervisorPlan: unknown;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.graphRunId,
      kind: EVIDENCE_EVENT_KIND.graphRunStarted,
      refType: "graph_run",
      refId: input.graphRunId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.graphRunStarted,
        orgId: input.orgId,
        graphRunId: input.graphRunId,
        supervisorPlan: input.supervisorPlan as never,
      },
    });
  }

  async graphRunCompleted(input: {
    readonly orgId: string;
    readonly graphRunId: string;
    readonly status: string;
    readonly durationMs: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.graphRunId,
      kind: EVIDENCE_EVENT_KIND.graphRunCompleted,
      refType: "graph_run",
      refId: input.graphRunId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.graphRunCompleted,
        orgId: input.orgId,
        graphRunId: input.graphRunId,
        status: input.status,
        durationMs: input.durationMs,
      },
    });
  }

  async leadSourced(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly companies: number;
    readonly people: number;
    readonly durationMs?: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.leadSourced,
      refType: "workflow_run",
      refId: input.runId ?? "unknown",
      payload: {
        kind: EVIDENCE_EVENT_KIND.leadSourced,
        companies: input.companies,
        people: input.people,
        duration_ms: input.durationMs,
      },
    });
  }

  async leadScored(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly scored: number;
    readonly durationMs?: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.leadScored,
      refType: "workflow_run",
      refId: input.runId ?? "unknown",
      payload: {
        kind: EVIDENCE_EVENT_KIND.leadScored,
        scored: input.scored,
        duration_ms: input.durationMs,
      },
    });
  }

  async messageDrafted(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly personId: string;
    readonly model: string;
    readonly tokensUsed: number;
    readonly costUsd: number;
    readonly durationMs?: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.messageDrafted,
      refType: "person",
      refId: input.personId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.messageDrafted,
        model: input.model,
        tokens_used: input.tokensUsed,
        cost_usd: input.costUsd,
        duration_ms: input.durationMs,
      },
    });
  }

  async llmRequestRecorded(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly model: string;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly status: "OK" | "ERROR" | "TIMEOUT" | "CANCELLED";
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.llmRequestRecorded,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.llmRequestRecorded,
        orgId: input.orgId,
        model: input.model,
        costUsd: input.costUsd,
        latencyMs: input.latencyMs,
        status: input.status,
      },
    });
  }

  async usageRollupCompleted(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly granularity: "hour" | "day";
    readonly bucket: Date;
    readonly totals: {
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
    };
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.usageRollupCompleted,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.usageRollupCompleted,
        orgId: input.orgId,
        granularity: input.granularity,
        bucket: input.bucket.toISOString(),
        totals: input.totals,
      },
    });
  }

  async usageRollupFailed(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly granularity: "hour" | "day";
    readonly bucket: Date;
    readonly error: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.usageRollupFailed,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.usageRollupFailed,
        orgId: input.orgId,
        granularity: input.granularity,
        bucket: input.bucket.toISOString(),
        error: input.error,
      },
    });
  }

  async qaPass(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly personId: string;
    readonly durationMs?: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.qaPass,
      refType: "person",
      refId: input.personId,
      payload: { kind: EVIDENCE_EVENT_KIND.qaPass, duration_ms: input.durationMs },
    });
  }

  async qaFail(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly personId: string;
    readonly issues: readonly string[];
    readonly durationMs?: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.qaFail,
      refType: "person",
      refId: input.personId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.qaFail,
        issues: input.issues,
        duration_ms: input.durationMs,
      },
    });
  }

  async approvalRequested(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly candidateCount: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.approvalRequested,
      refType: "workflow_run",
      refId: input.runId ?? "unknown",
      payload: {
        kind: EVIDENCE_EVENT_KIND.approvalRequested,
        candidate_count: input.candidateCount,
      },
    });
  }

  async approvalGranted(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly approvedBy?: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.approvalGranted,
      refType: "workflow_run",
      refId: input.runId ?? "unknown",
      payload: {
        kind: EVIDENCE_EVENT_KIND.approvalGranted,
        approved_by: input.approvedBy,
      },
    });
  }

  async approvalDenied(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly deniedBy?: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.approvalDenied,
      refType: "workflow_run",
      refId: input.runId ?? "unknown",
      payload: {
        kind: EVIDENCE_EVENT_KIND.approvalDenied,
        denied_by: input.deniedBy,
      },
    });
  }

  async artifactPersisted(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly artifactId: string;
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
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.artifactPersisted,
      refType: "outreach_artifact",
      refId: input.artifactId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.artifactPersisted,
        status: input.status,
        channel: input.channel,
      },
    });
  }

  async outreachSuppressed(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly artifactId: string;
    readonly suppressionEntryIds: readonly string[];
    readonly kinds: readonly string[];
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.outreachSuppressed,
      refType: "outreach_artifact",
      refId: input.artifactId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.outreachSuppressed,
        artifact_id: input.artifactId,
        suppression_entry_ids: input.suppressionEntryIds,
        kinds: input.kinds,
      },
    });
  }

  async artifactStatusTransition(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly artifactId: string;
    readonly fromStatus: string;
    readonly toStatus: string;
    readonly reason: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.artifactStatusTransition,
      refType: "outreach_artifact",
      refId: input.artifactId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.artifactStatusTransition,
        orgId: input.orgId,
        artifactId: input.artifactId,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reason: input.reason,
      },
    });
  }

  async replyFlaggedForReview(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly replyId: string;
    readonly intent: string;
    readonly reason: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.replyFlaggedForReview,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.replyFlaggedForReview,
        orgId: input.orgId,
        replyId: input.replyId,
        intent: input.intent,
        reason: input.reason,
      },
    });
  }

  async messageSent(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    /**
     * Required when emitting from the post-approval send path (artifact-driven).
     * Omit/leave null for in-loop tool-call emissions, where there is no
     * approved artifact backing the send — refType+refId must then be set to
     * "outreach_tool_call" and the provider message id, respectively.
     */
    readonly artifactId?: string | null;
    readonly channel: "EMAIL" | "LINKEDIN" | "HUBSPOT_NOTE";
    readonly recipientRef?: string | null;
    readonly subject?: string | null;
    readonly sendReceiptId?: string | null;
    readonly provider?: string | null;
    readonly refType?: "outreach_artifact" | "outreach_tool_call";
    readonly refId?: string | null;
  }): Promise<void> {
    const refType: "outreach_artifact" | "outreach_tool_call" =
      input.refType ?? "outreach_artifact";
    const refId =
      input.refId ??
      input.artifactId ??
      input.sendReceiptId ??
      "unknown";
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.messageSent,
      refType,
      refId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.messageSent,
        ...(input.artifactId ? { artifact_id: input.artifactId } : { artifact_id: null }),
        channel: input.channel,
        ...(input.recipientRef ? { recipient_ref: input.recipientRef } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.sendReceiptId ? { send_receipt_id: input.sendReceiptId } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
      },
    });
  }

  async outreachSendPersistenceFailed(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly artifactId: string;
    readonly provider?: string | null;
    readonly sendReceiptId?: string | null;
    readonly error: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.outreachSendPersistenceFailed,
      refType: "outreach_artifact",
      refId: input.artifactId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.outreachSendPersistenceFailed,
        artifact_id: input.artifactId,
        provider: input.provider ?? null,
        send_receipt_id: input.sendReceiptId ?? null,
        error: input.error,
      },
    });
  }

  async suppressionCreated(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly suppressionEntryId: string;
    readonly scope: string;
    readonly kind: string;
    readonly source: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.suppressionCreated,
      refType: "suppression_entry",
      refId: input.suppressionEntryId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.suppressionCreated,
        suppression_entry_id: input.suppressionEntryId,
        scope: input.scope,
        suppression_kind: input.kind,
        source: input.source,
      },
    });
  }

  async suppressionRevoked(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly suppressionEntryId: string;
    readonly scope: string;
    readonly kind: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.suppressionRevoked,
      refType: "suppression_entry",
      refId: input.suppressionEntryId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.suppressionRevoked,
        suppression_entry_id: input.suppressionEntryId,
        scope: input.scope,
        suppression_kind: input.kind,
      },
    });
  }

  async crmSynced(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly provider: "hubspot" | "salesforce";
    readonly entityType: "contact" | "deal" | "note";
    readonly entityId: string;
    readonly operation: "create" | "update" | "delete";
    readonly orgIdExternal?: string | null;
    readonly fieldsChanged?: readonly string[];
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.crmSynced,
      refType: "crm_object",
      refId: input.entityId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.crmSynced,
        provider: input.provider,
        entity_type: input.entityType,
        entity_id: input.entityId,
        operation: input.operation,
        ...(input.orgIdExternal ? { org_id_external: input.orgIdExternal } : {}),
        ...(input.fieldsChanged && input.fieldsChanged.length > 0
          ? { fields_changed: input.fieldsChanged }
          : {}),
      },
    });
  }

  async replyClassified(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly replyId: string;
    readonly intent: string;
    readonly confidence: number;
    readonly classifierName: string;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.replyClassified,
      refType: "reply",
      refId: input.replyId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.replyClassified,
        replyId: input.replyId,
        intent: input.intent,
        confidence: input.confidence,
        classifierName: input.classifierName,
      },
    });
  }

  async replyClassificationNeedsReview(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly replyId: string;
    readonly llmIntent: string;
    readonly llmConfidence: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.replyClassificationNeedsReview,
      refType: "reply",
      refId: input.replyId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.replyClassificationNeedsReview,
        replyId: input.replyId,
        llmIntent: input.llmIntent,
        llmConfidence: input.llmConfidence,
      },
    });
  }

  async enrichmentFactRecorded(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly provider: string;
    readonly lookupKey: string;
    readonly field: string;
    readonly cached: boolean;
    readonly costUsd?: Prisma.Decimal | number | string | null;
    readonly licenseScope: EnrichmentLicenseScope;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.enrichmentFactRecorded,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.enrichmentFactRecorded,
        orgId: input.orgId,
        provider: input.provider,
        lookupKey: input.lookupKey,
        field: input.field,
        cached: input.cached,
        costUsd:
          input.costUsd === null || input.costUsd === undefined
            ? null
            : typeof input.costUsd === "string" || typeof input.costUsd === "number"
              ? input.costUsd
              : input.costUsd.toString(),
        licenseScope: input.licenseScope,
      },
    });
  }

  async evaluatorRunRecorded(input: {
    readonly orgId: string;
    readonly evaluatorName: string;
    readonly targetType: EvaluatorTargetType;
    readonly targetId: string;
    readonly score: number;
    readonly passed: boolean;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: null,
      kind: EVIDENCE_EVENT_KIND.evaluatorRunRecorded,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.evaluatorRunRecorded,
        orgId: input.orgId,
        evaluatorName: input.evaluatorName,
        targetType: input.targetType,
        targetId: input.targetId,
        score: input.score,
        passed: input.passed,
      },
    });
  }

  async enrichmentCacheHit(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly provider: string;
    readonly lookupKey: string;
    readonly field: string;
    readonly ageMs: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.enrichmentCacheHit,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.enrichmentCacheHit,
        orgId: input.orgId,
        provider: input.provider,
        lookupKey: input.lookupKey,
        field: input.field,
        age_ms: input.ageMs,
      },
    });
  }

  async goldenSetSeeded(input: {
    readonly orgId: string;
    readonly evaluatorName: string;
    readonly count: number;
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: null,
      kind: EVIDENCE_EVENT_KIND.goldenSetSeeded,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.goldenSetSeeded,
        orgId: input.orgId,
        evaluatorName: input.evaluatorName,
        count: input.count,
      },
    });
  }
}
