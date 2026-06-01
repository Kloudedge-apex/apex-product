import { Injectable, Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
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
    readonly status: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "SENT" | "SUPPRESSED";
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

  /**
   * GDPR / CCPA tenant erasure. This is a best-effort write: EvidenceEvent.org
   * has onDelete: Cascade, so if the org row has already been deleted (the
   * common case, since deleteOrg appends this AFTER prisma.org.delete commits)
   * Postgres will refuse the insert. That's intentional — the authoritative
   * audit record is OrgsService.deleteOrg's structured logger.log() line.
   */
  async orgDeleted(input: {
    readonly orgId: string;
    readonly orgName: string;
    readonly deletedByUserId: string;
    readonly deletedByEmail: string | null;
    readonly childCounts: {
      readonly users: number;
      readonly agents: number;
      readonly integrations: number;
      readonly agentRuns: number;
      readonly graphRuns: number;
    };
  }): Promise<void> {
    return this.append({
      orgId: input.orgId,
      runId: null,
      kind: EVIDENCE_EVENT_KIND.tenantDeletion,
      refType: "org",
      refId: input.orgId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.tenantDeletion,
        org_name: input.orgName,
        deleted_by_user_id: input.deletedByUserId,
        deleted_by_email: input.deletedByEmail,
        child_counts: {
          users: input.childCounts.users,
          agents: input.childCounts.agents,
          integrations: input.childCounts.integrations,
          agent_runs: input.childCounts.agentRuns,
          graph_runs: input.childCounts.graphRuns,
        },
      },
    });
  }
}
