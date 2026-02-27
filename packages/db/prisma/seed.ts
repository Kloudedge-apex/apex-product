import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const templates = [
  // Sales
  {
    domain: "SALES" as const,
    name: "SDR Agent",
    description:
      "Researches leads, scores them against your ICP criteria, writes personalized outreach emails, and follows up on schedule. Your autonomous sales development rep.",
    defaultConfig: {
      icp_criteria: {
        industries: ["SaaS", "Fintech"],
        employee_range: "50-500",
        revenue_range: "$5M-$100M",
        titles: ["CTO", "VP Engineering", "Head of IT"],
        locations: ["US", "UK", "EU"],
      },
      email_tone: "professional",
      follow_up_cadence: [1, 3, 5, 7],
      daily_email_limit: 50,
      personalization_depth: "deep",
      auto_approve_emails: false,
    },
    requiredIntegrations: ["email", "crm"],
  },
  {
    domain: "SALES" as const,
    name: "CRM Sync Agent",
    description:
      "Monitors your email and calendar, automatically logs interactions to your CRM, updates deal stages, and keeps your pipeline data clean and current.",
    defaultConfig: {
      sync_frequency: "realtime",
      auto_create_contacts: true,
      auto_update_deals: true,
      log_emails: true,
      log_meetings: true,
      deal_stage_rules: {
        first_reply: "Qualified",
        meeting_booked: "Discovery",
        proposal_sent: "Proposal",
      },
    },
    requiredIntegrations: ["email", "crm"],
  },
  // Marketing
  {
    domain: "MARKETING" as const,
    name: "Content Writer",
    description:
      "Generates LinkedIn posts, X threads, and blog articles on a schedule. Maintains your brand voice and publishes content that drives engagement and inbound leads.",
    defaultConfig: {
      platforms: ["linkedin", "x"],
      posting_schedule: {
        linkedin: "daily",
        x: "3x_daily",
        blog: "weekly",
      },
      brand_voice: "professional yet approachable",
      content_pillars: ["industry insights", "product updates", "thought leadership"],
      auto_publish: false,
      max_posts_per_day: 3,
    },
    requiredIntegrations: ["social"],
  },
  {
    domain: "MARKETING" as const,
    name: "Social Engagement Agent",
    description:
      "Monitors mentions and comments across social platforms. Drafts contextual replies, engages with prospect posts, and grows your social presence organically.",
    defaultConfig: {
      platforms: ["linkedin", "x"],
      monitor_keywords: [],
      monitor_competitors: [],
      reply_tone: "helpful and knowledgeable",
      max_engagements_per_day: 20,
      auto_reply: false,
      engagement_types: ["comments", "mentions", "dms"],
    },
    requiredIntegrations: ["social"],
  },
  // Ops
  {
    domain: "OPS" as const,
    name: "Inbox Monitor",
    description:
      "Triages incoming emails, categorizes by urgency and type, routes to the right team member, and drafts responses for common queries. Your intelligent email manager.",
    defaultConfig: {
      categories: ["urgent", "sales_inquiry", "support", "newsletter", "internal"],
      auto_draft_replies: true,
      routing_rules: {
        sales_inquiry: "sales_team",
        support: "support_team",
        urgent: "owner",
      },
      check_frequency: "5min",
      auto_archive_newsletters: true,
    },
    requiredIntegrations: ["email"],
  },
  {
    domain: "OPS" as const,
    name: "Reporting Agent",
    description:
      "Pulls data from your connected tools, generates daily and weekly KPI dashboards, spots anomalies, and delivers executive summaries to your inbox or Slack.",
    defaultConfig: {
      report_frequency: "daily",
      delivery_channel: "email",
      kpis: ["revenue", "pipeline_value", "emails_sent", "meetings_booked", "response_rate"],
      anomaly_detection: true,
      anomaly_threshold: 20,
      include_recommendations: true,
      report_time: "08:00",
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
