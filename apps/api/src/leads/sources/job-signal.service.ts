import { Injectable, Logger } from "@nestjs/common";

interface JobSignal {
  domain: string;
  intentScore: number;
  signals: string[];
}

/** Keywords indicating buying intent for workforce/HR/ops tools */
const INTENT_KEYWORDS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /head of people|vp.*people|chief people/i, weight: 15, label: "hiring-people-leader" },
  { pattern: /hr\s+(?:ops|operations|tech|systems)/i, weight: 12, label: "hr-ops-role" },
  { pattern: /people\s+(?:analytics|operations|systems)/i, weight: 12, label: "people-ops-role" },
  { pattern: /hris|human\s+resource\s+information/i, weight: 10, label: "hris-mention" },
  { pattern: /workforce\s+(?:planning|management|automation)/i, weight: 15, label: "workforce-mgmt" },
  { pattern: /employee\s+(?:experience|engagement|onboarding)/i, weight: 8, label: "employee-experience" },
  { pattern: /talent\s+(?:acquisition|management|ops)/i, weight: 10, label: "talent-ops" },
  { pattern: /payroll|compensation\s+(?:analyst|manager)/i, weight: 8, label: "payroll-comp" },
  { pattern: /(?:sales|revenue)\s+(?:ops|operations|enablement)/i, weight: 10, label: "sales-ops" },
  { pattern: /(?:marketing|growth)\s+(?:ops|operations)/i, weight: 10, label: "marketing-ops" },
];

@Injectable()
export class JobSignalService {
  private readonly logger = new Logger(JobSignalService.name);

  /**
   * Score a company's buying intent based on job postings.
   * Higher score = more likely to need workforce/ops tools.
   */
  scoreJobIntent(
    jobTitles: string[],
    jobDescriptions: string[],
    customerKeywords?: string[],
    targetTitles?: string[],
  ): JobSignal {
    const signals: string[] = [];
    let intentScore = 0;

    const allText = [...jobTitles, ...jobDescriptions].join(" ");
    const allTextLower = allText.toLowerCase();

    for (const kw of INTENT_KEYWORDS) {
      if (kw.pattern.test(allText)) {
        intentScore += kw.weight;
        signals.push(kw.label);
      }
    }

    // Score against customer-provided keywords
    if (customerKeywords) {
      for (const keyword of customerKeywords) {
        if (allTextLower.includes(keyword.toLowerCase())) {
          intentScore += 8;
          signals.push(`custom-kw:${keyword}`);
        }
      }
    }

    // Score against target titles (hiring for roles the customer targets = buying signal)
    if (targetTitles) {
      for (const title of targetTitles) {
        const titleLower = title.toLowerCase();
        if (jobTitles.some((jt) => jt.toLowerCase().includes(titleLower))) {
          intentScore += 10;
          signals.push(`target-title:${title}`);
        }
      }
    }

    // Bonus: volume of open roles suggests growth
    if (jobTitles.length > 20) {
      intentScore += 10;
      signals.push("high-hiring-volume");
    } else if (jobTitles.length > 10) {
      intentScore += 5;
      signals.push("moderate-hiring-volume");
    }

    return {
      domain: "",
      intentScore: Math.min(100, Math.max(0, intentScore)),
      signals: [...new Set(signals)],
    };
  }

  /**
   * Check if a company's hiring patterns indicate they need the customer's product.
   */
  hasBuyingIntent(
    jobTitles: string[],
    jobDescriptions: string[],
    customerKeywords?: string[],
    targetTitles?: string[],
  ): boolean {
    const { intentScore } = this.scoreJobIntent(jobTitles, jobDescriptions, customerKeywords, targetTitles);
    return intentScore >= 15;
  }
}
