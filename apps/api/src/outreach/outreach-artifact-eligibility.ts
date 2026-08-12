import { BadRequestException } from "@nestjs/common";
import {
  OutreachArtifact,
  OutreachArtifactPurpose,
  OutreachChannel,
} from "@prisma/client";

/**
 * Last trusted validation before an artifact may enter or remain on the send
 * path. It binds reviewer-visible fields to the verbatim payload executed by
 * the worker and fail-closes ungrounded outbound drafts.
 */
export function assertArtifactDispatchEligible(
  artifact: OutreachArtifact,
): void {
  if (artifact.channel === OutreachChannel.HUBSPOT_NOTE) {
    throw new BadRequestException(
      "HubSpot note approval is unavailable because dispatch is not implemented",
    );
  }
  if (artifact.channel !== OutreachChannel.EMAIL) {
    throw new BadRequestException(
      `${artifact.channel} approval is unavailable because only email dispatch is supported in this release`,
    );
  }

  const payload = asRecord(artifact.payload);
  if (!payload) {
    throw new BadRequestException(
      "Artifact cannot be approved because its send payload is invalid",
    );
  }

  const to = nonBlankString(payload.to);
  const subject = nonBlankString(payload.subject);
  const body = nonBlankString(payload.body);
  if (!to || !subject || !body) {
    throw new BadRequestException(
      "Artifact cannot be approved without a recipient, subject, and body",
    );
  }
  // SendEmailTool dispatches payload.body, and bodyText is the corresponding
  // reviewer-visible field. Optional bodyHtml must never substitute for it.
  if (
    to !== artifact.recipientRef ||
    subject !== artifact.subject ||
    body !== artifact.bodyText
  ) {
    throw new BadRequestException(
      "Artifact cannot be approved because the reviewed content does not match the send payload",
    );
  }

  if (artifact.purpose !== OutreachArtifactPurpose.OUTBOUND) return;

  if (payload.refusal !== undefined && payload.refusal !== null) {
    const refusal = asRecord(payload.refusal);
    const missing = strictStringArray(refusal?.missing);
    if (!refusal || !nonBlankString(refusal.reason) || missing === null) {
      throw new BadRequestException(
        "Artifact cannot be approved because its refusal metadata is invalid",
      );
    }
    throw new BadRequestException(
      "Artifact cannot be approved because the agent refused to produce a grounded draft",
    );
  }

  const qaIssues = strictStringArray(payload.qaIssues);
  if (qaIssues === null) {
    throw new BadRequestException(
      "Artifact cannot be approved because its draft quality metadata is invalid",
    );
  }
  if (qaIssues.length > 0) {
    throw new BadRequestException(
      "Artifact cannot be approved until all draft quality checks pass",
    );
  }

  const selfCheck = asRecord(payload.groundedness_self_check);
  const citedFactIds = strictStringArray(
    selfCheck?.citedFactIds ?? selfCheck?.cited_fact_ids,
  );
  const unsupportedClaims = strictStringArray(
    selfCheck?.unsupportedClaims ?? selfCheck?.unsupported_claims,
  );
  const briefFacts = parseReviewerFacts(payload.brief_facts);

  if (
    !selfCheck ||
    citedFactIds === null ||
    citedFactIds.length === 0 ||
    unsupportedClaims === null ||
    unsupportedClaims.length > 0 ||
    !briefFacts ||
    !citedFactIds.every((factId) => briefFacts.has(factId))
  ) {
    throw new BadRequestException(
      "Artifact cannot be approved without a clean, reviewer-visible grounding check",
    );
  }

  // assembleResearchBrief is the only producer of `category: "signal"` facts
  // and adds them only after isMocked + isFresh pass. Requiring a cited signal
  // closes the loophole where a draft could cite only a static company/person
  // fact even though the guarded SDR contract requires a fresh trigger.
  if (
    !citedFactIds.some(
      (factId) => briefFacts.get(factId)?.category === "signal",
    )
  ) {
    throw new BadRequestException(
      "Artifact cannot be approved without citing a fresh, non-mock signal",
    );
  }
}

interface ReviewerFact {
  readonly id: string;
  readonly category: "firmographic" | "person" | "signal" | "icp_fit";
}

const REVIEWER_FACT_CATEGORIES = new Set<ReviewerFact["category"]>([
  "firmographic",
  "person",
  "signal",
  "icp_fit",
]);

function parseReviewerFacts(value: unknown): Map<string, ReviewerFact> | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const facts = new Map<string, ReviewerFact>();
  for (const valueItem of value) {
    const item = asRecord(valueItem);
    const id = nonBlankString(item?.id);
    const category = nonBlankString(item?.category);
    const source = nonBlankString(item?.source);
    const text = nonBlankString(item?.text);
    if (
      !item ||
      !id ||
      !category ||
      !REVIEWER_FACT_CATEGORIES.has(category as ReviewerFact["category"]) ||
      !source ||
      !text ||
      facts.has(id)
    ) {
      return null;
    }
    facts.set(id, {
      id,
      category: category as ReviewerFact["category"],
    });
  }
  return facts;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function strictStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) return null;
    result.push(item);
  }
  return result;
}
