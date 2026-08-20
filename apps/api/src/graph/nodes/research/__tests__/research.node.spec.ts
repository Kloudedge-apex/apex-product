import { describe, it, expect, vi } from "vitest";
import { buildResearchNode, type ResearchNodeDeps } from "../research.node";
import { STAGE, type PipelineState } from "../../../state";

/**
 * RESEARCH node — runs between SCORING and APPROVAL. For each unique qualified
 * (tier A/B) company among scoredLeads, it extracts dated prospect signals
 * (via SignalExtractionService) and writes them to the evidence ledger. The
 * node isolates per-company extraction failures, requires extracted signals to
 * be durably confirmed before reporting success, accepts zero signals as a valid
 * COMPLETE outcome, and short-circuits on upstream scoring failure.
 */
describe("buildResearchNode", () => {
  const orgId = "org_test";
  const runId = "run_test";

  // Cast a partial state — the node only reads orgId/runId/scoredLeads/stageStatuses.
  const stateWith = (over: Partial<PipelineState>): PipelineState =>
    ({
      orgId,
      runId,
      scoredLeads: [],
      stageStatuses: {},
      ...over,
    }) as PipelineState;

  function makeDeps(over: {
    extractForCompany?: ReturnType<typeof vi.fn>;
    recordSignal?: ReturnType<typeof vi.fn>;
    personFindMany?: ReturnType<typeof vi.fn>;
    companyFindMany?: ReturnType<typeof vi.fn>;
  }) {
    const personFindMany =
      over.personFindMany ?? vi.fn(async () => [{ companyId: "c1" }, { companyId: "c1" }]);
    const companyFindMany =
      over.companyFindMany ??
      vi.fn(async () => [{ id: "c1", name: "Acme", domain: "acme.io", raw: {} }]);
    const extractForCompany =
      over.extractForCompany ??
      vi.fn(async () => [
        {
          kind: "recent_hire",
          source: "https://x.test/a",
          date: "2026-06-01",
          confidence: 0.9,
          summary: 'Posted "SDR".',
          fields: { jobTitle: "SDR" },
        },
        { kind: "press_mention", source: "https://x.test/b", date: "2026-06-02", confidence: 0.6 },
      ]);
    const recordSignal = over.recordSignal ?? vi.fn(async () => "CREATED" as const);

    const deps = {
      prisma: { person: { findMany: personFindMany }, company: { findMany: companyFindMany } },
      signalExtraction: { extractForCompany },
      evidenceLedger: { recordSignal },
    } as unknown as ResearchNodeDeps;

    return { deps, personFindMany, companyFindMany, extractForCompany, recordSignal };
  }

  it("happy path: dedupes companies, writes one signal per extracted input", async () => {
    const { deps, personFindMany, companyFindMany, extractForCompany, recordSignal } = makeDeps({});
    const node = buildResearchNode(deps);

    const update = await node(
      stateWith({
        scoredLeads: [
          { personId: "p1", score: 90, tier: "A" },
          { personId: "p2", score: 60, tier: "B" },
          { personId: "p3", score: 30, tier: "C" },
        ],
      }),
    );

    // Only qualified (A/B) person ids are resolved — C is excluded.
    expect(personFindMany).toHaveBeenCalledTimes(1);
    expect(personFindMany.mock.calls[0][0].where.id.in).toEqual(["p1", "p2"]);

    // Both resolve queries are org-scoped (defense-in-depth, matching every
    // other node in the pipeline). Person has no direct orgId → scope via company.
    expect(personFindMany.mock.calls[0][0].where.company).toEqual({ orgId });
    expect(companyFindMany.mock.calls[0][0].where.orgId).toBe(orgId);

    // Two qualified people share company c1 → extract runs once (dedup).
    expect(extractForCompany).toHaveBeenCalledTimes(1);

    // Two SignalInputs → two recordSignal writes, each scoped + company-tagged.
    expect(recordSignal).toHaveBeenCalledTimes(2);
    expect(recordSignal).toHaveBeenCalledWith(
      expect.objectContaining({ orgId, runId, companyId: "c1", kind: "recent_hire" }),
    );
    expect(recordSignal).toHaveBeenCalledWith(
      expect.objectContaining({ orgId, runId, companyId: "c1", kind: "press_mention" }),
    );

    // Full payload pass-through — guards against silently dropping a mapped
    // field (source/date/summary/confidence/fields) in the node.
    expect(recordSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId,
        runId,
        companyId: "c1",
        kind: "recent_hire",
        source: "https://x.test/a",
        date: "2026-06-01",
        summary: 'Posted "SDR".',
        confidence: 0.9,
        fields: { jobTitle: "SDR" },
      }),
    );

    expect(update.stagesCompleted).toEqual([STAGE.RESEARCH]);
    expect(update.stageStatuses?.[STAGE.RESEARCH]).toBe("COMPLETE");
  });

  it("upstream SCORING FAILED → skip: returns FAILED, touches nothing", async () => {
    const { deps, personFindMany, extractForCompany, recordSignal } = makeDeps({});
    const node = buildResearchNode(deps);

    const update = await node(
      stateWith({
        scoredLeads: [{ personId: "p1", score: 90, tier: "A" }],
        stageStatuses: { [STAGE.SCORING]: "FAILED" },
      }),
    );

    expect(update.stagesCompleted).toEqual([STAGE.RESEARCH]);
    expect(update.stageStatuses?.[STAGE.RESEARCH]).toBe("FAILED");
    expect(personFindMany).not.toHaveBeenCalled();
    expect(extractForCompany).not.toHaveBeenCalled();
    expect(recordSignal).not.toHaveBeenCalled();
  });

  it("no qualified leads (all tier C) → COMPLETE, no extraction, no recordSignal", async () => {
    const { deps, personFindMany, extractForCompany, recordSignal } = makeDeps({});
    const node = buildResearchNode(deps);

    const update = await node(
      stateWith({
        scoredLeads: [
          { personId: "p1", score: 10, tier: "C" },
          { personId: "p2", score: 20, tier: "C" },
        ],
      }),
    );

    expect(update.stagesCompleted).toEqual([STAGE.RESEARCH]);
    expect(update.stageStatuses?.[STAGE.RESEARCH]).toBe("COMPLETE");
    expect(personFindMany).not.toHaveBeenCalled();
    expect(extractForCompany).not.toHaveBeenCalled();
    expect(recordSignal).not.toHaveBeenCalled();
  });

  it("per-company error isolation: extract rejects → PARTIAL, never throws", async () => {
    const extractForCompany = vi.fn(async () => {
      throw new Error("tavily exploded");
    });
    const { deps, recordSignal } = makeDeps({ extractForCompany });
    const node = buildResearchNode(deps);

    const update = await node(
      stateWith({
        scoredLeads: [{ personId: "p1", score: 90, tier: "A" }],
      }),
    );

    expect(extractForCompany).toHaveBeenCalledTimes(1);
    expect(recordSignal).not.toHaveBeenCalled();
    expect(update.stagesCompleted).toEqual([STAGE.RESEARCH]);
    expect(update.stageStatuses?.[STAGE.RESEARCH]).toBe("PARTIAL");
  });

  it("fails before approval when every extracted signal misses durable persistence", async () => {
    const recordSignal = vi.fn(async () => "FAILED" as const);
    const { deps } = makeDeps({ recordSignal });
    const node = buildResearchNode(deps);

    const update = await node(
      stateWith({
        scoredLeads: [{ personId: "p1", score: 90, tier: "A" }],
      }),
    );

    expect(recordSignal).toHaveBeenCalledTimes(2);
    expect(update.stageStatuses?.[STAGE.RESEARCH]).toBe("FAILED");
    expect(update.messages?.at(-1)?.text).toContain("0/2 signal(s) durable");
    expect(update.messages?.at(-1)?.level).toBe("error");
  });

  it("reports PARTIAL when some extracted evidence is durable and some fails", async () => {
    const recordSignal = vi
      .fn()
      .mockResolvedValueOnce("CREATED")
      .mockResolvedValueOnce("FAILED");
    const { deps } = makeDeps({ recordSignal });
    const node = buildResearchNode(deps);

    const update = await node(
      stateWith({
        scoredLeads: [{ personId: "p1", score: 90, tier: "A" }],
      }),
    );

    expect(update.stageStatuses?.[STAGE.RESEARCH]).toBe("PARTIAL");
    expect(update.messages?.at(-1)?.text).toContain("1/2 signal(s) durable");
    expect(update.messages?.at(-1)?.level).toBe("warn");
  });
});
