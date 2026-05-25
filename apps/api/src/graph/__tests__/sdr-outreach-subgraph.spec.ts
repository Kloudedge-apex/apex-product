import { describe, it, expect, vi } from "vitest";
import {
  buildSdrOutreachSubgraph,
  runSdrOutreachSubgraph,
  _internalForTests,
  type SdrLeadInput,
  type SubgraphDeps,
} from "../nodes/sdr-outreach-subgraph";

const { qaCheck, parseDrafterJson } = _internalForTests;

const VALID_BODY = "Hi Alice, noticed Acme is scaling SaaS at 50-200 headcount and rolling out new product lines. We help teams at your stage tighten SDR pipeline without adding reps. Worth a 15-min call next week?";

function lead(overrides: Partial<SdrLeadInput> = {}): SdrLeadInput {
  return {
    orgId: "org_1",
    graphRunId: "graph_1",
    personId: "p1",
    email: "alice@acme.io",
    firstName: "Alice",
    lastName: "Smith",
    title: "VP Sales",
    companyName: "Acme",
    companyDomain: "acme.io",
    ...overrides,
  };
}

function mockDeps(
  overrides: { drafter?: SubgraphDeps["drafter"]; recordDryRun?: ReturnType<typeof vi.fn> } = {},
): SubgraphDeps & { _recorded: ReturnType<typeof vi.fn> } {
  const recordDryRun = overrides.recordDryRun
    ?? vi.fn().mockResolvedValue({ id: "art_test" });
  return {
    prisma: {
      company: {
        findFirst: vi.fn().mockResolvedValue({
          id: "co_test",
          name: "Acme",
          domain: "acme.io",
          employeeRange: "50-200",
          industry: "SaaS",
          country: null,
          city: null,
          fundingStage: null,
          techStack: [],
          intentSignals: [],
        }),
      },
      person: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      evidenceEvent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      leadScore: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as SubgraphDeps["prisma"],
    llm: {
      chat: vi.fn(),
    } as unknown as SubgraphDeps["llm"],
    outreachArtifacts: {
      recordDryRun,
    } as unknown as SubgraphDeps["outreachArtifacts"],
    evidenceLedger: {
      leadSourced: vi.fn().mockResolvedValue(undefined),
      leadScored: vi.fn().mockResolvedValue(undefined),
      messageDrafted: vi.fn().mockResolvedValue(undefined),
      qaPass: vi.fn().mockResolvedValue(undefined),
      qaFail: vi.fn().mockResolvedValue(undefined),
      approvalRequested: vi.fn().mockResolvedValue(undefined),
      approvalGranted: vi.fn().mockResolvedValue(undefined),
      approvalDenied: vi.fn().mockResolvedValue(undefined),
      artifactPersisted: vi.fn().mockResolvedValue(undefined),
    } as unknown as SubgraphDeps["evidenceLedger"],
    drafter: overrides.drafter,
    _recorded: recordDryRun,
  };
}

describe("qaCheck", () => {
  it("returns no issues for a well-formed message", () => {
    expect(qaCheck("Quick question about Acme", VALID_BODY, null)).toEqual([]);
  });

  it("flags empty subject", () => {
    expect(qaCheck("", VALID_BODY, null)).toContain("empty_subject");
  });

  it("flags body too short", () => {
    const issues = qaCheck("Subject", "hi", null);
    expect(issues.some((i) => i.startsWith("body_too_short"))).toBe(true);
  });

  it("flags placeholder leaks", () => {
    const issues = qaCheck("Hello {{firstName}}", VALID_BODY, null);
    expect(issues.some((i) => i.includes("placeholder_leak"))).toBe(true);
  });

  it("flags placeholder leaks in the body too", () => {
    const issues = qaCheck("Subject", `${VALID_BODY} TODO finish this`, null);
    expect(issues.some((i) => i.includes("TODO"))).toBe(true);
  });

  it("flags subject too long", () => {
    const issues = qaCheck("x".repeat(200), VALID_BODY, null);
    expect(issues.some((i) => i.startsWith("subject_too_long"))).toBe(true);
  });

  it("collapses to a single refusal issue when the drafter refused", () => {
    const issues = qaCheck(
      "",
      "",
      { reason: "insufficient_grounding", missing: ["recent_hire"] },
    );
    expect(issues).toEqual(["refusal:insufficient_grounding"]);
  });
});

describe("parseDrafterJson", () => {
  it("parses raw JSON into the new DrafterOutput shape", () => {
    expect(
      parseDrafterJson(
        '{"subject":"S","body":"B","refusal":null,"groundedness_self_check":{"cited_fact_ids":["F1"],"unsupported_claims":[]}}',
      ),
    ).toEqual({
      subject: "S",
      body: "B",
      refusal: null,
      groundednessSelfCheck: { citedFactIds: ["F1"], unsupportedClaims: [] },
    });
  });

  it("strips ```json fences", () => {
    expect(parseDrafterJson('```json\n{"subject":"S","body":"B"}\n```')).toEqual({
      subject: "S",
      body: "B",
      refusal: null,
      groundednessSelfCheck: null,
    });
  });

  it("returns the empty result on parse failure", () => {
    expect(parseDrafterJson("not json at all")).toEqual({
      subject: "",
      body: "",
      refusal: null,
      groundednessSelfCheck: null,
    });
  });

  it("coerces non-string fields to empty", () => {
    expect(parseDrafterJson('{"subject":42,"body":null}')).toEqual({
      subject: "",
      body: "",
      refusal: null,
      groundednessSelfCheck: null,
    });
  });

  it("parses a refusal envelope", () => {
    const out = parseDrafterJson(
      '{"subject":null,"body":null,"refusal":{"reason":"insufficient_grounding","missing":["recent_hire","funding_event"]},"groundedness_self_check":{"cited_fact_ids":[],"unsupported_claims":[]}}',
    );
    expect(out.refusal).toEqual({
      reason: "insufficient_grounding",
      missing: ["recent_hire", "funding_event"],
    });
    expect(out.subject).toBe("");
    expect(out.body).toBe("");
  });
});

function draft(subject: string, body: string) {
  return { subject, body, refusal: null, groundednessSelfCheck: null };
}

describe("SDR outreach subgraph", () => {
  it("produces an artifact on a clean first draft", async () => {
    const deps = mockDeps({
      drafter: async () => draft("Quick question about Acme", VALID_BODY),
    });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(result.artifactId).toBe("art_test");
    expect(result.qaIssues).toEqual([]);
    expect(result.draftAttempts).toBe(1);
    expect(deps._recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        graphRunId: "graph_1",
        toolName: "send_email",
      }),
    );
    const recordedArgs = deps._recorded.mock.calls[0][0].toolArgs;
    expect(recordedArgs.subject).toBe("Quick question about Acme");
    expect(recordedArgs.qaIssues).toEqual([]);
  });

  it("retries the draft when QA flags issues, then succeeds", async () => {
    let attempt = 0;
    const drafter = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return draft("Hello {{firstName}}", VALID_BODY);
      }
      return draft("Hello Alice", VALID_BODY);
    });

    const deps = mockDeps({ drafter });
    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(result.draftAttempts).toBe(2);
    expect(result.qaIssues).toEqual([]);
    expect(result.subject).toBe("Hello Alice");
    expect(deps._recorded).toHaveBeenCalledTimes(1);
  });

  it("stops after MAX_DRAFT_ATTEMPTS and persists artifact with issues attached", async () => {
    const drafter = vi
      .fn()
      .mockResolvedValue(draft("Hello {{firstName}}", VALID_BODY));

    const deps = mockDeps({ drafter });
    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(result.draftAttempts).toBe(2);
    expect(result.qaIssues.length).toBeGreaterThan(0);
    expect(result.qaIssues.some((i) => i.includes("placeholder_leak"))).toBe(true);
    // Even when QA fails, we still persist the artifact so a human can
    // see what was attempted.
    expect(deps._recorded).toHaveBeenCalledTimes(1);
    const recordedArgs = deps._recorded.mock.calls[0][0].toolArgs;
    expect(recordedArgs.qaIssues).toEqual(expect.arrayContaining([...result.qaIssues]));
  });

  it("does not call the real LLM when a drafter override is supplied", async () => {
    const drafter = vi.fn().mockResolvedValue(draft("Subject here", VALID_BODY));
    const deps = mockDeps({ drafter });

    await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).toHaveBeenCalled();
    expect(deps.llm.chat).not.toHaveBeenCalled();
  });

  it("propagates graphRunId from the input lead to the artifact", async () => {
    const drafter = vi.fn().mockResolvedValue(draft("Subject here", VALID_BODY));
    const deps = mockDeps({ drafter });

    await runSdrOutreachSubgraph(deps, lead({ graphRunId: "graph_xyz" }));

    expect(deps._recorded).toHaveBeenCalledWith(
      expect.objectContaining({ graphRunId: "graph_xyz" }),
    );
  });

  it("survives drafter failure without throwing — produces empty draft", async () => {
    const drafter = vi.fn().mockRejectedValue(new Error("LLM down"));
    const deps = mockDeps({ drafter });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(result.subject).toBe("");
    expect(result.body).toBe("");
    expect(result.qaIssues.length).toBeGreaterThan(0);
    // Artifact still gets recorded so the human reviewer sees the failure.
    expect(deps._recorded).toHaveBeenCalledTimes(1);
  });

  it("routes a refusal straight to human review without retrying", async () => {
    // Refusal must not be retried — retrying invites the model to fabricate
    // its way out. Drafter is invoked exactly once and the refusal envelope
    // is preserved on the artifact for the reviewer.
    const drafter = vi.fn().mockResolvedValue({
      subject: "",
      body: "",
      refusal: { reason: "insufficient_grounding", missing: ["recent_hire"] },
      groundednessSelfCheck: { citedFactIds: [], unsupportedClaims: [] },
    });
    const deps = mockDeps({ drafter });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).toHaveBeenCalledTimes(1);
    expect(result.refusal?.reason).toBe("insufficient_grounding");
    expect(result.qaIssues).toEqual(["refusal:insufficient_grounding"]);
    expect(deps._recorded).toHaveBeenCalledTimes(1);
    const recordedArgs = deps._recorded.mock.calls[0][0].toolArgs;
    expect(recordedArgs.refusal).toEqual({
      reason: "insufficient_grounding",
      missing: ["recent_hire"],
    });
  });

  it("attaches brief facts and groundedness_self_check to the artifact payload", async () => {
    const drafter = vi.fn().mockResolvedValue({
      subject: "Subject here",
      body: VALID_BODY,
      refusal: null,
      groundednessSelfCheck: {
        citedFactIds: ["F1", "P1"],
        unsupportedClaims: [],
      },
    });
    const deps = mockDeps({ drafter });

    await runSdrOutreachSubgraph(deps, lead());

    const recordedArgs = deps._recorded.mock.calls[0][0].toolArgs;
    expect(Array.isArray(recordedArgs.brief_facts)).toBe(true);
    expect(recordedArgs.brief_facts.length).toBeGreaterThan(0);
    expect(recordedArgs.brief_facts[0]).toHaveProperty("id");
    expect(recordedArgs.brief_facts[0]).toHaveProperty("source");
    expect(recordedArgs.groundedness_self_check.citedFactIds).toEqual(["F1", "P1"]);
    expect(Array.isArray(recordedArgs.brief_do_not_claim)).toBe(true);
  });
});

describe("SDR subgraph compiled shape", () => {
  it("compiles without errors", () => {
    const deps = mockDeps();
    const compiled = buildSdrOutreachSubgraph(deps).compile();
    expect(compiled).toBeDefined();
  });
});
