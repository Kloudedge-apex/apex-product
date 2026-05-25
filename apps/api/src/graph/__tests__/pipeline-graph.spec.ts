import { describe, it, expect, beforeEach } from "vitest";
import { MemorySaver, Command, isInterrupted } from "@langchain/langgraph";
import { buildPipelineGraph, StageFailureError } from "../pipeline-graph";
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
          return {
            companies: 5,
            people: 12,
            companyIds: ["c1"],
            personIds: ["p1", "p2", "p3"],
          };
        },
        runEnrichmentStage: async () => {
          callLog.push("enrichment");
          return { merged: 3, enriched: 12, personIds: ["p1", "p2", "p3"] };
        },
        runScoringStage: async () => {
          callLog.push("scoring");
          return { scored: 12, personIds: ["p1", "p2", "p3"] };
        },
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
              emails: [{ email: "alice@acme.io" }],
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
          findMany: async () => [],
        },
        leadScore: {
          findMany: async () => [
            { personId: "p1", score: 90 },
            { personId: "p2", score: 60 },
            { personId: "p3", score: 30 },
          ],
          findFirst: async () => ({
            score: 90,
            breakdown: {},
            updatedAt: new Date("2026-05-26T00:00:00Z"),
          }),
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

  it("marks every stage COMPLETE/PARTIAL on the happy path (none FAILED)", async () => {
    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(deps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_status_happy" } };

    await graph.invoke({ orgId, runId: "t_status_happy", icpProfileIds: [icpId] }, config);
    const result = await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "alice@acme.io" } }),
      config,
    );

    // Fixture: sourcing/enrichment/scoring all succeed. No stage is FAILED.
    // The exact COMPLETE vs PARTIAL split depends on how many DB-snapshot
    // rows the mocks return; the important contract is "no FAILED".
    for (const stage of [STAGE.SOURCING, STAGE.ENRICHMENT, STAGE.SCORING, STAGE.APPROVAL, STAGE.OUTREACH]) {
      expect(result.stageStatuses?.[stage]).not.toBe("FAILED");
      expect(["COMPLETE", "PARTIAL"]).toContain(result.stageStatuses?.[stage]);
    }
    expect(result.stageStatuses?.[STAGE.APPROVAL]).toBe("COMPLETE");
    expect(result.stageStatuses?.[STAGE.SCORING]).toBe("COMPLETE");
  });

  it("sourcing FAILED when zero leads found terminates run with reason", async () => {
    const failDeps = {
      ...deps,
      leads: {
        ...deps.leads,
        runSourcingStage: async () => ({
          companies: 0,
          people: 0,
          companyIds: [],
          personIds: [],
        }),
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["leads"],
      prisma: {
        ...deps.prisma,
        company: {
          ...(deps.prisma as unknown as { company: object }).company,
          findMany: async () => [],
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"],
    };

    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(failDeps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_sourcing_fail" } };

    let caught: unknown;
    try {
      await graph.invoke(
        { orgId, runId: "t_sourcing_fail", icpProfileIds: [icpId] },
        config,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StageFailureError);
    const sfe = caught as StageFailureError;
    expect(sfe.stage).toBe(STAGE.SOURCING);
    expect(sfe.reason).toBe("no_leads_from_any_source");
    expect(sfe.message).toContain("no_leads_from_any_source");

    // Downstream never ran — enrichment was not called, supervisor never
    // routed past sourcing.
    expect(callLog).not.toContain("enrichment");
    expect(callLog).not.toContain("scoring");
  });

  it("enrichment FAILED when sourcing succeeded but zero enriched", async () => {
    const failDeps = {
      ...deps,
      leads: {
        ...deps.leads,
        runEnrichmentStage: async () => {
          callLog.push("enrichment");
          return { merged: 0, enriched: 0, personIds: [] };
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["leads"],
      prisma: {
        ...deps.prisma,
        // Sourcing snapshot returns a company so sourcing is COMPLETE,
        // but enrichment finds no people with emails.
        person: {
          findMany: async () => [],
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"],
    };

    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(failDeps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_enrich_fail" } };

    let caught: unknown;
    try {
      await graph.invoke(
        { orgId, runId: "t_enrich_fail", icpProfileIds: [icpId] },
        config,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(StageFailureError);
    const sfe = caught as StageFailureError;
    expect(sfe.stage).toBe(STAGE.ENRICHMENT);
    expect(sfe.reason).toBe("enrichment_yielded_zero");
    // Sourcing ran but scoring never ran.
    expect(callLog).toContain("sourcing");
    expect(callLog).toContain("enrichment");
    expect(callLog).not.toContain("scoring");
  });

  it("scoring with all-below-threshold completes run (NOT failed)", async () => {
    // Override scoring to return only tier-C scores. Person.findMany still
    // returns the row for the outreach snapshot but `targets` will be empty.
    const lowScoreDeps = {
      ...deps,
      prisma: {
        ...deps.prisma,
        leadScore: {
          findMany: async () => [
            { personId: "p1", score: 10 },
            { personId: "p2", score: 20 },
          ],
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"],
    };

    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(lowScoreDeps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_low_scores" } };

    await graph.invoke({ orgId, runId: "t_low_scores", icpProfileIds: [icpId] }, config);
    const result = await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "alice@acme.io" } }),
      config,
    );

    expect(result.stageStatuses?.[STAGE.SCORING]).toBe("COMPLETE");
    // No tier-A/B leads → outreach has nothing to draft, but the run
    // completes normally (not failed).
    expect(result.stageStatuses?.[STAGE.OUTREACH]).toBe("COMPLETE");
    expect(result.outreachResults ?? []).toHaveLength(0);
    expect(callLog.filter((c) => c.startsWith("artifact:"))).toHaveLength(0);
  });

  it("downstream gate short-circuits when upstream stageStatus is FAILED", async () => {
    // Seed entry state with sourcing already marked FAILED via stageStatuses.
    // The supervisor still routes to enrichment (it only inspects
    // stagesCompleted), but the enrichment node's gate must skip the work
    // and propagate FAILED without calling runEnrichmentStage.
    const sentinelDeps = {
      ...deps,
      leads: {
        ...deps.leads,
        runEnrichmentStage: async () => {
          callLog.push("enrichment-should-not-run");
          return { merged: 99, enriched: 99, personIds: ["px"] };
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["leads"],
    };

    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(sentinelDeps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_gate" } };

    // Pre-mark sourcing as COMPLETE+FAILED. Supervisor will route to
    // enrichment next; the gate must skip it.
    await graph.invoke(
      {
        orgId,
        runId: "t_gate",
        icpProfileIds: [icpId],
        stagesCompleted: [STAGE.SOURCING],
        stageStatuses: { [STAGE.SOURCING]: "FAILED" },
        sourcedCompanies: [{ id: "c1", domain: "acme.io", name: "Acme" }],
      },
      config,
    );

    expect(callLog).not.toContain("enrichment-should-not-run");
  });

  it("two parallel GraphRuns in same org see only their own leads (no cross-pollination)", async () => {
    // Simulates the bug-fix contract for 200-lead-leak: when two pipeline
    // runs execute against the same org concurrently, each run must see
    // ONLY the companies/people/scores produced by its own sourcing stage.
    // The DB still contains rows from BOTH runs (it's the same org), but
    // the per-run snapshot must be scoped to that run's ID set.

    // Run A produces companies [cA1, cA2] and people [pA1, pA2].
    // Run B produces companies [cB1] and people [pB1].
    // The shared Prisma stub holds rows for BOTH runs; the contract is
    // that each node's `findMany` only returns the rows whose IDs were
    // passed in `where.id.in` (i.e. the per-run set).

    interface PersonRow {
      id: string;
      companyId: string;
      firstName: string;
      lastName: string;
      title: string | null;
      emails: Array<{ email: string }>;
      company?: { name: string; domain: string };
    }
    interface CompanyRow { id: string; domain: string; name: string }
    interface LeadScoreRow { personId: string; score: number; orgId: string }

    const allCompanies: CompanyRow[] = [
      { id: "cA1", domain: "a1.com", name: "Acorp1" },
      { id: "cA2", domain: "a2.com", name: "Acorp2" },
      { id: "cB1", domain: "b1.com", name: "Bcorp1" },
    ];
    const allPeople: PersonRow[] = [
      { id: "pA1", companyId: "cA1", firstName: "Anna", lastName: "Aye", title: "VP", emails: [{ email: "anna@a1.com" }] },
      { id: "pA2", companyId: "cA2", firstName: "Aaron", lastName: "Bee", title: "VP", emails: [{ email: "aaron@a2.com" }] },
      { id: "pB1", companyId: "cB1", firstName: "Bella", lastName: "Cee", title: "VP", emails: [{ email: "bella@b1.com" }] },
    ];
    const allScores: LeadScoreRow[] = [
      { personId: "pA1", score: 90, orgId },
      { personId: "pA2", score: 85, orgId },
      { personId: "pB1", score: 95, orgId },
    ];

    // Helper to extract the `id.in` (or `personId.in`) filter from a query.
    const idsFromWhere = (w: { id?: { in?: string[] }; personId?: { in?: string[] } } | undefined): string[] | null => {
      if (!w) return null;
      if (w.id?.in) return w.id.in;
      if (w.personId?.in) return w.personId.in;
      return null;
    };

    const sharedPrisma = {
      company: {
        findMany: async ({ where }: { where: { id?: { in?: string[] } } }) => {
          const ids = idsFromWhere(where);
          return ids === null ? allCompanies : allCompanies.filter((c) => ids.includes(c.id));
        },
        findFirst: async () => allCompanies[0],
      },
      person: {
        findMany: async ({ where }: { where: { id?: { in?: string[] } } }) => {
          const ids = idsFromWhere(where);
          const rows = ids === null ? allPeople : allPeople.filter((p) => ids.includes(p.id));
          // outreach node selects `company: { name, domain }` — synthesise it
          return rows.map((p) => ({
            ...p,
            company: allCompanies.find((c) => c.id === p.companyId)
              ? { name: allCompanies.find((c) => c.id === p.companyId)!.name, domain: allCompanies.find((c) => c.id === p.companyId)!.domain }
              : { name: "?", domain: "?" },
          }));
        },
      },
      leadScore: {
        findMany: async ({ where }: { where: { personId?: { in?: string[] } } }) => {
          const ids = idsFromWhere(where);
          return ids === null ? allScores : allScores.filter((s) => ids.includes(s.personId));
        },
      },
      agent: { findFirst: async () => ({ id: "agent_sdr" }) },
      graphRun: { findFirst: async () => ({ id: "graph_X" }) },
    } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"];

    // Run A's sourcing returns ONLY A's IDs; Run B's returns ONLY B's IDs.
    // The stub uses a flag flipped between graph runs to mimic concurrent
    // calls with distinct outputs.
    let runLabel: "A" | "B" = "A";
    const isoLeads = {
      runSourcingStage: async () => runLabel === "A"
        ? { companies: 2, people: 2, companyIds: ["cA1", "cA2"], personIds: ["pA1", "pA2"] }
        : { companies: 1, people: 1, companyIds: ["cB1"], personIds: ["pB1"] },
      runEnrichmentStage: async (_org: string, _icp: string, scoped?: string[]) => ({
        merged: 0,
        enriched: scoped?.length ?? 0,
        personIds: scoped ?? [],
      }),
      runScoringStage: async (_org: string, _icp: string, scoped?: string[]) => ({
        scored: scoped?.length ?? 0,
        personIds: scoped ?? [],
      }),
    } as unknown as Parameters<typeof buildPipelineGraph>[0]["leads"];

    const isolatedDeps = { ...deps, prisma: sharedPrisma, leads: isoLeads };
    const graph = buildPipelineGraph(isolatedDeps).compile({ checkpointer: new MemorySaver() });

    runLabel = "A";
    const a = await graph.invoke(
      { orgId, runId: "runA", icpProfileIds: [icpId] },
      { configurable: { thread_id: "runA" } },
    );
    // graph paused at approval — that's fine, we only need the snapshots
    // populated by sourcing/enrichment/scoring.
    runLabel = "B";
    const b = await graph.invoke(
      { orgId, runId: "runB", icpProfileIds: [icpId] },
      { configurable: { thread_id: "runB" } },
    );

    const aCompanyIds = (a.sourcedCompanies ?? []).map((c) => c.id).sort();
    const bCompanyIds = (b.sourcedCompanies ?? []).map((c) => c.id).sort();
    expect(aCompanyIds).toEqual(["cA1", "cA2"]);
    expect(bCompanyIds).toEqual(["cB1"]);

    const aPersonIds = (a.enrichedPeople ?? []).map((p) => p.id).sort();
    const bPersonIds = (b.enrichedPeople ?? []).map((p) => p.id).sort();
    expect(aPersonIds).toEqual(["pA1", "pA2"]);
    expect(bPersonIds).toEqual(["pB1"]);

    const aScoreIds = (a.scoredLeads ?? []).map((s) => s.personId).sort();
    const bScoreIds = (b.scoredLeads ?? []).map((s) => s.personId).sort();
    expect(aScoreIds).toEqual(["pA1", "pA2"]);
    expect(bScoreIds).toEqual(["pB1"]);

    // Neither run sees the other's IDs anywhere in its snapshot state.
    expect(aCompanyIds).not.toContain("cB1");
    expect(bCompanyIds).not.toContain("cA1");
    expect(bCompanyIds).not.toContain("cA2");
  });

  it("outreach uses state.scoredLeads — never re-queries leadScore", async () => {
    // Hard guarantee: outreach node MUST NOT call prisma.leadScore.findMany.
    // If it did, it could pull org-wide scores including prior runs.
    let leadScoreCalls = 0;
    const sentinelDeps = {
      ...deps,
      prisma: {
        ...(deps.prisma as unknown as Record<string, unknown>),
        leadScore: {
          findMany: async () => {
            leadScoreCalls += 1;
            return [];
          },
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"],
    };

    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(sentinelDeps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_outreach_no_requery" } };

    await graph.invoke({ orgId, runId: "t_outreach_no_requery", icpProfileIds: [icpId] }, config);
    // Scoring node legitimately calls leadScore.findMany once — capture the
    // baseline, then ensure outreach adds zero further calls.
    const beforeOutreach = leadScoreCalls;
    await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "alice@acme.io" } }),
      config,
    );
    const afterOutreach = leadScoreCalls;

    // Outreach must contribute NO additional leadScore reads.
    expect(afterOutreach).toBe(beforeOutreach);
  });

  it("approval gate completes when there is nothing to approve", async () => {
    // Empty scored leads → approval still runs (it asks the human a question),
    // and the human rejecting / approving an empty candidate set is COMPLETE.
    const emptyDeps = {
      ...deps,
      prisma: {
        ...deps.prisma,
        leadScore: {
          findMany: async () => [],
        },
      } as unknown as Parameters<typeof buildPipelineGraph>[0]["prisma"],
    };

    const checkpointer = new MemorySaver();
    const graph = buildPipelineGraph(emptyDeps).compile({ checkpointer });
    const config = { configurable: { thread_id: "t_no_approve" } };

    await graph.invoke({ orgId, runId: "t_no_approve", icpProfileIds: [icpId] }, config);
    const result = await graph.invoke(
      new Command({ resume: { approved: true, approvedBy: "alice@acme.io" } }),
      config,
    );

    expect(result.stageStatuses?.[STAGE.APPROVAL]).toBe("COMPLETE");
    expect(result.stageStatuses?.[STAGE.OUTREACH]).toBe("COMPLETE");
  });
});
