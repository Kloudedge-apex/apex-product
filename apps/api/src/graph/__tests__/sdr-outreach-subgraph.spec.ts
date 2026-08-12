import { describe, it, expect, vi } from "vitest";
import {
  buildSdrOutreachSubgraph,
  runSdrOutreachSubgraph,
  _internalForTests,
  type BriefFact,
  type SdrLeadInput,
  type SubgraphDeps,
} from "../nodes/sdr-outreach-subgraph";

const { qaCheck, parseDrafterJson, SDR_DRAFT_SYSTEM_PROMPT } = _internalForTests;

describe("SDR draft system prompt", () => {
  it("uses a tenant-neutral role rather than a legacy product identity", () => {
    expect(SDR_DRAFT_SYSTEM_PROMPT).toContain("sender's organization");
    expect(SDR_DRAFT_SYSTEM_PROMPT).not.toMatch(/Apex SDR|Nikxius/i);
  });
});

const VALID_BODY = "Hi Alice, noticed Acme is scaling SaaS at 50-200 headcount and rolling out new product lines. We help teams at your stage tighten SDR pipeline without adding reps. Worth a 15-min call next week?";

// Inside the press_mention freshness window (90d) so the default brief grounds.
const FRESH_SIGNAL_DATE = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

/**
 * A fresh, dated, sourced press_mention evidence event. mockDeps returns it by
 * default so `hasGroundingSignal` is true and the brief carries an S1 fact —
 * the in-code evidence gate (audit B3) would otherwise refuse before the
 * drafter runs, making every drafter-behavior test vacuous.
 */
function freshEvidenceEvent() {
  return {
    kind: "press_mention",
    payload: {
      date: FRESH_SIGNAL_DATE,
      source: "https://news.example.com/acme-raises",
      outlet: "news.example.com",
      headline: "Acme raises $20M",
      confidence: 0.6,
    },
    createdAt: new Date(),
  };
}

// Brief-fact fixture for qaCheck unit tests: one firmographic + one dated signal.
const BRIEF_FACTS: readonly BriefFact[] = [
  {
    id: "F1",
    category: "firmographic",
    source: "company.registry",
    text: "Company: Acme (acme.io); industry: SaaS.",
  },
  {
    id: "S1",
    category: "signal",
    source: "https://news.example.com/acme-raises",
    text: 'Mentioned in news.example.com: "Acme raises $20M".',
    date: FRESH_SIGNAL_DATE,
  },
];

const GROUNDED_SELF_CHECK = { citedFactIds: ["S1"], unsupportedClaims: [] };

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
  overrides: {
    drafter?: SubgraphDeps["drafter"];
    recordDryRun?: ReturnType<typeof vi.fn>;
    /** Evidence events the brief reads. Defaults to one fresh grounded signal; pass [] to exercise the ungrounded gate. */
    evidenceEvents?: unknown[];
  } = {},
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
        findMany: vi.fn().mockResolvedValue(overrides.evidenceEvents ?? [freshEvidenceEvent()]),
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
  it("returns no issues for a well-formed, grounded message", () => {
    expect(
      qaCheck("Quick question about Acme", VALID_BODY, null, GROUNDED_SELF_CHECK, BRIEF_FACTS),
    ).toEqual([]);
  });

  it("flags empty subject", () => {
    expect(qaCheck("", VALID_BODY, null, GROUNDED_SELF_CHECK, BRIEF_FACTS)).toContain(
      "empty_subject",
    );
  });

  it("flags body too short", () => {
    const issues = qaCheck("Subject", "hi", null, GROUNDED_SELF_CHECK, BRIEF_FACTS);
    expect(issues.some((i) => i.startsWith("body_too_short"))).toBe(true);
  });

  it("flags placeholder leaks", () => {
    const issues = qaCheck("Hello {{firstName}}", VALID_BODY, null, GROUNDED_SELF_CHECK, BRIEF_FACTS);
    expect(issues.some((i) => i.includes("placeholder_leak"))).toBe(true);
  });

  it("flags placeholder leaks in the body too", () => {
    const issues = qaCheck(
      "Subject",
      `${VALID_BODY} TODO finish this`,
      null,
      GROUNDED_SELF_CHECK,
      BRIEF_FACTS,
    );
    expect(issues.some((i) => i.includes("TODO"))).toBe(true);
  });

  it("flags subject too long", () => {
    const issues = qaCheck("x".repeat(200), VALID_BODY, null, GROUNDED_SELF_CHECK, BRIEF_FACTS);
    expect(issues.some((i) => i.startsWith("subject_too_long"))).toBe(true);
  });

  it("collapses to a single refusal issue when the drafter refused", () => {
    const issues = qaCheck(
      "",
      "",
      { reason: "insufficient_grounding", missing: ["recent_hire"] },
      null,
      BRIEF_FACTS,
    );
    expect(issues).toEqual(["refusal:insufficient_grounding"]);
  });

  // ── Citation gate (audit B3) ─────────────────────────────────────────────

  it("flags no_cited_facts when the self-check cites nothing", () => {
    const issues = qaCheck(
      "Quick question about Acme",
      VALID_BODY,
      null,
      { citedFactIds: [], unsupportedClaims: [] },
      BRIEF_FACTS,
    );
    expect(issues).toContain("no_cited_facts");
  });

  it("flags no_cited_facts when the self-check is missing entirely (null)", () => {
    const issues = qaCheck("Quick question about Acme", VALID_BODY, null, null, BRIEF_FACTS);
    expect(issues).toContain("no_cited_facts");
  });

  it("flags every cited fact id not present in the brief", () => {
    const issues = qaCheck(
      "Quick question about Acme",
      VALID_BODY,
      null,
      { citedFactIds: ["S1", "S9", "F7"], unsupportedClaims: [] },
      BRIEF_FACTS,
    );
    expect(issues).toContain("unknown_fact_id(S9)");
    expect(issues).toContain("unknown_fact_id(F7)");
    expect(issues.some((i) => i.includes("S1)"))).toBe(false); // S1 is real — never flagged
  });

  it("flags unsupported_claims when the model self-reports ungrounded sentences", () => {
    const issues = qaCheck(
      "Quick question about Acme",
      VALID_BODY,
      null,
      { citedFactIds: ["S1"], unsupportedClaims: ["Acme runs on Kubernetes"] },
      BRIEF_FACTS,
    );
    expect(issues).toContain("unsupported_claims(1)");
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

// Fixture drafts cite the S1 signal the default mockDeps brief always contains,
// so they pass the citation gate and each test stays about its own concern.
function draft(subject: string, body: string) {
  return {
    subject,
    body,
    refusal: null,
    groundednessSelfCheck: { citedFactIds: ["S1"], unsupportedClaims: [] },
  };
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

describe("SDR outreach subgraph — evidence gate (audit B3)", () => {
  it("hard-gates an ungrounded brief IN CODE: refuses without ever invoking the drafter", async () => {
    // No evidence events → hasGroundingSignal=false. The refusal must come
    // from the draft node itself, deterministically — the LLM (and its
    // <refusal_protocol> prompt) must never even be consulted.
    const drafter = vi.fn();
    const deps = mockDeps({ drafter, evidenceEvents: [] });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).not.toHaveBeenCalled();
    expect(deps.llm.chat).not.toHaveBeenCalled();
    expect(result.refusal).toEqual({ reason: "insufficient_grounding", missing: ["signals"] });
    expect(result.qaIssues).toEqual(["refusal:insufficient_grounding"]);
    expect(result.subject).toBe("");
    expect(result.body).toBe("");
    // Refusals are a first-class outcome: exactly one attempt, no retry, and
    // the artifact is still persisted so the reviewer sees the refusal.
    expect(result.draftAttempts).toBe(1);
    expect(deps._recorded).toHaveBeenCalledTimes(1);
    const recordedArgs = deps._recorded.mock.calls[0][0].toolArgs;
    expect(recordedArgs.refusal).toEqual({
      reason: "insufficient_grounding",
      missing: ["signals"],
    });
  });

  it("hard-gates a stale-only brief the same way (freshness feeds the gate)", async () => {
    // A years-old press mention is excluded by isFresh at brief assembly, so
    // the brief is ungrounded and the in-code gate refuses pre-LLM.
    const drafter = vi.fn();
    const deps = mockDeps({
      drafter,
      evidenceEvents: [
        {
          kind: "press_mention",
          payload: { date: "2024-01-01", source: "https://news.example.com/old", confidence: 0.6 },
          createdAt: new Date(),
        },
      ],
    });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).not.toHaveBeenCalled();
    expect(result.refusal).toEqual({ reason: "insufficient_grounding", missing: ["signals"] });
  });

  it("fails QA and retries when the draft cites a fact id not in the brief", async () => {
    const drafter = vi.fn().mockResolvedValue({
      subject: "Subject here",
      body: VALID_BODY,
      refusal: null,
      groundednessSelfCheck: { citedFactIds: ["S9"], unsupportedClaims: [] },
    });
    const deps = mockDeps({ drafter });

    const result = await runSdrOutreachSubgraph(deps, lead());

    // Citation issues retry like any other QA issue, then land on review.
    expect(drafter).toHaveBeenCalledTimes(2);
    expect(result.qaIssues).toContain("unknown_fact_id(S9)");
    expect(deps._recorded).toHaveBeenCalledTimes(1);
  });

  it("fails QA when the drafter omits the groundedness self-check entirely", async () => {
    const drafter = vi.fn().mockResolvedValue({
      subject: "Subject here",
      body: VALID_BODY,
      refusal: null,
      groundednessSelfCheck: null,
    });
    const deps = mockDeps({ drafter });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(result.qaIssues).toContain("no_cited_facts");
    expect(deps._recorded).toHaveBeenCalledTimes(1);
  });

  it("fails QA when the draft self-reports unsupported claims", async () => {
    const drafter = vi.fn().mockResolvedValue({
      subject: "Subject here",
      body: VALID_BODY,
      refusal: null,
      groundednessSelfCheck: {
        citedFactIds: ["S1"],
        unsupportedClaims: ["Acme runs on Kubernetes", "Alice used to work at Google"],
      },
    });
    const deps = mockDeps({ drafter });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(result.qaIssues).toContain("unsupported_claims(2)");
  });

  it("recovers when the retry fixes its citations", async () => {
    let attempt = 0;
    const drafter = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          subject: "Subject here",
          body: VALID_BODY,
          refusal: null,
          groundednessSelfCheck: { citedFactIds: [], unsupportedClaims: [] },
        };
      }
      return draft("Grounded subject", VALID_BODY);
    });
    const deps = mockDeps({ drafter });

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(result.draftAttempts).toBe(2);
    expect(result.qaIssues).toEqual([]);
    expect(result.subject).toBe("Grounded subject");
  });
});

describe("SDR subgraph compiled shape", () => {
  it("compiles without errors", () => {
    const deps = mockDeps();
    const compiled = buildSdrOutreachSubgraph(deps).compile();
    expect(compiled).toBeDefined();
  });
});
