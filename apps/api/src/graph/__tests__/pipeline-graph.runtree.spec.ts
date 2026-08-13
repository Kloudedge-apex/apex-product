import { describe, it, expect, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { buildPipelineGraph } from "../pipeline-graph";
import type { ChatMessage, ChatOptions, LLMResponse } from "../../runtime/llm.service";

/**
 * Audit P0 #12: every LLM call inside the pipeline graph (and its SDR
 * outreach subgraph) MUST receive the GraphRun-level LangSmith root run id
 * as `ChatOptions.parentRunId` so traces nest under the GraphRun trace
 * instead of landing as orphaned top-level runs.
 *
 * This spec wires `buildPipelineGraph({ parentRunId: ROOT })` with a mock
 * `llm.chat` that records every call's options, drives one happy-path
 * invoke (sourcing → enrichment → scoring → approval → outreach), and
 * asserts every chat call's options.parentRunId === ROOT.
 */
describe("pipeline-graph parentRunId propagation (audit P0 #12)", () => {
  const orgId = "org_runtree";
  const icpId = "icp_runtree";
  const ROOT = "root-test-xyz";
  // Inside the press_mention freshness window (90d) so the brief grounds —
  // the in-code evidence gate (audit B3) refuses ungrounded briefs BEFORE any
  // llm.chat call, which would make this propagation spec vacuous.
  const FRESH_SIGNAL_DATE = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  let chatCalls: Array<{ messages: ChatMessage[]; options?: ChatOptions }>;
  let deps: Parameters<typeof buildPipelineGraph>[0];

  const eligibleEmail = (id: string, email: string) => ({
    id,
    email,
    source: "PATTERN_GUESS" as const,
    verified: true,
    verificationResult: "VALID" as const,
    confidence: 0.9,
    verifiedAt: new Date("2026-05-25T00:00:00.000Z"),
    createdAt: new Date("2026-05-24T00:00:00.000Z"),
  });

  beforeEach(() => {
    chatCalls = [];
    let artifactCounter = 0;
    const drafterJson = JSON.stringify({
      subject: "Quick question about Acme growth",
      body:
        "Hi Alice, noticed Acme is at 50-200 headcount and scaling SaaS. " +
        "Curious how you handle SDR pipeline. Worth a 15-min look?",
      refusal: null,
      // S1 is the fresh press_mention signal below; citing it (plus the F1
      // firmographic) satisfies the QA citation gate so the draft passes QA.
      groundedness_self_check: { cited_fact_ids: ["F1", "S1"], unsupported_claims: [] },
    });

    deps = {
      leads: {
        runSourcingStage: async () => ({
          companies: 1,
          people: 1,
          companyIds: ["c1"],
          personIds: ["p1"],
        }),
        runEnrichmentStage: async () => ({
          merged: 1,
          enriched: 1,
          personIds: ["p1"],
        }),
        runScoringStage: async () => ({
          scored: 1,
          personIds: ["p1"],
        }),
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["leads"],

      prisma: {
        company: {
          findMany: async () => [{ id: "c1", domain: "acme.io", name: "Acme" }],
          findFirst: async () => ({
            id: "c1",
            name: "Acme",
            domain: "acme.io",
            employeeRange: "50-200",
            industry: "SaaS",
            country: "US",
            city: "SF",
            fundingStage: "Series B",
            techStack: ["Postgres", "Node"],
            intentSignals: [],
          }),
        },
        person: {
          findMany: async () => [
            {
              id: "p1",
              companyId: "c1",
              firstName: "Alice",
              lastName: "Smith",
              title: "VP Sales",
              emails: [eligibleEmail("email_p1", "alice@acme.io")],
              company: { name: "Acme", domain: "acme.io" },
            },
          ],
          findFirst: async () => ({
            title: "VP Sales",
            seniority: "VP",
            department: "Sales",
            location: "SF",
            bio: null,
          }),
        },
        evidenceEvent: {
          // One fresh, dated, non-mock signal so `hasGroundingSignal` is true
          // and the SDR drafter actually reaches llm.chat (see audit B3 gate).
          findMany: async () => [
            {
              kind: "press_mention",
              payload: {
                date: FRESH_SIGNAL_DATE,
                source: "https://news.example.com/acme-raises",
                outlet: "news.example.com",
                headline: "Acme raises $20M",
                confidence: 0.6,
              },
              createdAt: new Date(),
            },
          ],
        },
        leadScore: {
          findMany: async () => [{ personId: "p1", score: 92 }],
          findFirst: async () => ({
            score: 92,
            breakdown: {},
            updatedAt: new Date("2026-05-26T00:00:00Z"),
          }),
        },
        graphRun: {
          findFirst: async () => ({ id: "graph_runtree" }),
        },
        outreachArtifact: {
          findFirst: async () => null,
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"],

      runtime: {
        triggerRun: async () => ({ id: "run_unused" }),
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["runtime"],

      // Mock LLM that records every call's options. The drafter is the only
      // node that calls llm.chat today, but if more callers are added the
      // assertion below catches any that forget to thread parentRunId.
      llm: {
        chat: async (messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse> => {
          chatCalls.push({ messages, options });
          return {
            content: drafterJson,
            tokensUsed: 100,
            model: "test-model",
            cost: 0,
          };
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["llm"],

      outreachArtifacts: {
        recordDryRun: async () => {
          artifactCounter += 1;
          return { id: `art_${artifactCounter}` };
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["outreachArtifacts"],

      evidenceLedger: {
        leadSourced: async () => undefined,
        leadScored: async () => undefined,
        recordSignal: async () => undefined,
        messageDrafted: async () => undefined,
        qaPass: async () => undefined,
        qaFail: async () => undefined,
        approvalRequested: async () => undefined,
        approvalGranted: async () => undefined,
        approvalDenied: async () => undefined,
        artifactPersisted: async () => undefined,
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["evidenceLedger"],

      signalExtraction: {
        extractForCompany: async () => [],
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["signalExtraction"],

      // The unit under test: parentRunId must flow from here all the way
      // down to every llm.chat call inside the pipeline + subgraph.
      parentRunId: ROOT,
    };
  });

  it("threads parentRunId into every llm.chat call across pipeline + SDR subgraph", async () => {
    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(deps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_runtree" } };

    // Drive through approval + into outreach where the drafter LLM call lives.
    await graph.invoke(
      { orgId, runId: "t_runtree", icpProfileIds: [icpId] },
      config,
    );
    await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "alice@acme.io" } }),
      config,
    );

    // Today only the SDR drafter hits llm.chat — but the contract is "every
    // call". If a future node adds an LLM call without threading
    // parentRunId, the assertion fails loudly here.
    expect(chatCalls.length).toBeGreaterThan(0);
    for (const call of chatCalls) {
      expect(call.options?.parentRunId).toBe(ROOT);
    }
  });

  it("omitting parentRunId keeps the graph runnable (backward compatible)", async () => {
    // Sanity check the optional contract: graphs without a root run id
    // still execute and llm.chat just receives undefined parentRunId.
    const noParentDeps = { ...deps, parentRunId: undefined };
    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(noParentDeps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_no_parent" } };

    await graph.invoke(
      { orgId, runId: "t_no_parent", icpProfileIds: [icpId] },
      config,
    );
    await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "alice@acme.io" } }),
      config,
    );

    expect(chatCalls.length).toBeGreaterThan(0);
    for (const call of chatCalls) {
      expect(call.options?.parentRunId).toBeUndefined();
    }
  });
});
