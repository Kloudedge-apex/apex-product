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
      breakdown: { fit: 100, intent: 88, engagement: 80, timing: 88 },
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
      score: 89,
      breakdown: { fit: 100, intent: 79, engagement: 80, timing: 79 },
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
        breakdown: person.breakdown,
        qualifiedAt: now,
      },
      update: {
        score: person.score,
        breakdown: person.breakdown,
        qualifiedAt: now,
      },
    });
  }

  const evidenceEvents = [
    {
      id: "investor-demo-evidence-atlas-hiring",
      kind: "recent_hire",
      refId: "investor-demo-company-atlas",
      payload: {
        kind: "recent_hire",
        source: "https://atlas-robotics.example/careers/account-executive",
        date: hoursAgo(48).toISOString(),
        confidence: 0.94,
        jobTitle: "Account Executive",
        summary: "Atlas Robotics is hiring account executives as it expands its sales team.",
      },
      createdAt: hoursAgo(48),
    },
    {
      id: "investor-demo-evidence-atlas-leadership",
      kind: "leadership_change",
      refId: "investor-demo-company-atlas",
      payload: {
        kind: "leadership_change",
        source: "https://atlas-robotics.example/news/new-vp-sales",
        date: hoursAgo(96).toISOString(),
        confidence: 0.91,
        name: "Elena Park",
        role: "VP of Sales",
        summary: "Atlas Robotics appointed Elena Park as VP of Sales.",
      },
      createdAt: hoursAgo(96),
    },
    {
      id: "investor-demo-evidence-harbor-hiring",
      kind: "recent_hire",
      refId: "investor-demo-company-harbor",
      payload: {
        kind: "recent_hire",
        source: "https://harbor-finance.example/careers/revenue-systems-manager",
        date: hoursAgo(24).toISOString(),
        confidence: 0.9,
        jobTitle: "Revenue Systems Manager",
        summary: "Harbor Finance is hiring a revenue systems manager during its CRM migration.",
      },
      createdAt: hoursAgo(24),
    },
    {
      id: "investor-demo-evidence-harbor-funding",
      kind: "funding_event",
      refId: "investor-demo-company-harbor",
      payload: {
        kind: "funding_event",
        source: "https://harbor-finance.example/news/series-a",
        date: hoursAgo(240).toISOString(),
        confidence: 0.88,
        amount: "$18M",
        round: "Series A",
        summary: "Harbor Finance announced an $18M Series A to expand its go-to-market team.",
      },
      createdAt: hoursAgo(240),
    },
  ];

  for (const event of evidenceEvents) {
    await prisma.evidenceEvent.upsert({
      where: { id: event.id },
      create: {
        ...event,
        orgId,
        runId: "investor-demo-run-1",
        refType: "company",
      },
      update: {
        kind: event.kind,
        refId: event.refId,
        payload: event.payload,
        createdAt: event.createdAt,
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
