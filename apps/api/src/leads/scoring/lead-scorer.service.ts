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
    intentScore?: number;
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
}

interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
}

const SOURCE_CONFIRMED: EmailSource[] = ["TEAM_PAGE", "GITHUB_COMMIT", "SEC_FILING", "PRESS_RELEASE"];

@Injectable()
export class LeadScorer {
  score(person: PersonForScoring, icp: IcpForScoring): ScoreResult {
    const breakdown: Record<string, number> = {};

    // Full name: 10 pts
    if (person.firstName && person.lastName) {
      breakdown.fullName = 10;
    }

    // Job title: 10 pts
    if (person.title) {
      breakdown.jobTitle = 10;
    }

    // Company + domain: 10 pts
    if (person.company.domain && person.company.name) {
      breakdown.companyDomain = 10;
    }

    // LinkedIn URL confirmed: 20 pts
    if (person.linkedinUrl) {
      breakdown.linkedinUrl = 20;
    }

    // Geography matches ICP: 5 pts
    if (icp.targetGeos.length > 0 && person.location) {
      const loc = person.location.toLowerCase();
      const companyCountry = person.company.country?.toLowerCase();
      const matches = icp.targetGeos.some(
        (g) => loc.includes(g.toLowerCase()) || companyCountry === g.toLowerCase(),
      );
      if (matches) breakdown.geoMatch = 5;
    }

    // Seniority matches ICP: 10 pts
    if (icp.targetTitles.length > 0 && person.title) {
      const titleLower = person.title.toLowerCase();
      const matches = icp.targetTitles.some((t) => titleLower.includes(t.toLowerCase()));
      if (matches) breakdown.seniorityMatch = 10;
    }

    // Email scoring
    const hasVerified = person.emails.some((e) => e.verified);
    const hasSourceConfirmed = person.emails.some((e) => SOURCE_CONFIRMED.includes(e.source));
    const hasPatternGuess = person.emails.some((e) => e.source === "PATTERN_GUESS" && e.confidence > 0.3);

    if (hasVerified) {
      breakdown.verifiedEmail = 50;
    } else if (hasSourceConfirmed) {
      breakdown.sourceConfirmedEmail = 50;
    } else if (hasPatternGuess) {
      breakdown.patternGuessedEmail = 15;
    }

    // Buying intent signal: 15 pts
    if (person.company.intentScore && person.company.intentScore >= 15) {
      breakdown.buyingIntent = 15;
    }

    // Multi-source corroboration: 10 pts
    const uniqueSources = new Set(person.emails.map((e) => e.source));
    if (uniqueSources.size >= 2) {
      breakdown.multiSourceCorroboration = 10;
    }

    const score = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

    return { score, breakdown };
  }

  isQualified(score: number): boolean {
    return score >= QUALIFIED_THRESHOLD;
  }
}
