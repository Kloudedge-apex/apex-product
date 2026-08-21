import { Injectable, Logger } from "@nestjs/common";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { PrismaService } from "../prisma/prisma.service";
import {
  EVIDENCE_EVENT_KIND,
  type EvidenceEventPayload,
  type EvidenceRefType,
  type SignalEventKind,
  type SignalRecordedPayload,
} from "./evidence-event.types";
import {
  normalizeSignalConfidence,
  normalizeSignalDate,
  normalizeSignalSourceUrl,
} from "./signal-citation";

interface AppendEventInput<TPayload extends EvidenceEventPayload> {
  readonly orgId: string;
  readonly runId?: string | null;
  readonly kind: TPayload["kind"];
  readonly refType: EvidenceRefType;
  readonly refId: string;
  readonly payload: TPayload;
}

export type SignalPersistenceResult =
  | "CREATED"
  | "EXISTING"
  | "DISABLED"
  | "REJECTED"
  | "FAILED";

type AppendResult = "CREATED" | "DISABLED" | "FAILED";

@Injectable()
export class EvidenceLedgerService {
  private readonly logger = new Logger(EvidenceLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.EVIDENCE_LEDGER_ENABLED !== "false";
  }

  private async appendResult<TPayload extends EvidenceEventPayload>(
    input: AppendEventInput<TPayload>,
  ): Promise<AppendResult> {
    if (!this.isEnabled()) return "DISABLED";

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
      return "CREATED";
    } catch (err) {
      // Do not throw from the shared ledger writer: generic observability events
      // remain best-effort, while critical callers (such as research) can treat
      // the explicit FAILED result as a stage gate. The span makes a failure
      // spike alertable rather than silently losing auditability.
      active?.recordException(
        err instanceof Error ? err : new Error(String(err)),
      );
      active?.setStatus({
        code: SpanStatusCode.ERROR,
        message: "evidence_event_append_failed",
      });
      this.logger.warn(
        `Failed to append EvidenceEvent kind=${input.kind} refType=${input.refType} refId=${input.refId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "FAILED";
    }
  }

  private async append<TPayload extends EvidenceEventPayload>(
    input: AppendEventInput<TPayload>,
  ): Promise<void> {
    await this.appendResult(input);
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

  async recordSignal(input: {
    readonly orgId: string;
    readonly runId?: string | null;
    readonly companyId?: string | null;
    readonly personId?: string | null;
    readonly kind: SignalEventKind;
    readonly source: string;
    readonly date: string;
    readonly summary?: string;
    readonly confidence: number;
    readonly fields?: Partial<
      Omit<
        SignalRecordedPayload,
        "kind" | "source" | "date" | "summary" | "confidence"
      >
    >;
  }): Promise<SignalPersistenceResult> {
    // Fail closed on the citation invariant AT THE WRITER. A non-empty string
    // is not enough: require an absolute HTTP(S) URL without credentials, a
    // strict real calendar date, and a bounded probability. The contract must
    // not depend on every future extractor getting these checks right.
    const source = normalizeSignalSourceUrl(input.source);
    const date = normalizeSignalDate(input.date);
    const confidence = normalizeSignalConfidence(input.confidence);
    if (!source || !date || confidence === null) {
      this.logger.warn(
        `Skipped uncitable signal kind=${input.kind} (invalid source, date, or confidence) for org=${input.orgId} run=${input.runId ?? "-"}`,
      );
      return "REJECTED";
    }

    if (!this.isEnabled()) return "DISABLED";

    const refType: EvidenceRefType = input.companyId ? "company" : "person";
    const refId = input.companyId ?? input.personId ?? "unknown";

    // Idempotency (spec §Components.2): skip if an identical signal already
    // exists for this run, so a graph resume/retry — which may replay the node
    // after some companies were already written — does not duplicate facts. This
    // is a pre-INSERT READ, compatible with the append-only trigger (which
    // forbids UPDATE/DELETE on evidence_event).
    try {
      const existing = await this.prisma.evidenceEvent.findFirst({
        where: {
          orgId: input.orgId,
          runId: input.runId ?? null,
          refType,
          refId,
          kind: input.kind,
          payload: { path: ["source"], equals: source },
        },
        select: { id: true },
      });
      if (existing) return "EXISTING";
    } catch (err) {
      const active = trace.getActiveSpan();
      active?.recordException(
        err instanceof Error ? err : new Error(String(err)),
      );
      active?.setStatus({
        code: SpanStatusCode.ERROR,
        message: "evidence_event_idempotency_read_failed",
      });
      this.logger.warn(
        `Failed to check EvidenceEvent idempotency kind=${input.kind} refType=${refType} refId=${refId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "FAILED";
    }

    return this.appendResult({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: input.kind,
      refType,
      refId,
      // Canonical citation keys are spread LAST so a stray `source`/`date` in
      // `fields` can never override the real, validated values above.
      payload: {
        ...(input.fields ?? {}),
        kind: input.kind,
        source,
        date,
        summary: input.summary,
        confidence,
      } as SignalRecordedPayload,
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
      payload: {
        kind: EVIDENCE_EVENT_KIND.qaPass,
        duration_ms: input.durationMs,
      },
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
    readonly status: import("@prisma/client").OutreachArtifactStatus;
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
      input.refId ?? input.artifactId ?? input.sendReceiptId ?? "unknown";
    return this.append({
      orgId: input.orgId,
      runId: input.runId ?? null,
      kind: EVIDENCE_EVENT_KIND.messageSent,
      refType,
      refId,
      payload: {
        kind: EVIDENCE_EVENT_KIND.messageSent,
        ...(input.artifactId
          ? { artifact_id: input.artifactId }
          : { artifact_id: null }),
        channel: input.channel,
        ...(input.recipientRef ? { recipient_ref: input.recipientRef } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.sendReceiptId
          ? { send_receipt_id: input.sendReceiptId }
          : {}),
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
        ...(input.orgIdExternal
          ? { org_id_external: input.orgIdExternal }
          : {}),
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
