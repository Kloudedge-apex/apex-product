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
} as const;

export type EvidenceEventKind =
  (typeof EVIDENCE_EVENT_KIND)[keyof typeof EVIDENCE_EVENT_KIND];

export type EvidenceRefType =
  | "workflow_run"
  | "graph_run"
  | "org"
  | "person"
  | "outreach_artifact";

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
  readonly status: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "SENT";
  readonly channel: "EMAIL" | "LINKEDIN" | "HUBSPOT_NOTE";
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
  | ArtifactPersistedPayload;
