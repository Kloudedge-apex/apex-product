import type { EmailSource, VerificationResult } from "@prisma/client";

const SOURCE_CONFIRMED = new Set<EmailSource>([
  "TEAM_PAGE",
  "GITHUB_COMMIT",
  "SEC_FILING",
  "PRESS_RELEASE",
]);

export interface OutreachEmailCandidate {
  readonly id: string;
  readonly email: string;
  readonly source: EmailSource;
  readonly verified: boolean;
  readonly verificationResult: VerificationResult;
  readonly confidence: number;
  readonly verifiedAt: Date | string | null;
  readonly createdAt: Date | string;
}

export interface SelectedOutreachRecipient {
  readonly candidateId: string;
  readonly email: string;
  readonly source: EmailSource;
  readonly verified: boolean;
  readonly verificationResult: VerificationResult;
  readonly confidence: number;
  readonly verifiedAt: string | null;
  readonly selectionBasis: "VERIFIED_VALID" | "SOURCE_CONFIRMED";
}

export function sameSelectedOutreachRecipient(
  left: SelectedOutreachRecipient,
  right: SelectedOutreachRecipient,
): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.email === right.email &&
    left.source === right.source &&
    left.verified === right.verified &&
    left.verificationResult === right.verificationResult &&
    left.confidence === right.confidence &&
    left.verifiedAt === right.verifiedAt &&
    left.selectionBasis === right.selectionBasis
  );
}

interface RankedCandidate {
  readonly candidate: OutreachEmailCandidate;
  readonly email: string;
  readonly selectionBasis: SelectedOutreachRecipient["selectionBasis"];
}

/**
 * Select the one address outreach is allowed to use for a person.
 *
 * Eligibility is intentionally fail-closed:
 *  - prefer a provider-verified VALID candidate;
 *  - otherwise allow a first-party/public source-confirmed candidate;
 *  - never use INVALID candidates or unverified pattern/Hunter guesses.
 *
 * Ranking is explicit so Prisma row order cannot change the recipient.
 */
export function selectOutreachRecipient(
  candidates: readonly OutreachEmailCandidate[],
): SelectedOutreachRecipient | null {
  const byAddress = new Map<string, RankedCandidate>();

  for (const candidate of candidates) {
    if (candidate.verificationResult === "INVALID") continue;

    const email = normalizeOutreachEmail(candidate.email);
    if (!email) continue;

    const selectionBasis = selectionBasisFor(candidate);
    if (!selectionBasis) continue;

    const ranked = { candidate, email, selectionBasis } satisfies RankedCandidate;
    const previous = byAddress.get(email);
    if (!previous || compareRanked(ranked, previous) < 0) {
      byAddress.set(email, ranked);
    }
  }

  const selected = [...byAddress.values()].sort(compareRanked)[0];
  if (!selected) return null;

  return {
    candidateId: selected.candidate.id,
    email: selected.email,
    source: selected.candidate.source,
    verified: selected.candidate.verified,
    verificationResult: selected.candidate.verificationResult,
    confidence: selected.candidate.confidence,
    verifiedAt: toIsoString(selected.candidate.verifiedAt),
    selectionBasis: selected.selectionBasis,
  };
}

function selectionBasisFor(
  candidate: OutreachEmailCandidate,
): SelectedOutreachRecipient["selectionBasis"] | null {
  if (candidate.verified && candidate.verificationResult === "VALID") {
    return "VERIFIED_VALID";
  }
  if (SOURCE_CONFIRMED.has(candidate.source)) {
    return "SOURCE_CONFIRMED";
  }
  return null;
}

function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  const basis = basisRank(a.selectionBasis) - basisRank(b.selectionBasis);
  if (basis !== 0) return basis;

  const confidence = finiteConfidence(b.candidate.confidence) - finiteConfidence(a.candidate.confidence);
  if (confidence !== 0) return confidence;

  const verifiedAt = dateRank(b.candidate.verifiedAt) - dateRank(a.candidate.verifiedAt);
  if (verifiedAt !== 0) return verifiedAt;

  const createdAt = dateRank(a.candidate.createdAt) - dateRank(b.candidate.createdAt);
  if (createdAt !== 0) return createdAt;

  const id = a.candidate.id.localeCompare(b.candidate.id);
  if (id !== 0) return id;
  return a.email.localeCompare(b.email);
}

function basisRank(value: SelectedOutreachRecipient["selectionBasis"]): number {
  return value === "VERIFIED_VALID" ? 0 : 1;
}

function finiteConfidence(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function dateRank(value: Date | string | null): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoString(value: Date | string | null): string | null {
  const timestamp = dateRank(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

export function normalizeOutreachEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 512 || /\s/.test(normalized)) {
    return null;
  }
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@") || at === normalized.length - 1) {
    return null;
  }
  return normalized;
}
