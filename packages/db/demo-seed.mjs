import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const orgId = "investor-demo";
const now = new Date();
const hoursAgo = (hours) => new Date(now.getTime() - hours * 60 * 60 * 1000);

async function main() {
  const failedDiagnosticRunId = "0fa45125-19fd-4bd9-8a00-5728ce58f1d4";
  await prisma.$transaction([
    prisma.graphCheckpointWrite.deleteMany({
      where: { threadId: failedDiagnosticRunId },
    }),
    prisma.graphCheckpoint.deleteMany({
      where: { threadId: failedDiagnosticRunId },
    }),
    prisma.evidenceEvent.deleteMany({
      where: { runId: failedDiagnosticRunId },
    }),
    prisma.graphRun.deleteMany({
      where: { id: failedDiagnosticRunId },
    }),
  ]);

  await prisma.org.upsert({
    where: { id: orgId },
    create: {
      id: orgId,
      name: "Northstar Labs",
      slug: "northstar-labs-investor-demo",
      website: "https://northstar-labs.example.com",
      physicalAddress: "100 Market Street, San Francisco, CA 94105",
      country: "US",
      senderName: "Maya from Northstar",
      plan: "GROWTH",
    },
    update: {
      name: "Northstar Labs",
      website: "https://northstar-labs.example.com",
      physicalAddress: "100 Market Street, San Francisco, CA 94105",
      country: "US",
      senderName: "Maya from Northstar",
      plan: "GROWTH",
    },
  });

  await prisma.user.upsert({
    where: { email: "synthetic@workforceos.example" },
    create: {
      id: "investor-demo-owner",
      orgId,
      email: "synthetic@workforceos.example",
      name: "Investor demo",
      role: "OWNER",
      clerkId: "investor-demo-user",
      membershipActive: true,
    },
    update: {
      orgId,
      name: "Investor demo",
      role: "OWNER",
      clerkId: "investor-demo-user",
      membershipActive: true,
    },
  });

  const existingIcp = await prisma.icpProfile.findFirst({ where: { orgId } });
  const icpData = {
    name: "B2B SaaS revenue teams",
    targetTitles: ["VP Sales", "Head of Revenue", "Revenue Operations"],
    targetIndustries: ["Software", "FinTech"],
    targetGeos: ["United States", "Canada"],
    minEmployees: 50,
    maxEmployees: 1000,
    techStackSignals: ["HubSpot", "Salesforce"],
    intentKeywords: ["sales automation", "AI SDR", "pipeline efficiency"],
    seedDomains: ["atlas-robotics.example", "harbor-finance.example"],
  };
  if (existingIcp) {
    await prisma.icpProfile.update({ where: { id: existingIcp.id }, data: icpData });
  } else {
    await prisma.icpProfile.create({
      data: { id: "investor-demo-icp", orgId, ...icpData },
    });
  }

  await prisma.integration.upsert({
    where: { orgId_provider: { orgId, provider: "gmail" } },
    create: {
      id: "investor-demo-gmail",
      orgId,
      provider: "gmail",
      credentials: {
        accountEmail: "maya@northstar-labs.example",
        watchExpiration: String(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        demo: true,
      },
      encryptedCredentials: "synthetic-demo-no-provider-token",
      status: "CONNECTED",
      scopes: ["gmail.readonly", "gmail.send"],
      lastSyncAt: now,
      lastHistoryId: "synthetic-history-1",
    },
    update: {
      credentials: {
        accountEmail: "maya@northstar-labs.example",
        watchExpiration: String(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        demo: true,
      },
      encryptedCredentials: "synthetic-demo-no-provider-token",
      status: "CONNECTED",
      scopes: ["gmail.readonly", "gmail.send"],
      lastSyncAt: now,
      lastHistoryId: "synthetic-history-1",
    },
  });

  const companies = [
    {
      id: "investor-demo-company-atlas",
      domain: "atlas-robotics.example",
      name: "Atlas Robotics",
      industry: "Industrial Software",
      employeeRange: "201-500",
      country: "US",
      city: "Austin",
      fundingStage: "Series B",
      techStack: ["Salesforce", "Outreach"],
      confidence: 0.94,
      intentScore: 88,
      intentSignals: ["Hiring SDRs", "New VP Sales"],
    },
    {
      id: "investor-demo-company-harbor",
      domain: "harbor-finance.example",
      name: "Harbor Finance",
      industry: "FinTech",
      employeeRange: "51-200",
      country: "US",
      city: "New York",
      fundingStage: "Series A",
      techStack: ["HubSpot", "Clay"],
      confidence: 0.9,
      intentScore: 79,
      intentSignals: ["Expanded revenue team", "CRM migration"],
    },
  ];

  for (const company of companies) {
    await prisma.company.upsert({
      where: { orgId_domain: { orgId, domain: company.domain } },
      create: { ...company, orgId },
      update: company,
    });
  }

  const people = [
    {
      id: "investor-demo-person-elena",
      companyId: "investor-demo-company-atlas",
      firstName: "Elena",
      lastName: "Park",
      title: "VP of Sales",
      seniority: "VP",
      department: "SALES",
      location: "Austin, TX",
      email: "elena@atlas-robotics.example",
      score: 92,
    },
    {
      id: "investor-demo-person-daniel",
      companyId: "investor-demo-company-harbor",
      firstName: "Daniel",
      lastName: "Ortiz",
      title: "Head of Revenue Operations",
      seniority: "DIRECTOR",
      department: "OPERATIONS",
      location: "New York, NY",
      email: "daniel@harbor-finance.example",
      score: 84,
    },
  ];

  for (const person of people) {
    await prisma.person.upsert({
      where: { id: person.id },
      create: {
        id: person.id,
        companyId: person.companyId,
        firstName: person.firstName,
        lastName: person.lastName,
        title: person.title,
        seniority: person.seniority,
        department: person.department,
        location: person.location,
      },
      update: {
        companyId: person.companyId,
        title: person.title,
        seniority: person.seniority,
        department: person.department,
        location: person.location,
      },
    });
    await prisma.emailCandidate.upsert({
      where: { personId_email: { personId: person.id, email: person.email } },
      create: {
        personId: person.id,
        email: person.email,
        source: "PATTERN_GUESS",
        verified: true,
        verificationResult: "VALID",
        confidence: 0.97,
        verifiedAt: now,
      },
      update: {
        verified: true,
        verificationResult: "VALID",
        confidence: 0.97,
        verifiedAt: now,
      },
    });
    await prisma.leadScore.upsert({
      where: { orgId_personId: { orgId, personId: person.id } },
      create: {
        orgId,
        personId: person.id,
        score: person.score,
        breakdown: { fit: 40, intent: 30, timing: 22 },
        qualifiedAt: now,
      },
      update: {
        score: person.score,
        breakdown: { fit: 40, intent: 30, timing: 22 },
        qualifiedAt: now,
      },
    });
  }

  await prisma.graphRun.upsert({
    where: { id: "investor-demo-run-1" },
    create: {
      id: "investor-demo-run-1",
      orgId,
      threadId: "investor-demo-thread-1",
      graphName: "pipeline-supervisor",
      status: "COMPLETED",
      currentNode: "complete",
      state: {
        stagesCompleted: ["research", "scoring", "drafting", "review"],
        counts: { companies: 2, people: 2, scored: 2, outreach: 2 },
        approvedBy: "investor-demo-user",
      },
      approvedAt: hoursAgo(2),
      approvedBy: "investor-demo-user",
      startedAt: hoursAgo(4),
      lastActivityAt: hoursAgo(2),
      completedAt: hoursAgo(2),
    },
    update: {},
  });

  const drafts = [
    {
      id: "investor-demo-artifact-elena",
      recipientRef: "elena@atlas-robotics.example",
      name: "Elena Park",
      title: "VP of Sales",
      company: "Atlas Robotics",
      subject: "Atlas Robotics' next SDR hiring wave",
      body: "Hi Elena,\n\nI noticed Atlas Robotics is expanding its SDR team after bringing in a new sales leader. Workforce OS can research the account, score likely buyers, and prepare grounded outreach for human approval in one guarded workflow.\n\nWould a short walkthrough next week be useful?\n\nMaya",
      status: "PENDING_REVIEW",
    },
    {
      id: "investor-demo-artifact-daniel",
      recipientRef: "daniel@harbor-finance.example",
      name: "Daniel Ortiz",
      title: "Head of Revenue Operations",
      company: "Harbor Finance",
      subject: "A guarded way to scale Harbor's outbound",
      body: "Hi Daniel,\n\nHarbor Finance's revenue-team expansion and CRM migration suggest the team is tightening its operating motion. Workforce OS turns those signals into scored accounts and reviewable outreach while keeping every external action behind policy gates.\n\nOpen to comparing notes for 15 minutes?\n\nMaya",
      status: "SIMULATED",
    },
  ];

  for (const draft of drafts) {
    await prisma.outreachArtifact.upsert({
      where: { id: draft.id },
      create: {
        id: draft.id,
        orgId,
        graphRunId: "investor-demo-run-1",
        toolName: "send_email",
        channel: "EMAIL",
        recipientRef: draft.recipientRef,
        subject: draft.subject,
        bodyText: draft.body,
        payload: {
          to: draft.recipientRef,
          subject: draft.subject,
          body: draft.body,
          bodyContentType: "text",
          name: draft.name,
          title: draft.title,
          company: draft.company,
          cohort: "A",
          qaIssues: [],
          brief_facts: [
            {
              id: `${draft.id}-signal`,
              category: "signal",
              source: "Synthetic investor-demo research",
              text: `${draft.company} showed a recent revenue-operations signal.`,
              date: now.toISOString().slice(0, 10),
            },
          ],
          groundedness_self_check: {
            citedFactIds: [`${draft.id}-signal`],
            unsupportedClaims: [],
          },
        },
        status: draft.status,
        reviewerNote:
          draft.status === "SIMULATED"
            ? "Synthetic demo dispatch; no provider was called."
            : null,
        reviewedBy: draft.status === "SIMULATED" ? "investor-demo-user" : null,
        reviewedAt: draft.status === "SIMULATED" ? hoursAgo(2) : null,
        sendReceiptId: draft.status === "SIMULATED" ? "mock_investor_demo" : null,
      },
      update: {},
    });
  }

  await prisma.conversation.upsert({
    where: {
      integrationId_providerThreadId: {
        integrationId: "investor-demo-gmail",
        providerThreadId: "synthetic-thread-elena",
      },
    },
    create: {
      id: "investor-demo-conversation-elena",
      orgId,
      integrationId: "investor-demo-gmail",
      providerThreadId: "synthetic-thread-elena",
      personId: "investor-demo-person-elena",
      contactEmail: "elena@atlas-robotics.example",
      contactName: "Elena Park",
      subject: "Re: Atlas Robotics' next SDR hiring wave",
      lastMessagePreview:
        "This is timely. Can you show how approvals and CRM handoff work?",
      lastMessageAt: hoursAgo(1),
      lastInboundAt: hoursAgo(1),
      lastOutboundAt: hoursAgo(3),
      unreadCount: 1,
      needsReply: true,
      sentiment: "POSITIVE",
      sentimentConfidence: 0.93,
      nextBestAction:
        "Offer a 20-minute walkthrough focused on approval controls and CRM handoff.",
      nextBestActionType: "QUALIFY",
      intelligenceStatus: "READY",
      intelligenceUpdatedAt: now,
    },
    update: {
      lastMessagePreview:
        "This is timely. Can you show how approvals and CRM handoff work?",
      lastMessageAt: hoursAgo(1),
      lastInboundAt: hoursAgo(1),
      unreadCount: 1,
      needsReply: true,
      sentiment: "POSITIVE",
      sentimentConfidence: 0.93,
      nextBestAction:
        "Offer a 20-minute walkthrough focused on approval controls and CRM handoff.",
      nextBestActionType: "QUALIFY",
      intelligenceStatus: "READY",
      intelligenceUpdatedAt: now,
    },
  });

  const messages = [
    {
      id: "investor-demo-message-outbound",
      direction: "OUTBOUND",
      providerMessageId: "synthetic-message-outbound",
      senderEmail: "maya@northstar-labs.example",
      senderName: "Maya from Northstar",
      toEmails: ["elena@atlas-robotics.example"],
      subject: "Atlas Robotics' next SDR hiring wave",
      bodyText:
        "Hi Elena, I noticed Atlas Robotics is expanding its SDR team. Would a short walkthrough next week be useful?",
      sentAt: hoursAgo(3),
      readAt: hoursAgo(2),
    },
    {
      id: "investor-demo-message-inbound",
      direction: "INBOUND",
      providerMessageId: "synthetic-message-inbound",
      senderEmail: "elena@atlas-robotics.example",
      senderName: "Elena Park",
      toEmails: ["maya@northstar-labs.example"],
      subject: "Re: Atlas Robotics' next SDR hiring wave",
      bodyText:
        "This is timely. Can you show how approvals and CRM handoff work? I can do Thursday afternoon.",
      sentAt: hoursAgo(1),
      readAt: null,
    },
  ];

  for (const message of messages) {
    await prisma.conversationMessage.upsert({
      where: {
        conversationId_providerMessageId: {
          conversationId: "investor-demo-conversation-elena",
          providerMessageId: message.providerMessageId,
        },
      },
      create: {
        ...message,
        orgId,
        conversationId: "investor-demo-conversation-elena",
        ccEmails: [],
      },
      update: {
        bodyText: message.bodyText,
        sentAt: message.sentAt,
        readAt: message.readAt,
      },
    });
  }

  await prisma.meetingLedger.upsert({
    where: { id: "investor-demo-meeting-elena" },
    create: {
      id: "investor-demo-meeting-elena",
      orgId,
      conversationId: "investor-demo-conversation-elena",
      sourceMessageId: "investor-demo-message-inbound",
      personId: "investor-demo-person-elena",
      title: "Workforce OS approval-control walkthrough",
      description: "Synthetic investor-demo meeting proposed from a positive reply.",
      scheduledFor: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
      durationMinutes: 20,
      attendeeEmails: [
        "elena@atlas-robotics.example",
        "maya@northstar-labs.example",
      ],
      notes: "Focus on human approval, CRM handoff, and evidence trails.",
      status: "PROPOSED",
      source: "AGENT_PROPOSED",
      createdBy: "agent",
    },
    update: {},
  });
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Demo seed failed");
    await prisma.$disconnect();
    process.exit(1);
  });
