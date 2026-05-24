import { describe, it, expect, beforeEach } from "vitest";
import { MemorySaver, Command, isInterrupted } from "@langchain/langgraph";
import { buildPipelineGraph } from "../pipeline-graph";
import { NODE, STAGE } from "../state";

/**
 * Exercise the supervisor with hand-rolled stubs for LeadsService /
 * PrismaService / RuntimeService. The goal is to verify (a) the supervisor
 * routes through every stage in order, (b) the graph pauses at the HITL
 * interrupt, and (c) it resumes through to outreach when approved.
 *
 * Uses MemorySaver so the test doesn't need a database.
 */
describe("pipeline-graph (supervisor routing)", () => {
  const orgId = "org_test";
  const icpId = "icp_test";
  let callLog: string[];
  let deps: Parameters<typeof buildPipelineGraph>[0];

  beforeEach(() => {
    callLog = [];
    let artifactCounter = 0;
    deps = {
      leads: {
        runSourcingStage: async () => {
          callLog.push("sourcing");
          return { companies: 5, people: 12 };
        },
        runEnrichmentStage: async () => {
          callLog.push("enrichment");
          return { merged: 3, enriched: 12 };
        },
        runScoringStage: async () => {
          callLog.push("scoring");
          return { scored: 12 };
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["leads"],

      prisma: {
        company: {
          findMany: async () => [{ id: "c1", domain: "acme.io", name: "Acme" }],
          findFirst: async () => ({
            name: "Acme",
            domain: "acme.io",
            employeeRange: "50-200",
            industry: "SaaS",
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
              emails: [{ email: "alice@acme.io" }],
              company: { name: "Acme", domain: "acme.io" },
            },
          ],
        },
        leadScore: {
          findMany: async () => [
            { personId: "p1", score: 90 },
            { personId: "p2", score: 60 },
            { personId: "p3", score: 30 },
          ],
        },
        agent: {
          findFirst: async () => ({ id: "agent_sdr" }),
        },
        graphRun: {
          findFirst: async () => ({ id: "graph_1" }),
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"],

      runtime: {
        triggerRun: async (agentId: string) => {
          callLog.push(`runtime.trigger:${agentId}`);
          return { id: `run_${callLog.length}` };
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["runtime"],

      llm: {
        chat: async () => ({
          content: '{"subject":"Quick question about Acme growth","body":"Hi Alice, noticed Acme is at 50-200 headcount and scaling SaaS. Curious how you are handling SDR pipeline — we help teams at your stage. Worth a 15-min call next week?"}',
          tokensUsed: 100,
          model: "test",
          cost: 0,
        }),
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["llm"],

      outreachArtifacts: {
        recordDryRun: async () => {
          artifactCounter += 1;
          callLog.push(`artifact:${artifactCounter}`);
          return { id: `art_${artifactCounter}` };
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["outreachArtifacts"],

      evidenceLedger: {
        leadSourced: async () => undefined,
        leadScored: async () => undefined,
        messageDrafted: async () => undefined,
        qaPass: async () => undefined,
        qaFail: async () => undefined,
        approvalRequested: async () => undefined,
        approvalGranted: async () => undefined,
        approvalDenied: async () => undefined,
        artifactPersisted: async () => undefined,
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["evidenceLedger"],
    };
  });

  it("runs sourcing → enrichment → scoring then pauses at approval", async () => {
    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(deps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t1" } };

    const result = await graph.invoke(
      { orgId, runId: "t1", icpProfileIds: [icpId] },
      config,
    );

    expect(callLog).toEqual(["sourcing", "enrichment", "scoring"]);
    expect(result.stagesCompleted).toEqual(
      expect.arrayContaining([STAGE.SOURCING, STAGE.ENRICHMENT, STAGE.SCORING]),
    );
    expect(result.stagesCompleted).not.toContain(STAGE.APPROVAL);
    expect(isInterrupted(result)).toBe(true);
  });

  it("resumes through outreach when approved", async () => {
    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(deps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t2" } };

    await graph.invoke({ orgId, runId: "t2", icpProfileIds: [icpId] }, config);
    const result = await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "alice@acme.io" } }),
      config,
    );

    expect(result.approved).toBe(true);
    expect(result.approvedBy).toBe("alice@acme.io");
    expect(result.outreachResults?.length ?? 0).toBeGreaterThan(0);
    // Phase 2.5: outreach must NOT invoke runtime.triggerRun — that path
    // would bypass the SideEffectPolicy gate. The subgraph produces a
    // reviewable artifact instead.
    expect(callLog.filter((c) => c.startsWith("runtime.trigger"))).toHaveLength(0);
    expect(callLog.filter((c) => c.startsWith("artifact:")).length).toBeGreaterThan(0);
    expect(result.outreachResults?.[0]?.status).toBe("queued");
    expect(result.outreachResults?.[0]?.agentRunId).toMatch(/^art_/);
    expect(result.stagesCompleted).toContain(STAGE.OUTREACH);
  });

  it("skips outreach when rejected", async () => {
    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(deps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t3" } };

    await graph.invoke({ orgId, runId: "t3", icpProfileIds: [icpId] }, config);
    const result = await graph.invoke(
      new Command({ resume: { approved: false } }),
      config,
    );

    expect(result.approved).toBe(false);
    expect(callLog.filter((c) => c.startsWith("runtime.trigger"))).toHaveLength(0);
    expect(callLog.filter((c) => c.startsWith("artifact:"))).toHaveLength(0);
    expect(result.outreachResults ?? []).toHaveLength(0);
    // Supervisor short-circuits to END when approved=false, so OUTREACH
    // stage never runs.
    expect(result.stagesCompleted).toContain(STAGE.APPROVAL);
    expect(result.stagesCompleted).not.toContain(STAGE.OUTREACH);
  });

  it("supervisor honors NODE constants for routing", () => {
    expect(NODE.SUPERVISOR).toBe("supervisor");
    expect(NODE.SOURCING).toBe("sourcing_agent");
    expect(NODE.APPROVAL).toBe("human_approval");
  });
});
