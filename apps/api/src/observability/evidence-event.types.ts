import type { Prisma } from "@prisma/client";

export const EVIDENCE_EVENT_KIND = {
  leadSourced: "lead.sourced",
  leadScored: "lead.scored",
  messageDrafted: "message.drafted",
  qaPass: "qa.pass",
  qaFail: "qa.fail",
  approvalRequested: "approval.requested",
  approvalGranted: "approval.granted",
  approvalDenied: "approval.denied",
  artifactPersisted: "artifact.persisted",
  messageSent: "message.sent",
  crmSynced: "crm.synced",
  // GDPR Art. 17 / CCPA §1798.105 — tenant erasure. Emitted when an OWNER
  // deletes their org via DELETE /orgs/:id. The DB row will be cascaded away
  // along with the rest of the org's data; the evidentiary value lives in
  // the structured logger.log() line captured by the Container Apps log sink.
  tenantDeletion: "tenant.deletion",
} as const;

export type EvidenceEventKind =
  (typeof EVIDENCE_EVENT_KIND)[keyof typeof EVIDENCE_EVENT_KIND];

export type EvidenceRefType =
  | "workflow_run"
  | "graph_run"
  | "org"
  | "person"
  | "outreach_artifact"
  | "outreach_tool_call"
  | "crm_object";

export interface LeadSourcedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.leadSourced;
  readonly companies: number;
  readonly people: number;
  readonly duration_ms?: number;
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
  readonly status: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "SENT" | "SUPPRESSED";
  readonly channel: "EMAIL" | "LINKEDIN" | "HUBSPOT_NOTE";
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

export interface CrmSyncedPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.crmSynced;
  readonly provider: "hubspot" | "salesforce";
  readonly entity_type: "contact" | "deal" | "note";
  readonly entity_id: string;
  readonly operation: "create" | "update" | "delete";
  readonly org_id_external?: string;
  readonly fields_changed?: readonly string[];
}

/**
 * GDPR / CCPA tenant erasure event. The ledger row (if it lands at all) is
 * best-effort and will be cascaded away as part of the org.delete; the
 * authoritative audit record is the structured log line emitted by
 * OrgsService.deleteOrg, which the Azure Container Apps log sink retains
 * outside the Postgres blast radius.
 */
export interface TenantDeletionPayload extends Prisma.InputJsonObject {
  readonly kind: typeof EVIDENCE_EVENT_KIND.tenantDeletion;
  readonly org_name: string;
  readonly deleted_by_user_id: string;
  readonly deleted_by_email: string | null;
  readonly child_counts: {
    readonly users: number;
    readonly agents: number;
    readonly integrations: number;
    readonly agent_runs: number;
    readonly graph_runs: number;
  };
}

export type EvidenceEventPayload =
  | LeadSourcedPayload
  | LeadScoredPayload
  | MessageDraftedPayload
  | QaPassPayload
  | QaFailPayload
  | ApprovalRequestedPayload
  | ApprovalGrantedPayload
  | ApprovalDeniedPayload
  | ArtifactPersistedPayload
  | MessageSentPayload
  | CrmSyncedPayload
  | TenantDeletionPayload;
