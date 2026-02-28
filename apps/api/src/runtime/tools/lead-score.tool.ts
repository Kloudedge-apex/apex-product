import { Tool, ToolContext, ToolResult } from "./tool.interface";

export class LeadScoreTool implements Tool {
  name = "lead_score";
  description = "Score a lead against Ideal Customer Profile (ICP) criteria. Returns a numeric score (0-100), reasoning, and positive/negative signals.";
  parameters = {
    lead: {
      type: "object",
      description: "Lead data: {name, email, company, title, industry, company_size, ...}",
      required: true,
    },
    icp: {
      type: "object",
      description: "ICP criteria: {target_industries, target_company_sizes, target_titles, target_revenue, ...}",
      required: true,
    },
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const lead = params.lead as Record<string, unknown>;
    const icp = params.icp as Record<string, unknown>;

    if (!lead || !icp) {
      return { success: false, data: null, error: "lead and icp are required" };
    }

    const result = this.scoreLead(lead, icp);
    return { success: true, data: result };
  }

  private scoreLead(
    lead: Record<string, unknown>,
    icp: Record<string, unknown>,
  ): { score: number; reasoning: string; signals: string[] } {
    let score = 50; // Base score
    const signals: string[] = [];

    // Industry match (25 points)
    const targetIndustries = this.toStringArray(icp.target_industries || icp.industries);
    const leadIndustry = String(lead.industry || "").toLowerCase();
    if (targetIndustries.length > 0) {
      if (targetIndustries.some((ind) => leadIndustry.includes(ind.toLowerCase()))) {
        score += 25;
        signals.push(`+25: Industry match (${leadIndustry})`);
      } else {
        score -= 10;
        signals.push(`-10: Industry mismatch (${leadIndustry || "unknown"} vs ${targetIndustries.join(", ")})`);
      }
    }

    // Company size match (20 points)
    const targetSizes = this.toStringArray(icp.target_company_sizes || icp.company_sizes);
    const leadSize = String(lead.company_size || lead.size || "").toLowerCase();
    if (targetSizes.length > 0 && leadSize) {
      if (targetSizes.some((sz) => leadSize.includes(sz.toLowerCase()))) {
        score += 20;
        signals.push(`+20: Company size match (${leadSize})`);
      } else {
        score -= 5;
        signals.push(`-5: Company size mismatch (${leadSize})`);
      }
    }

    // Title/role match (20 points)
    const targetTitles = this.toStringArray(icp.target_titles || icp.titles);
    const leadTitle = String(lead.title || lead.role || "").toLowerCase();
    if (targetTitles.length > 0 && leadTitle) {
      if (targetTitles.some((t) => leadTitle.includes(t.toLowerCase()))) {
        score += 20;
        signals.push(`+20: Title match (${leadTitle})`);
      } else if (this.isSeniorTitle(leadTitle)) {
        score += 10;
        signals.push(`+10: Senior title (${leadTitle})`);
      }
    }

    // Has email (5 points)
    if (lead.email) {
      score += 5;
      signals.push("+5: Has email address");
    }

    // Company domain exists (5 points)
    if (lead.domain || lead.company_domain) {
      score += 5;
      signals.push("+5: Has company domain");
    }

    // Company research data bonus
    if (lead.recent_news || lead.funding) {
      score += 5;
      signals.push("+5: Has recent company data");
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    // Generate reasoning
    const reasoning = this.generateReasoning(score, signals, lead, icp);

    return { score, reasoning, signals };
  }

  private isSeniorTitle(title: string): boolean {
    const seniorPatterns = ["ceo", "cto", "cfo", "coo", "cmo", "vp", "vice president", "director", "head of", "chief", "founder", "partner", "svp", "evp"];
    return seniorPatterns.some((p) => title.includes(p));
  }

  private toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
  }

  private generateReasoning(
    score: number,
    signals: string[],
    lead: Record<string, unknown>,
    icp: Record<string, unknown>,
  ): string {
    if (score >= 80) {
      return `Strong ICP fit. ${lead.company || "The company"} in ${lead.industry || "their industry"} matches well with target criteria. Recommend prioritizing outreach.`;
    }
    if (score >= 60) {
      return `Moderate ICP fit. Some criteria match but gaps exist. Consider outreach with tailored messaging addressing specific pain points.`;
    }
    if (score >= 40) {
      return `Weak ICP fit. Limited alignment with target criteria. May not be worth prioritizing unless specific signals indicate high intent.`;
    }
    return `Poor ICP fit. Does not match key criteria. Recommend deprioritizing or skipping.`;
  }
}
