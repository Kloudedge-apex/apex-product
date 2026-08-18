import { Injectable } from "@nestjs/common";
import type { Seniority, EmailSource } from "@prisma/client";
import { QUALIFIED_THRESHOLD } from "../../common/qualification.constants";

interface PersonForScoring {
  firstName: string;
  lastName: string;
  title: string | null;
  seniority: Seniority;
  location: string | null;
  linkedinUrl: string | null;
  company: {
    domain: string;
    name: string;
    country: string | null;
    industry: string | null;
    employeeRange?: string | null;
    techStack?: string[];
    intentScore?: number;
    intentSignals?: string[];
    updatedAt?: Date;
  };
  emails: Array<{
    email: string;
    verified: boolean;
    source: EmailSource;
    confidence: number;
  }>;
}

interface IcpForScoring {
  targetTitles: string[];
  targetGeos: string[];
  targetIndustries: string[];
  minEmployees?: number | null;
  maxEmployees?: number | null;
  techStackSignals?: string[];
}

interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
}

const SOURCE_CONFIRMED: EmailSource[] = ["TEAM_PAGE", "GITHUB_COMMIT", "SEC_FILING", "PRESS_RELEASE"];
const DAY_MS = 24 * 60 * 60 * 1000;

function percent(points: number, maximum: number): number {
  return Math.max(0, Math.min(100, Math.round((points / maximum) * 100)));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function textMatches(actual: string | null | undefined, targets: readonly string[]): boolean {
  if (!actual) return false;
  const candidate = normalized(actual);
  const candidateTokens = new Set(candidate.split(" ").filter((token) => token.length > 1));
  return targets.some((target) => {
    const expected = normalized(target);
    const expectedTokens = expected.split(" ").filter((token) => token.length > 1);
    return expected.length > 0 && (
      candidate.includes(expected) ||
      expected.includes(candidate) ||
      expectedTokens.every((token) => candidateTokens.has(token))
    );
  });
}

function geoMatches(location: string | null, country: string | null, targets: readonly string[]): boolean {
  const aliases: Record<string, string[]> = {
    us: ["us", "usa", "united states", "united states of america"],
    gb: ["gb", "uk", "united kingdom", "great britain"],
    ae: ["ae", "uae", "united arab emirates"],
  };
  const actual = normalized([location, country].filter(Boolean).join(" "));
  return targets.some((target) => {
    const value = normalized(target);
    const group = Object.values(aliases).find((items) => items.includes(value)) ?? [value];
    return group.some((alias) => actual.includes(alias));
  });
}

function employeeRangeMatches(
  range: string | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
): boolean {
  if (!range || (min == null && max == null)) return false;
  const numbers = range.match(/\d[\d,]*/g)?.map((value) => Number(value.replace(/,/g, ""))) ?? [];
  if (numbers.length === 0) return false;
  const actualMin = numbers[0]!;
  const actualMax = numbers[1] ?? actualMin;
  return (max == null || actualMin <= max) && (min == null || actualMax >= min);
}

@Injectable()
export class LeadScorer {
  score(person: PersonForScoring, icp: IcpForScoring): ScoreResult {
    let fitPoints = 0;
    let fitMaximum = 0;
    if (icp.targetTitles.length > 0) {
      fitMaximum += 20;
      if (textMatches(person.title, icp.targetTitles)) fitPoints += 20;
    }
    if (icp.targetIndustries.length > 0) {
      fitMaximum += 10;
      if (textMatches(person.company.industry, icp.targetIndustries)) fitPoints += 10;
    }
    if (icp.targetGeos.length > 0) {
      fitMaximum += 5;
      if (geoMatches(person.location, person.company.country, icp.targetGeos)) fitPoints += 5;
    }
    if (icp.minEmployees != null || icp.maxEmployees != null) {
      fitMaximum += 5;
      if (employeeRangeMatches(person.company.employeeRange, icp.minEmployees, icp.maxEmployees)) fitPoints += 5;
    }
    if ((icp.techStackSignals?.length ?? 0) > 0) {
      fitMaximum += 5;
      if ((person.company.techStack ?? []).some((tech) => textMatches(tech, icp.techStackSignals ?? []))) fitPoints += 5;
    }

    const fit = fitMaximum > 0 ? percent(fitPoints, fitMaximum) : 0;
    const intent = Math.max(0, Math.min(100, Math.round(person.company.intentScore ?? 0)));

    // Email scoring
    const hasVerified = person.emails.some((e) => e.verified);
    const hasSourceConfirmed = person.emails.some((e) => SOURCE_CONFIRMED.includes(e.source));
    const hasPatternGuess = person.emails.some((e) => e.source === "PATTERN_GUESS" && e.confidence > 0.3);

    let engagement = hasVerified || hasSourceConfirmed ? 80 : hasPatternGuess ? 40 : 0;
    if (person.linkedinUrl) engagement += 10;
    const uniqueSources = new Set(person.emails.map((e) => e.source));
    if (uniqueSources.size >= 2) engagement += 10;
    engagement = Math.min(100, engagement);

    const signalAgeDays = person.company.updatedAt
      ? Math.max(0, (Date.now() - person.company.updatedAt.getTime()) / DAY_MS)
      : Number.POSITIVE_INFINITY;
    const timingMultiplier = signalAgeDays <= 30 ? 1 : signalAgeDays <= 60 ? 0.6 : 0;
    const timing = intent > 0 ? Math.round(intent * timingMultiplier) : 0;

    const breakdown: Record<string, number> = { fit, intent, engagement, timing };
    const score = Math.max(0, Math.min(100, Math.round(
      fit * 0.45 + intent * 0.25 + engagement * 0.2 + timing * 0.1,
    )));

    return { score, breakdown };
  }

  isQualified(score: number): boolean {
    return score >= QUALIFIED_THRESHOLD;
  }
}
