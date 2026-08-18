import { isFresh } from "../graph/nodes/research/freshness";
import { isMocked } from "../runtime/tools/mock-metadata";

const SIGNAL_KINDS = new Set([
  "recent_hire",
  "funding_event",
  "leadership_change",
  "product_launch",
  "press_mention",
]);

export interface LeadScoreBreakdown {
  fit: number;
  intent: number;
  engagement: number;
  timing: number;
}

export interface LeadEvidenceRow {
  id: string;
  kind: string;
  payload: unknown;
  createdAt: Date;
}

export interface AttributableIntentSignal {
  label: string;
  confidence: number;
}

export interface EvidenceEventSummary {
  id: string;
  eventType: string;
  description: string;
  timestamp: string;
}

function clampPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * LeadScorer v2 persists four independent percentages. Older feature-level
 * rows are mapped conservatively so an upgrade does not erase their useful
 * provenance or pretend that an aggregate total was a category score.
 */
export function normalizeLeadScoreBreakdown(
  raw: unknown,
): LeadScoreBreakdown | null {
  const input = record(raw);
  if (Object.keys(input).length === 0) return null;

  if (
    ["fit", "intent", "engagement", "timing"].some(
      (key) => typeof input[key] === "number",
    )
  ) {
    return {
      fit: clampPercent(input.fit),
      intent: clampPercent(input.intent),
      engagement: clampPercent(input.engagement),
      timing: clampPercent(input.timing),
    };
  }

  const numberAt = (key: string): number =>
    typeof input[key] === "number" && Number.isFinite(input[key])
      ? (input[key] as number)
      : 0;

  const legacyFit =
    numberAt("fullName") +
    numberAt("jobTitle") +
    numberAt("companyDomain") +
    numberAt("geoMatch") +
    numberAt("seniorityMatch");
  const legacyEngagement =
    numberAt("verifiedEmail") +
    numberAt("sourceConfirmedEmail") +
    numberAt("patternGuessedEmail") +
    numberAt("linkedinUrl") +
    numberAt("multiSourceCorroboration");
  const legacyIntent = numberAt("buyingIntent");

  if (legacyFit === 0 && legacyEngagement === 0 && legacyIntent === 0)
    return null;

  return {
    fit: clampPercent((legacyFit / 45) * 100),
    intent: clampPercent((legacyIntent / 15) * 100),
    engagement: clampPercent((legacyEngagement / 80) * 100),
    timing: 0,
  };
}

function stringAt(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function summarizeLeadEvidence(
  kind: string,
  payloadValue: unknown,
): string {
  const payload = record(payloadValue);
  const summary = stringAt(payload, "summary");
  if (summary) return summary;

  switch (kind) {
    case "recent_hire":
      return `Hiring for ${stringAt(payload, "jobTitle") ?? stringAt(payload, "title") ?? "a new role"}.`;
    case "funding_event": {
      const amount = stringAt(payload, "amount") ?? "new funding";
      const round = stringAt(payload, "round");
      return `Announced ${amount}${round ? ` in a ${round}` : ""}.`;
    }
    case "leadership_change":
      return `${stringAt(payload, "name") ?? "A new leader"} joined as ${stringAt(payload, "role") ?? "a leadership hire"}.`;
    case "product_launch":
      return `Launched ${stringAt(payload, "productName") ?? stringAt(payload, "name") ?? "a new product"}.`;
    case "press_mention":
      return `${stringAt(payload, "headline") ?? "Recent company coverage"}${stringAt(payload, "outlet") ? ` (${stringAt(payload, "outlet")})` : ""}.`;
    case "message.drafted":
      return "An outreach draft was generated for human review.";
    case "qa.pass":
      return "The outreach draft passed automated quality checks.";
    case "qa.fail":
      return "The outreach draft needs revision after quality checks.";
    case "message.sent":
      return "Approved outreach was sent.";
    case "crm.synced":
      return "The lead was synchronized to the connected CRM.";
    default:
      return "A lead workflow event was recorded.";
  }
}

export function isAttributableSignal(
  event: LeadEvidenceRow,
  now = new Date(),
): boolean {
  if (!SIGNAL_KINDS.has(event.kind)) return false;
  const payload = record(event.payload);
  if (isMocked(payload)) return false;
  const source = stringAt(payload, "source");
  const date = stringAt(payload, "date");
  const confidence = payload.confidence;
  return Boolean(
    source &&
    date &&
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence > 0 &&
    isFresh(event.kind, date, now),
  );
}

export function toIntentSignals(
  events: readonly LeadEvidenceRow[],
  now = new Date(),
): AttributableIntentSignal[] {
  return events
    .filter((event) => isAttributableSignal(event, now))
    .map((event) => {
      const payload = record(event.payload);
      return {
        label: summarizeLeadEvidence(event.kind, payload).replace(/\.$/, ""),
        confidence: Math.max(0, Math.min(1, payload.confidence as number)),
      };
    })
    .slice(0, 5);
}

export function toEvidenceTimeline(
  events: readonly LeadEvidenceRow[],
  now = new Date(),
): EvidenceEventSummary[] {
  return events
    .filter(
      (event) =>
        !SIGNAL_KINDS.has(event.kind) || isAttributableSignal(event, now),
    )
    .map((event) => {
      const payload = record(event.payload);
      const source = SIGNAL_KINDS.has(event.kind)
        ? stringAt(payload, "source")
        : null;
      const description = summarizeLeadEvidence(event.kind, payload);
      return {
        id: event.id,
        eventType: event.kind
          .split(/[._]/)
          .filter(Boolean)
          .map((part) => part[0]!.toUpperCase() + part.slice(1))
          .join(" "),
        description: source ? `${description} Source: ${source}` : description,
        timestamp: event.createdAt.toISOString(),
      };
    })
    .slice(0, 10);
}

export function buildLeadResearchBrief(input: {
  firstName: string;
  lastName: string;
  title: string | null;
  location: string | null;
  company: {
    name: string;
    domain: string;
    industry: string | null;
    employeeRange: string | null;
    city: string | null;
    country: string | null;
    fundingStage: string | null;
    techStack: string[];
  };
  score: number | null;
  evidence: readonly LeadEvidenceRow[];
  now?: Date;
}): string {
  const personName = `${input.firstName} ${input.lastName}`.trim();
  const role = input.title ? `${input.title} at ` : "at ";
  const companyFacts = [
    input.company.industry,
    input.company.employeeRange
      ? `${input.company.employeeRange} employees`
      : null,
    [input.company.city, input.company.country].filter(Boolean).join(", ") ||
      null,
    input.company.fundingStage,
  ].filter((value): value is string => Boolean(value));

  const sentences = [
    `${personName} is ${role}${input.company.name}${input.location ? ` and is based in ${input.location}` : ""}.`,
    companyFacts.length > 0
      ? `${input.company.name} is recorded as ${companyFacts.join(", ")}.`
      : `${input.company.name} uses ${input.company.domain}.`,
  ];
  if (input.company.techStack.length > 0) {
    sentences.push(
      `Recorded technology includes ${input.company.techStack.slice(0, 5).join(", ")}.`,
    );
  }
  if (input.score !== null)
    sentences.push(`The current lead score is ${input.score}/100.`);

  const attributable = input.evidence
    .filter((event) => isAttributableSignal(event, input.now))
    .slice(0, 2)
    .map((event) => summarizeLeadEvidence(event.kind, event.payload));
  if (attributable.length > 0) {
    sentences.push(`Recent attributable evidence: ${attributable.join(" ")}`);
  } else {
    sentences.push(
      "No fresh attributable buying signal is currently recorded for this lead.",
    );
  }

  return sentences.join(" ");
}
