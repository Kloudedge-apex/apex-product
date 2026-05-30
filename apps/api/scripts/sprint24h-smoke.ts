#!/usr/bin/env -S tsx --tsconfig apps/api/tsconfig.json
/**
 * Sprint 24h WS-10 smoke script.
 *
 * Offline by design: mocks Gmail + LLM + outbound dispatch; writes only to Postgres.
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx apps/api/scripts/sprint24h-smoke.ts --org-id <orgId>
 *
 * Exit codes: 0 on all PASS, 1 on any FAIL.
 */
import { PrismaClient, EvaluatorTargetType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SendOutreachWorker } from "../src/outreach/send-outreach.worker";
import { EvidenceLedgerService } from "../src/observability/evidence-ledger.service";
import { SuppressionService } from "../src/suppression/suppression.service";
import { LangSmithService } from "../src/observability/langsmith.service";
import { LlmFactService } from "../src/observability/llm-fact/llm-fact.service";
import { GmailService } from "../src/integrations/gmail/gmail.service";
import { ReplyClassifierService } from "../src/inbox/reply-classifier/reply-classifier.service";
import { EnrichmentFactService } from "../src/enrichment/enrichment-fact.service";
import { WebSearchTool } from "../src/runtime/tools/web-search.tool";
import { UsageService } from "../src/usage/usage.service";
import { EvaluatorFactService } from "../src/observability/evaluator-fact/evaluator-fact.service";
import { EvaluatorRunnerService } from "../src/observability/evaluators/evaluator-runner.service";
import { PiiLeakageEvaluator } from "../src/observability/evaluators/pii-leakage.evaluator";
import { PromptInjectionEvaluator } from "../src/observability/evaluators/prompt-injection.evaluator";
import { ToxicityEvaluator } from "../src/observability/evaluators/toxicity.evaluator";
import { BiasFairnessEvaluator } from "../src/observability/evaluators/bias-fairness.evaluator";
import { HallucinationEvaluator } from "../src/observability/evaluators/hallucination.evaluator";
import { CorrectnessEvaluator } from "../src/observability/evaluators/correctness.evaluator";
import { ToolUseCorrectnessEvaluator } from "../src/observability/evaluators/tool-use-correctness.evaluator";
import { BoilerplateEvaluator } from "../src/observability/evaluators/boilerplate.evaluator";
import { AiTellEvaluator } from "../src/observability/evaluators/ai-tell.evaluator";
import { CitationCoverageEvaluator } from "../src/observability/evaluators/citation-coverage.evaluator";

type Step = {
  readonly name: string;
  readonly run: () => Promise<void>;
};

function usage(): void {
  // eslint-disable-next-line no-console
  console.error("Usage: sprint24h-smoke [--org-id <orgId>]");
}

function parseArgs(): { readonly orgId: string | null; readonly orgIdProvided: boolean } {
  const argv = process.argv.slice(2);
  let orgId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--org-id") orgId = argv[++i];
    else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    }
  }

  const envOrgId = process.env.APEX_TENANT_ZERO_ORG_ID;
  const resolved = orgId ?? envOrgId ?? null;
  return { orgId: resolved, orgIdProvided: Boolean(orgId ?? envOrgId) };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function startOfUtcHour(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0));
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const runTag = `sprint24h_smoke_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const parsed = parseArgs();
  const args = {
    orgId: parsed.orgId ?? `org_smoke_${runTag.slice(0, 24)}`,
    orgIdProvided: parsed.orgIdProvided,
  };

  const prisma = new PrismaClient();
  const prismaService = prisma as any;

  const evidenceLedger = new EvidenceLedgerService(prismaService);
  const suppressionService = new SuppressionService(prismaService, evidenceLedger as any);

  const llmFacts = new LlmFactService(prismaService, evidenceLedger as any);
  const langsmith = new LangSmithService(llmFacts as any);

  // Reused across steps
  let outboundArtifactId: string | null = null;
  let outboundRfcMessageId: string | null = null;
  let outboundThreadId: string | null = null;
  let outboundRecipient: string | null = null;
  let outboundSender: string | null = null;

  const steps: Step[] = [
    {
      name: "outbound-smoke",
      run: async () => {
        const org = await prisma.org.findUnique({ where: { id: args.orgId } });
        if (!org) {
          assert(!args.orgIdProvided, `Org ${args.orgId} not found (set --org-id or APEX_TENANT_ZERO_ORG_ID)`);
          await prisma.org.create({
            data: {
              id: args.orgId,
              name: `Smoke Org ${runTag}`,
              slug: `smoke-${runTag}`,
              plan: "TRIAL",
            },
          });
        }

        const toEmail = `smoke_to_${runTag}@example.com`;
        const fromEmail = `smoke_sender_${runTag}@example.com`;
        const subject = `Sprint24h Smoke ${runTag}`;
        const bodyText = `Hello from ${runTag}`;

        const artifact = await prisma.outreachArtifact.create({
          data: {
            orgId: args.orgId,
            toolName: "send_email",
            channel: "EMAIL",
            recipientRef: toEmail,
            subject,
            bodyText,
            payload: {
              to: toEmail,
              from: fromEmail,
              subject,
              body: bodyText,
            },
            status: "QUEUED",
          },
          select: { id: true },
        });
        outboundArtifactId = artifact.id;
        outboundRecipient = toEmail;
        outboundSender = fromEmail;

        // Minimal stubs: processArtifact doesn't require queue/integrations when we patch dispatch.
        const queueStub = {
          isBullMode: () => false,
          getConnection: () => null,
        } as any;
        const integrationsStub = {} as any;
        const configStub = { get: (_key: string, def?: string) => def ?? "" } as any;

        const worker = new SendOutreachWorker(
          prismaService,
          queueStub,
          integrationsStub,
          suppressionService as any,
          configStub,
          evidenceLedger as any,
          undefined,
        ) as any;

        const mockMessageId = `mock_msg_${runTag}`;
        const mockThreadId = `mock_thread_${runTag}`;
        const mockRfcMessageId = `<${runTag}@example.com>`;
        outboundThreadId = mockThreadId;
        outboundRfcMessageId = mockRfcMessageId;

        let dispatchCalls = 0;
        worker.dispatch = async () => {
          dispatchCalls += 1;
          return {
            success: true,
            data: {
              sent: false,
              mock: true,
              provider: "mock",
              messageId: mockMessageId,
              threadId: mockThreadId,
              rfcMessageId: mockRfcMessageId,
              inReplyTo: null,
              references: [],
              to: toEmail,
              subject,
              body: bodyText,
              note: "smoke dispatch",
            },
          };
        };

        await worker.processArtifact(artifact.id, args.orgId);
        assert(dispatchCalls === 1, `expected dispatchCalls=1, got ${dispatchCalls}`);

        const updated = await prisma.outreachArtifact.findUnique({
          where: { id: artifact.id },
          select: { status: true, conversationId: true },
        });
        assert(updated?.status === "SENT", `expected artifact.status=SENT, got ${updated?.status ?? "null"}`);
        assert(updated.conversationId, "expected conversationId to be set on artifact");

        const conversation = await prisma.conversation.findUnique({
          where: { id: updated.conversationId! },
          select: { id: true, orgId: true },
        });
        assert(conversation?.orgId === args.orgId, "conversation not found for org");

        const outboundEmail = await prisma.emailMessage.findFirst({
          where: { orgId: args.orgId, artifactId: artifact.id, direction: "OUTBOUND" },
          select: { id: true, rfcMessageId: true, providerThreadId: true },
        });
        assert(outboundEmail, "expected EmailMessage(OUTBOUND) row");

        const sentEvent = await prisma.emailEvent.findFirst({
          where: { orgId: args.orgId, artifactId: artifact.id, kind: "SENT" },
          select: { id: true },
        });
        assert(sentEvent, "expected EmailEvent(SENT) row");

        // Exercise LlmRequestFact write path via LangSmithService.wrapLlm (no API key ⇒ no network).
        await langsmith.wrapLlm(
          {
            name: "openai.chat",
            model: "gpt-4o-mini",
            orgId: args.orgId,
            artifactId: artifact.id,
            node: "SmokeOutbound",
            inputs: { prompt: "smoke" },
            tags: ["smoke"],
          },
          async () => ({
            content: "ok",
            usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
          }),
        );

        // give fire-and-forget DB write a beat
        await new Promise((r) => setTimeout(r, 50));
        const llmFactsCount = await prisma.llmRequestFact.count({
          where: { orgId: args.orgId, artifactId: artifact.id },
        });
        assert(llmFactsCount >= 1, "expected ≥1 LlmRequestFact row for artifact");
      },
    },
    {
      name: "inbound-smoke",
      run: async () => {
        assert(outboundArtifactId, "missing outboundArtifactId from outbound-smoke");
        assert(outboundThreadId, "missing outboundThreadId from outbound-smoke");
        assert(outboundRfcMessageId, "missing outboundRfcMessageId from outbound-smoke");
        assert(outboundSender, "missing outboundSender from outbound-smoke");

        const replyClassifierQueueStub = { enqueue: async () => undefined } as any;
        const runtimeStub = { triggerRun: async () => ({ id: `smoke_run_${runTag}` }) } as any;
        const configStub = { get: (_key: string, def?: string) => def ?? "" } as any;

        const gmail = new GmailService(
          prismaService,
          configStub,
          runtimeStub,
          replyClassifierQueueStub,
          suppressionService as any,
          evidenceLedger as any,
        ) as any;

        const integrationEmail = outboundSender;
        const fromEmail = `prospect_${runTag}@example.com`;
        const inboundMessageId = `smoke_in_${runTag}`;
        const messageIdHeader = `<${inboundMessageId}@example.com>`;
        const occurred = new Date();

        const message = {
          id: inboundMessageId,
          threadId: outboundThreadId,
          snippet: "unsubscribe",
          from: fromEmail,
          to: integrationEmail,
          subject: `Re: Sprint24h Smoke ${runTag}`,
          date: occurred.toUTCString(),
          labelIds: ["INBOX"],
          body: "unsubscribe",
          headersRaw: [
            { name: "From", value: fromEmail },
            { name: "To", value: integrationEmail },
            { name: "Subject", value: `Re: Sprint24h Smoke ${runTag}` },
            { name: "Date", value: occurred.toUTCString() },
            { name: "Message-ID", value: messageIdHeader },
            { name: "In-Reply-To", value: outboundRfcMessageId },
            { name: "References", value: outboundRfcMessageId },
            { name: "Content-Type", value: "text/plain" },
          ],
          mimeType: "text/plain",
          bodyText: "unsubscribe",
          bodyHtml: null,
        };

        const ingest = await gmail.persistInboundCorrelation(args.orgId, integrationEmail, message);
        assert(ingest?.replyId, "expected persistInboundCorrelation to return replyId");

        const inboundEmail = await prisma.emailMessage.findFirst({
          where: { orgId: args.orgId, providerMessageId: inboundMessageId, direction: "INBOUND" },
          select: { id: true },
        });
        assert(inboundEmail, "expected EmailMessage(INBOUND) row");

        const reply = await prisma.reply.findUnique({
          where: { id: ingest.replyId },
          select: { id: true, orgId: true, emailMessageId: true },
        });
        assert(reply?.orgId === args.orgId, "expected Reply row");

        const repliedEvent = await prisma.emailEvent.findFirst({
          where: { orgId: args.orgId, kind: "REPLIED", replyId: ingest.replyId },
          select: { id: true },
        });
        assert(repliedEvent, "expected EmailEvent(REPLIED) row");

        // Run deterministic classifier to write ReplyClassification.
        const llmStub = { chat: async () => ({ content: "{}", tokensUsed: 0, model: "mock", cost: 0 }) } as any;
        const classifier = new ReplyClassifierService(
          prismaService,
          langsmith as any,
          llmStub,
          evidenceLedger as any,
        );
        await classifier.classifyReply({ orgId: args.orgId, replyId: ingest.replyId });

        const classification = await prisma.replyClassification.findFirst({
          where: { orgId: args.orgId, replyId: ingest.replyId },
          select: { id: true },
        });
        assert(classification, "expected ReplyClassification row");
      },
    },
    {
      name: "suppression-smoke",
      run: async () => {
        assert(outboundRecipient, "missing outboundRecipient from outbound-smoke");

        await suppressionService.add({
          orgId: args.orgId,
          scope: "ORG",
          kind: "UNSUBSCRIBE",
          subjectEmail: outboundRecipient,
          source: "smoke",
          reason: "suppression-smoke",
        });

        const artifact = await prisma.outreachArtifact.create({
          data: {
            orgId: args.orgId,
            toolName: "send_email",
            channel: "EMAIL",
            recipientRef: outboundRecipient,
            subject: `Suppression ${runTag}`,
            bodyText: "should be suppressed",
            payload: { to: outboundRecipient, from: outboundSender ?? "sender@example.com", subject: "x", body: "y" },
            status: "QUEUED",
          },
          select: { id: true },
        });

        const queueStub = { isBullMode: () => false, getConnection: () => null } as any;
        const integrationsStub = {} as any;
        const configStub = { get: (_key: string, def?: string) => def ?? "" } as any;

        const worker = new SendOutreachWorker(
          prismaService,
          queueStub,
          integrationsStub,
          suppressionService as any,
          configStub,
          evidenceLedger as any,
          undefined,
        ) as any;

        let dispatchCalls = 0;
        worker.dispatch = async () => {
          dispatchCalls += 1;
          return { success: true, data: { provider: "mock", messageId: `should_not_send_${runTag}` } };
        };

        await worker.processArtifact(artifact.id, args.orgId);
        assert(dispatchCalls === 0, `expected dispatchCalls=0, got ${dispatchCalls}`);

        const updated = await prisma.outreachArtifact.findUnique({
          where: { id: artifact.id },
          select: { status: true },
        });
        assert(updated?.status === "SUPPRESSED", `expected artifact.status=SUPPRESSED, got ${updated?.status ?? "null"}`);

        const suppressedEvent = await prisma.emailEvent.findFirst({
          where: { orgId: args.orgId, artifactId: artifact.id, kind: "SUPPRESSED" },
          select: { id: true },
        });
        assert(suppressedEvent, "expected EmailEvent(SUPPRESSED) row");
      },
    },
    {
      name: "enrichment-smoke",
      run: async () => {
        const enrichmentFacts = new EnrichmentFactService(prismaService);

        const webSearch = new WebSearchTool(enrichmentFacts as any, evidenceLedger as any) as any;
        const query = `sprint24h smoke ${runTag}`;

        const prevKey = process.env.TAVILY_API_KEY;
        process.env.TAVILY_API_KEY = "smoke_dummy";

        // Force offline: override the provider call to avoid any network requests.
        webSearch.searchWithTavilyData = async () => ({
          results: [{ title: "smoke", url: "https://example.com", snippet: "smoke", content: "smoke" }],
          answer: "smoke",
        });

        const context = {
          orgId: args.orgId,
          agentId: "smoke",
          runId: `smoke_${runTag}`,
          integrations: new Map(),
        };

        await webSearch.execute({ query, max_results: 1 }, context);
        await webSearch.execute({ query, max_results: 1 }, context);

        if (prevKey === undefined) delete process.env.TAVILY_API_KEY;
        else process.env.TAVILY_API_KEY = prevKey;

        const lookupKey = `query:${query}`;
        const facts = await prisma.enrichmentFact.findMany({
          where: { orgId: args.orgId, provider: "tavily", lookupKey, field: "search" },
          select: { id: true },
        });
        assert(facts.length === 1, `expected 1 EnrichmentFact row, got ${facts.length}`);

        const cacheHitEvents = await prisma.evidenceEvent.findMany({
          where: { orgId: args.orgId, kind: "enrichment_cache_hit", createdAt: { gte: startedAt } },
          select: { payload: true },
        });
        const matching = cacheHitEvents.filter((e) => {
          const p = e.payload as any;
          return p && typeof p === "object" && p.lookupKey === lookupKey && p.provider === "tavily";
        });
        assert(matching.length >= 1, "expected ≥1 enrichment_cache_hit evidence event for lookupKey");
      },
    },
    {
      name: "rollup-smoke",
      run: async () => {
        const usageService = new UsageService(prismaService, evidenceLedger as any);
        const hourBucket = new Date(Date.now() - 60 * 60 * 1000);
        const bucket = startOfUtcHour(hourBucket);
        const end = new Date(bucket.getTime() + 60 * 60 * 1000);

        const row = await usageService.rollupHour({ orgId: args.orgId, hourBucket });

        const [llmAgg, enrichAgg, emailAgg] = await Promise.all([
          prisma.llmRequestFact.aggregate({
            where: { orgId: args.orgId, createdAt: { gte: bucket, lt: end } },
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, cachedInputTokens: true, costUsd: true },
          }),
          prisma.enrichmentFact.aggregate({
            where: { orgId: args.orgId, fetchedAt: { gte: bucket, lt: end } },
            _count: { _all: true },
            _sum: { costUsd: true },
          }),
          prisma.emailEvent.groupBy({
            by: ["kind"],
            where: {
              orgId: args.orgId,
              occurredAt: { gte: bucket, lt: end },
              kind: { in: ["SENT", "BOUNCED", "REPLIED", "SUPPRESSED"] },
            },
            _count: { _all: true },
          }),
        ]);

        const emailsSent = emailAgg.find((r) => r.kind === "SENT")?._count._all ?? 0;
        const emailsBounced = emailAgg.find((r) => r.kind === "BOUNCED")?._count._all ?? 0;
        const emailsReplied = emailAgg.find((r) => r.kind === "REPLIED")?._count._all ?? 0;
        const emailsSuppressed = emailAgg.find((r) => r.kind === "SUPPRESSED")?._count._all ?? 0;

        assert(row.bucket.getTime() === bucket.getTime(), "rollupHour bucket mismatch");
        assert(row.llmRequests === (llmAgg._count._all ?? 0), "llmRequests mismatch");
        assert(row.enrichmentCalls === (enrichAgg._count._all ?? 0), "enrichmentCalls mismatch");
        assert(row.emailsSent === emailsSent, "emailsSent mismatch");
        assert(row.emailsBounced === emailsBounced, "emailsBounced mismatch");
        assert(row.emailsReplied === emailsReplied, "emailsReplied mismatch");
        assert(row.emailsSuppressed === emailsSuppressed, "emailsSuppressed mismatch");

        // Ensure DB row exists.
        const stored = await prisma.orgHourlyUsage.findUnique({
          where: { orgId_bucketStart: { orgId: args.orgId, bucketStart: bucket } },
          select: { requests: true },
        });
        assert(stored?.requests !== undefined, "expected OrgHourlyUsage row to exist");
      },
    },
    {
      name: "evaluator-smoke",
      run: async () => {
        assert(outboundArtifactId, "missing outboundArtifactId from outbound-smoke");

        const evaluatorFacts = new EvaluatorFactService(prismaService, evidenceLedger as any);
        const runner = new EvaluatorRunnerService(
          langsmith as any,
          evaluatorFacts as any,
          new PiiLeakageEvaluator(),
          new PromptInjectionEvaluator(),
          new ToxicityEvaluator(),
          new BiasFairnessEvaluator(),
          new HallucinationEvaluator(),
          new CorrectnessEvaluator(),
          new ToolUseCorrectnessEvaluator(),
          new BoilerplateEvaluator(),
          new AiTellEvaluator(),
          new CitationCoverageEvaluator(),
        );

        runner.setJudge(async () => ({ score: 1, label: "safe", rationale: "smoke" }));

        const runId = `smoke_eval_${runTag}`;
        await runner.run({
          runId,
          agent: "sdr_agent.draft_message",
          node: "SmokeEval",
          model: "gpt-4o-mini",
          inputs: { prompt: "hello" },
          outputs: { content: "Hello — quick question about your SDR workflow." },
          tags: ["draft_message", "customer_facing"],
          metadata: {
            org_id: args.orgId,
            outreach_artifact_id: outboundArtifactId,
          },
        });

        // Small delay: evaluator persistence is fire-and-forget.
        await new Promise((r) => setTimeout(r, 50));

        const runs = await prisma.evaluatorRun.findMany({
          where: {
            orgId: args.orgId,
            targetType: EvaluatorTargetType.ARTIFACT,
            targetId: outboundArtifactId,
            createdAt: { gte: startedAt },
          },
          select: { id: true },
          take: 5,
        });
        assert(runs.length >= 1, "expected ≥1 EvaluatorRun row for outbound artifact");
      },
    },
  ];

  const failures: string[] = [];
  try {
    for (const step of steps) {
      try {
        await step.run();
        // eslint-disable-next-line no-console
        console.log(`[PASS] ${step.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${step.name}: ${msg}`);
        // eslint-disable-next-line no-console
        console.error(`[FAIL] ${step.name}: ${msg}`);
        if (process.env.SMOKE_DEBUG === "1" && err instanceof Error && err.stack) {
          // eslint-disable-next-line no-console
          console.error(err.stack);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

void main();
