#!/usr/bin/env tsx
/**
 * End-to-end dry-run smoke test for the Phase 2.5 tenant-zero pipeline.
 *
 *   pnpm tsx apps/api/scripts/smoke-tenant-zero-pipeline.ts --org-id <orgId>
 *
 * What it exercises (against the real Postgres):
 *   1. Seeds an ICP + Company + Person + EmailCandidate + LeadScore for the
 *      given org under a `smoke_` prefix so re-runs are safe.
 *   2. Builds the real pipeline-supervisor graph with the PrismaCheckpointSaver.
 *   3. Mocks the side-effecting deps (LLM, sourcing/enrichment/scoring stages,
 *      runtime.triggerRun) so we don't touch external APIs or burn LLM tokens.
 *   4. Invokes the graph, asserts it pauses at AWAITING_APPROVAL.
 *   5. Resumes with approved=true, asserts the SDR subgraph runs.
 *   6. Asserts ≥1 OutreachArtifact in PENDING_REVIEW and 0 invocations of
 *      runtime.triggerRun (the autonomous-send vector).
 *   7. Inserts a MeetingLedger row to confirm the ledger table is wired.
 *   8. Cleans up all rows it created unless `--keep` is passed.
 *
 * Exit codes: 0 on PASS, 1 on FAIL.
 *
 * Required env: DATABASE_URL.
 */
import { PrismaClient } from "@prisma/client";
import { Command, isInterrupted } from "@langchain/langgraph";
import { buildPipelineGraph } from "../src/graph/pipeline-graph";
import { PrismaCheckpointSaver } from "../src/graph/prisma-checkpointer";
import { OutreachArtifactsService } from "../src/outreach/outreach-artifacts.service";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { LeadsService } from "../src/leads/leads.service";
import type { RuntimeService } from "../src/runtime/runtime.service";
import type { LLMService } from "../src/runtime/llm.service";

interface Args {
  orgId: string;
  keep: boolean;
}

const SMOKE_PREFIX = "smoke_tenant_zero";
const FIXTURE_DOMAIN = `${SMOKE_PREFIX}.example`;

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let orgId: string | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--org-id") orgId = argv[++i];
    else if (a === "--keep") keep = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (!orgId) {
    console.error("--org-id <orgId> is required");
    printUsage();
    process.exit(2);
  }
  return { orgId, keep };
}

function printUsage(): void {
  console.error("Usage: smoke-tenant-zero-pipeline --org-id <orgId> [--keep]");
}

interface SmokeContext {
  orgId: string;
  icpProfileId: string;
  companyId: string;
  personId: string;
  leadScoreId: string;
}

interface Counters {
  llmCalls: number;
  triggerRunCalls: number;
  artifactsCreated: number;
}

const PASS = "✓";
const FAIL = "✗";

async function main(): Promise<void> {
  const args = parseArgs();
  const prisma = new PrismaClient();
  const counters: Counters = { llmCalls: 0, triggerRunCalls: 0, artifactsCreated: 0 };
  const failures: string[] = [];
  let ctx: SmokeContext | null = null;
  let runId: string | null = null;
  let meetingId: string | null = null;

  try {
    log("setup", `Verifying org ${args.orgId} exists…`);
    const org = await prisma.org.findUnique({ where: { id: args.orgId } });
    if (!org) throw new Error(`Org ${args.orgId} not found`);

    log("setup", "Seeding fixtures…");
    ctx = await seedFixtures(prisma, args.orgId);
    log("setup", `  org=${ctx.orgId} icp=${ctx.icpProfileId} company=${ctx.companyId} person=${ctx.personId}`);

    log("graph", "Building pipeline graph with mocked side-effect deps…");
    const prismaService = prisma as unknown as PrismaService;
    const artifactsService = new OutreachArtifactsService(prismaService);
    const checkpointer = new PrismaCheckpointSaver(prismaService);

    const leadsStub: LeadsService = {
      runSourcingStage: async () => ({ companies: 1, people: 1 }),
      runEnrichmentStage: async () => ({ merged: 0, enriched: 1 }),
      runScoringStage: async () => ({ scored: 1 }),
    } as unknown as LeadsService;

    const runtimeStub: RuntimeService = {
      triggerRun: async (_agentId: string) => {
        counters.triggerRunCalls += 1;
        return { id: "should-never-be-called" };
      },
    } as unknown as RuntimeService;

    const llmStub: LLMService = {
      chat: async () => {
        counters.llmCalls += 1;
        return {
          content: JSON.stringify({
            subject: "Exploring a quick chat about your SDR pipeline",
            body:
              "Hi Alice, noticed Acme Smoke Inc operates in the 50-200 employee range across SaaS. Curious how you handle SDR throughput at that headcount — happy to share a 15-min walkthrough of what's worked for similar teams. Worth a chat next week?",
          }),
          tokensUsed: 0,
          model: "mock",
          cost: 0,
        };
      },
    } as unknown as LLMService;

    const graph = buildPipelineGraph({
      leads: leadsStub,
      prisma: prismaService,
      runtime: runtimeStub,
      llm: llmStub,
      outreachArtifacts: artifactsService,
    }).compile({ checkpointer });

    runId = await createGraphRun(prisma, args.orgId);
    log("graph", `Created GraphRun ${runId}; invoking…`);

    const config = { configurable: { thread_id: runId } };
    const firstResult = await graph.invoke(
      { orgId: args.orgId, runId, icpProfileIds: [ctx.icpProfileId] },
      config,
    );

    if (!isInterrupted(firstResult)) {
      failures.push("graph did not interrupt for human approval");
    } else {
      log("graph", `${PASS} graph paused at human_approval`);
    }

    log("graph", "Resuming with approved=true…");
    const resumedResult = await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "smoke@apex.local" } }),
      config,
    );

    if (resumedResult?.approved !== true) {
      failures.push("post-resume state did not record approval");
    }

    log("verify", "Checking artifacts and side-effect counters…");
    const artifacts = await prisma.outreachArtifact.findMany({
      where: { orgId: args.orgId, graphRunId: runId },
      orderBy: { createdAt: "asc" },
    });
    counters.artifactsCreated = artifacts.length;

    if (artifacts.length === 0) {
      failures.push("no OutreachArtifact rows produced");
    } else {
      log("verify", `${PASS} ${artifacts.length} OutreachArtifact row(s) created`);
      const nonPending = artifacts.filter((a) => a.status !== "PENDING_REVIEW");
      if (nonPending.length > 0) {
        failures.push(
          `artifacts must all be PENDING_REVIEW (found ${nonPending.length} other)`,
        );
      } else {
        log("verify", `${PASS} all artifacts in PENDING_REVIEW`);
      }
      const sent = artifacts.filter((a) => a.sentAt !== null || a.sendReceiptId !== null);
      if (sent.length > 0) {
        failures.push(
          `${sent.length} artifact(s) carry sentAt/sendReceiptId — should be null in dry-run`,
        );
      }
    }

    if (counters.triggerRunCalls > 0) {
      failures.push(
        `runtime.triggerRun was invoked ${counters.triggerRunCalls} time(s) — autonomous-send path must be unreachable`,
      );
    } else {
      log("verify", `${PASS} runtime.triggerRun never invoked`);
    }

    log("meetings", "Inserting MeetingLedger row to verify ledger is wired…");
    const meeting = await prisma.meetingLedger.create({
      data: {
        orgId: args.orgId,
        title: `${SMOKE_PREFIX} verification meeting`,
        scheduledFor: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
        attendeeEmails: [`alice@${FIXTURE_DOMAIN}`],
        source: "AGENT_PROPOSED",
        createdBy: "smoke",
        outreachArtifactId: artifacts[0]?.id ?? null,
      },
    });
    meetingId = meeting.id;
    log("meetings", `${PASS} MeetingLedger ${meetingId} created (status=${meeting.status})`);

    log("summary", "──────────────────────────────────────────────");
    log("summary", `LLM calls:          ${counters.llmCalls}`);
    log("summary", `triggerRun calls:   ${counters.triggerRunCalls}  (must be 0)`);
    log("summary", `Artifacts created:  ${counters.artifactsCreated}`);
    log("summary", `Meeting created:    ${meetingId ? "yes" : "no"}`);
    log("summary", "──────────────────────────────────────────────");
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    if (!args.keep) {
      log("cleanup", "Removing smoke fixtures…");
      try {
        await cleanup(prisma, args.orgId, ctx, runId, meetingId);
      } catch (cleanupErr) {
        log("cleanup", `(non-fatal) cleanup failed: ${String(cleanupErr)}`);
      }
    } else {
      log("cleanup", "--keep set; leaving rows in place");
    }
    await prisma.$disconnect();
  }

  if (failures.length === 0) {
    console.log(`\n${PASS} SMOKE PASS — tenant-zero pipeline holds the dry-run invariants.`);
    process.exit(0);
  }
  console.error(`\n${FAIL} SMOKE FAIL`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

async function seedFixtures(
  prisma: PrismaClient,
  orgId: string,
): Promise<SmokeContext> {
  await purgeFixtures(prisma, orgId);

  const icp = await prisma.icpProfile.create({
    data: {
      orgId,
      name: `${SMOKE_PREFIX}_icp`,
      targetTitles: ["VP Sales"],
      targetIndustries: ["SaaS"],
      targetGeos: ["US"],
      minEmployees: 50,
      maxEmployees: 200,
      techStackSignals: [],
      intentKeywords: [],
      seedDomains: [],
    },
  });

  const company = await prisma.company.create({
    data: {
      orgId,
      domain: FIXTURE_DOMAIN,
      name: "Acme Smoke Inc",
      industry: "SaaS",
      employeeRange: "50-200",
      country: "US",
    },
  });

  const person = await prisma.person.create({
    data: {
      companyId: company.id,
      firstName: "Alice",
      lastName: "Smoke",
      title: "VP Sales",
      emails: {
        create: {
          email: `alice@${FIXTURE_DOMAIN}`,
          source: "PATTERN_GUESS",
          confidence: 0.9,
        },
      },
    },
  });

  const score = await prisma.leadScore.create({
    data: {
      orgId,
      personId: person.id,
      score: 90,
      breakdown: { reason: "smoke fixture — top tier" },
      qualifiedAt: new Date(),
    },
  });

  return {
    orgId,
    icpProfileId: icp.id,
    companyId: company.id,
    personId: person.id,
    leadScoreId: score.id,
  };
}

async function purgeFixtures(prisma: PrismaClient, orgId: string): Promise<void> {
  await prisma.meetingLedger.deleteMany({
    where: {
      orgId,
      title: { startsWith: SMOKE_PREFIX },
    },
  });
  await prisma.outreachArtifact.deleteMany({
    where: {
      orgId,
      recipientRef: { contains: FIXTURE_DOMAIN },
    },
  });
  await prisma.leadScore.deleteMany({
    where: { orgId, person: { company: { domain: FIXTURE_DOMAIN } } },
  });
  await prisma.emailCandidate.deleteMany({
    where: { person: { company: { domain: FIXTURE_DOMAIN } } },
  });
  await prisma.person.deleteMany({
    where: { company: { domain: FIXTURE_DOMAIN } },
  });
  await prisma.company.deleteMany({
    where: { orgId, domain: FIXTURE_DOMAIN },
  });
  await prisma.icpProfile.deleteMany({
    where: { orgId, name: `${SMOKE_PREFIX}_icp` },
  });
}

async function createGraphRun(prisma: PrismaClient, orgId: string): Promise<string> {
  const run = await prisma.graphRun.create({
    data: {
      orgId,
      threadId: "",
      graphName: "pipeline-supervisor",
      status: "RUNNING",
      currentNode: "supervisor",
    },
  });
  await prisma.graphRun.update({
    where: { id: run.id },
    data: { threadId: run.id },
  });
  return run.id;
}

async function cleanup(
  prisma: PrismaClient,
  orgId: string,
  ctx: SmokeContext | null,
  runId: string | null,
  meetingId: string | null,
): Promise<void> {
  if (meetingId) {
    await prisma.meetingLedger.deleteMany({ where: { id: meetingId } });
  }
  if (runId) {
    await prisma.outreachArtifact.deleteMany({ where: { graphRunId: runId } });
    // Checkpoint write rows reference the parent GraphCheckpoint by composite
    // key; clear them before the parent. threadId on both equals runId.
    await prisma.graphCheckpointWrite.deleteMany({ where: { threadId: runId } });
    await prisma.graphCheckpoint.deleteMany({ where: { threadId: runId } });
    await prisma.graphRun.deleteMany({ where: { id: runId } });
  }
  if (ctx) {
    await purgeFixtures(prisma, orgId);
  }
}

function log(stage: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${stage.padEnd(8)} ${msg}`);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
