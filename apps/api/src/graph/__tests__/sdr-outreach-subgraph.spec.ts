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
          name: "Acme",
          domain: "acme.io",
          employeeRange: "50-200",
          industry: "SaaS",
        }),
      },
    } as unknown as SubgraphDeps["prisma"],
    llm: {
      chat: vi.fn(),
    } as unknown as SubgraphDeps["llm"],
    outreachArtifacts: {
      recordDryRun,
    } as unknown as SubgraphDeps["outreachArtifacts"],
    drafter: overrides.drafter,
    _recorded: recordDryRun,
  };
}

describe("qaCheck", () => {
  it("returns no issues for a well-formed message", () => {
    expect(qaCheck("Quick question about Acme", VALID_BODY)).toEqual([]);
  });

  it("flags empty subject", () => {
    expect(qaCheck("", VALID_BODY)).toContain("empty_subject");
  });

  it("flags body too short", () => {
    const issues = qaCheck("Subject", "hi");
    expect(issues.some((i) => i.startsWith("body_too_short"))).toBe(true);
  });

  it("flags placeholder leaks", () => {
    const issues = qaCheck("Hello {{firstName}}", VALID_BODY);
    expect(issues.some((i) => i.includes("placeholder_leak"))).toBe(true);
  });

  it("flags placeholder leaks in the body too", () => {
    const issues = qaCheck("Subject", `${VALID_BODY} TODO finish this`);
    expect(issues.some((i) => i.includes("TODO"))).toBe(true);
  });

  it("flags subject too long", () => {
    const issues = qaCheck("x".repeat(200), VALID_BODY);
    expect(issues.some((i) => i.startsWith("subject_too_long"))).toBe(true);
  });
});

describe("parseDrafterJson", () => {
  it("parses raw JSON", () => {
    expect(parseDrafterJson('{"subject":"S","body":"B"}')).toEqual({ subject: "S", body: "B" });
  });

  it("strips ```json fences", () => {
    expect(parseDrafterJson('```json\n{"subject":"S","body":"B"}\n```')).toEqual({
      subject: "S",
      body: "B",
    });
  });

  it("returns empty strings on parse failure", () => {
    expect(parseDrafterJson("not json at all")).toEqual({ subject: "", body: "" });
  });

  it("coerces non-string fields to empty", () => {
    expect(parseDrafterJson('{"subject":42,"body":null}')).toEqual({ subject: "", body: "" });
  });
});

describe("SDR outreach subgraph", () => {
  it("produces an artifact on a clean first draft", async () => {
    const deps = mockDeps({
      drafter: async () => ({ subject: "Quick question about Acme", body: VALID_BODY }),
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
        return { subject: "Hello {{firstName}}", body: VALID_BODY };
      }
      return { subject: "Hello Alice", body: VALID_BODY };
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
      .mockResolvedValue({ subject: "Hello {{firstName}}", body: VALID_BODY });

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
    const drafter = vi.fn().mockResolvedValue({ subject: "S", body: VALID_BODY });
    const deps = mockDeps({ drafter });

    await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).toHaveBeenCalled();
    expect(deps.llm.chat).not.toHaveBeenCalled();
  });

  it("propagates graphRunId from the input lead to the artifact", async () => {
    const drafter = vi.fn().mockResolvedValue({ subject: "S", body: VALID_BODY });
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
});

describe("SDR subgraph compiled shape", () => {
  it("compiles without errors", () => {
    const deps = mockDeps();
    const compiled = buildSdrOutreachSubgraph(deps).compile();
    expect(compiled).toBeDefined();
  });
});
