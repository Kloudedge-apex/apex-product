import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const templates = [
  // Sales
  {
    domain: "SALES" as const,
    name: "SDR Agent",
    description:
      "Autonomous Sales Development Representative that researches leads, scores them against your Ideal Customer Profile, crafts hyper-personalized cold outreach emails, and manages multi-step follow-up sequences.",
    defaultConfig: {
      maxIterations: 15,
      timeoutMs: 120_000,
      model: "gpt-4o",
      icpCriteria: {
        industries: ["SaaS", "Fintech"],
        employeeRange: "50-500",
        revenueRange: "$5M-$100M",
        titles: ["CTO", "VP Engineering", "Head of IT"],
        locations: ["US", "UK", "EU"],
      },
      emailTone: "professional",
      followUpCadenceDays: [1, 3, 5, 7],
      dailyEmailLimit: 50,
      personalizationDepth: "deep",
      autoApproveEmails: false,
    },
    requiredIntegrations: ["email", "crm"],
  },
  {
    domain: "SALES" as const,
    name: "Reply Handler",
    description:
      "Detects prospect replies to outbound campaigns, classifies intent (interested, not now, unsubscribe, objection), and drafts contextual follow-up responses.",
    defaultConfig: {
      maxIterations: 10,
      timeoutMs: 60_000,
      model: "gpt-4o",
      responseSlaMinutes: 60,
      autoSendInterested: false,
      autoHonorUnsubscribe: true,
      escalationThreshold: 50_000,
      followUpDelayDays: { not_now: 14, out_of_office: 3, question: 2 },
    },
    requiredIntegrations: ["email", "crm"],
  },
  // Marketing
  {
    domain: "MARKETING" as const,
    name: "Content Writer",
    description:
      "Generates LinkedIn posts, X/Twitter threads, and blog drafts on a configurable schedule. Maintains brand voice consistency and publishes content that drives engagement.",
    defaultConfig: {
      maxIterations: 10,
      timeoutMs: 90_000,
      model: "gpt-4o",
      platforms: ["linkedin", "x"],
      postingSchedule: { linkedin: "daily", x: "3x_daily", blog: "weekly" },
      brandVoice: "professional yet approachable",
      contentPillars: ["industry insights", "product updates", "thought leadership"],
      autoPublish: false,
      maxPostsPerDay: 3,
    },
    requiredIntegrations: ["social"],
  },
  {
    domain: "MARKETING" as const,
    name: "SEO Agent",
    description:
      "Performs keyword research, generates content briefs, optimizes meta tags, and runs competitor analysis to improve organic search visibility.",
    defaultConfig: {
      maxIterations: 12,
      timeoutMs: 120_000,
      model: "gpt-4o",
      targetKeywordDifficulty: 40,
      minSearchVolume: 100,
      maxSearchVolume: 10_000,
      competitorDomains: [],
      contentPillars: [],
      targetLocale: "en-US",
    },
    requiredIntegrations: ["social"],
  },
  // Ops
  {
    domain: "OPS" as const,
    name: "Inbox Monitor",
    description:
      "Intelligent email triage agent that categorizes incoming messages by urgency and type, auto-routes to the right team member, and drafts replies for urgent items.",
    defaultConfig: {
      maxIterations: 12,
      timeoutMs: 60_000,
      model: "gpt-4o",
      categories: ["urgent", "sales_inquiry", "support", "newsletter", "internal"],
      autoDraftReplies: true,
      routingRules: { sales_inquiry: "sales_team", support: "support_team", urgent: "owner" },
      checkFrequency: "5min",
      autoArchiveNewsletters: true,
    },
    requiredIntegrations: ["email"],
  },
  {
    domain: "OPS" as const,
    name: "Reporting Agent",
    description:
      "Generates daily and weekly KPI dashboards, detects anomalies in your metrics, performs trend analysis, and delivers executive summaries.",
    defaultConfig: {
      maxIterations: 10,
      timeoutMs: 90_000,
      model: "gpt-4o",
      reportFrequency: "daily",
      deliveryChannel: "email",
      kpis: ["revenue", "pipeline_value", "emails_sent", "meetings_booked", "response_rate"],
      anomalyDetection: true,
      anomalyThresholdPercent: 20,
      includeRecommendations: true,
      reportTime: "08:00",
    },
    requiredIntegrations: ["crm"],
  },
];

async function main() {
  console.log("Seeding agent templates...");

  for (const template of templates) {
    const existing = await prisma.agentTemplate.findFirst({
      where: { name: template.name, domain: template.domain },
    });

    if (existing) {
      await prisma.agentTemplate.update({
        where: { id: existing.id },
        data: {
          description: template.description,
          defaultConfig: template.defaultConfig as any,
          requiredIntegrations: template.requiredIntegrations,
        },
      });
      console.log(`  Updated: ${template.name} (${template.domain})`);
    } else {
      await prisma.agentTemplate.create({
        data: {
          domain: template.domain,
          name: template.name,
          description: template.description,
          defaultConfig: template.defaultConfig as any,
          requiredIntegrations: template.requiredIntegrations,
        },
      });
      console.log(`  Created: ${template.name} (${template.domain})`);
    }
  }

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
