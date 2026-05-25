/**
 * UI-facing approval envelope.
 *
 * NOTE: this is intentionally a different shape from the side-effect
 * policy `ApprovalEnvelope` in `./tools/side-effect.ts`. That one is an
 * *authorization* envelope passed into the executor before a tool runs
 * (allowedToolNames, scope, expiresAt). This one is the *review payload*
 * surfaced to the human reviewer so they can see what an agent run is
 * waiting on — one entry per PENDING_REVIEW OutreachArtifact attached to
 * the run.
 */
export interface PendingApprovalEnvelope {
  readonly artifactId: string;
  readonly channel: "EMAIL" | "LINKEDIN" | "HUBSPOT_NOTE";
  readonly recipientRef: string | null;
  readonly subject: string | null;
  /** First ~200 chars of bodyText, suitable for list previews. */
  readonly previewText: string;
  readonly bodyHtml: string | null;
  readonly toolName: string;
  /** Verbatim tool args captured at dry-run time. */
  readonly payload: unknown;
  readonly createdAt: Date;
}

/** Max preview length for `previewText`. */
export const APPROVAL_PREVIEW_MAX = 200;
