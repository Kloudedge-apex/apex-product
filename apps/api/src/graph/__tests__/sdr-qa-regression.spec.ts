import { describe, it, expect, vi } from "vitest";
import {
  _internalForTests,
  runSdrOutreachSubgraph,
  type BriefFact,
  type DrafterRefusal,
  type SdrLeadInput,
  type SubgraphDeps,
} from "../nodes/sdr-outreach-subgraph";

/**
 * Phase 2.5 regression: lock down the SDR quality gate. The existing
 * `sdr-outreach-subgraph.spec.ts` covers the happy path and a single
 * placeholder pattern. This file pins every placeholder string individually,
 * the exact length boundaries, and (audit B3) every citation-gate rule so a
 * future refactor of `qaCheck` cannot silently relax a check.
 */

const { qaCheck } = _internalForTests;

const VALID_SUBJECT = "Quick question about Acme growth";
const VALID_BODY =
  "Hi Alice, noticed Acme is scaling SaaS at 50-200 headcount and rolling out new product lines. We help teams at your stage tighten SDR pipeline without adding reps. Worth a 15-min call next week?";

// Inside the press_mention freshness window (90d) so the default brief grounds.
const FRESH_SIGNAL_DATE = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

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

// Placeholder/length pins call qaCheck through this wrapper with a clean
// citation context so each case stays about its own check, not the B3 gate.
function check(subject: string, body: string, refusal: DrafterRefusal | null = null): string[] {
  return qaCheck(subject, body, refusal, GROUNDED_SELF_CHECK, BRIEF_FACTS);
}

describe("qaCheck — placeholder leak patterns (each pattern locked individually)", () => {
  // Every entry in PLACEHOLDER_LEAKS inside sdr-outreach-subgraph.ts must
  // be caught. If anyone removes one from the list, the corresponding case
  // here will fail.
  const cases: ReadonlyArray<[string, string]> = [
    ["{{", "Hello {{ user }}, welcome to our product update. " + VALID_BODY],
    ["}}", "Hello user}} welcome to our product update. " + VALID_BODY],
    ["[FIRST_NAME]", "Hello [FIRST_NAME], " + VALID_BODY],
    ["[COMPANY]", `Quick note about [COMPANY] and their team. ${VALID_BODY}`],
    ["TODO", `${VALID_BODY} TODO add closing line`],
    ["<insert", `${VALID_BODY} <insert specific value here>`],
  ];

  it.each(cases)("flags %s anywhere in the message", (needle, body) => {
    const issues = check(VALID_SUBJECT, body);
    expect(
      issues.some((i) => i.includes("placeholder_leak") && i.includes(needle)),
    ).toBe(true);
  });

  it("flags multiple distinct placeholder leaks in a single message", () => {
    const issues = check(
      "Hello {{name}} at [COMPANY]",
      `${VALID_BODY} TODO finalise`,
    );
    const leaks = issues.filter((i) => i.includes("placeholder_leak"));
    expect(leaks.length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT flag legitimate punctuation that resembles placeholders", () => {
    // Single curly braces or angle brackets without the placeholder tokens
    // must not trigger a leak. Pin this so a regex tightening doesn't break
    // normal copy with quotations or formatting.
    const safeBody =
      "Hi Alice, our pricing tier is $99/month (per user, billed annually). " +
      "If that works, I can share the deck — happy to chat next week.";
    expect(check(VALID_SUBJECT, safeBody)).toEqual([]);
  });
});

describe("qaCheck — exact length boundaries", () => {
  it("body of exactly MIN_BODY_LEN (30) chars is allowed", () => {
    const body = "x".repeat(30);
    const issues = check(VALID_SUBJECT, body);
    expect(issues.some((i) => i.startsWith("body_too_short"))).toBe(false);
  });

  it("body of MIN_BODY_LEN - 1 (29) chars is rejected", () => {
    const body = "x".repeat(29);
    const issues = check(VALID_SUBJECT, body);
    expect(issues.some((i) => i.startsWith("body_too_short"))).toBe(true);
  });

  it("body of exactly MAX_BODY_LEN (2000) chars is allowed", () => {
    const body = "x".repeat(2000);
    const issues = check(VALID_SUBJECT, body);
    expect(issues.some((i) => i.startsWith("body_too_long"))).toBe(false);
  });

  it("body of MAX_BODY_LEN + 1 (2001) chars is rejected", () => {
    const body = "x".repeat(2001);
    const issues = check(VALID_SUBJECT, body);
    expect(issues.some((i) => i.startsWith("body_too_long"))).toBe(true);
  });

  it("subject of exactly MAX_SUBJECT_LEN (120) chars is allowed", () => {
    const subject = "x".repeat(120);
    const issues = check(subject, VALID_BODY);
    expect(issues.some((i) => i.startsWith("subject_too_long"))).toBe(false);
  });

  it("subject of MAX_SUBJECT_LEN + 1 (121) chars is rejected", () => {
    const subject = "x".repeat(121);
    const issues = check(subject, VALID_BODY);
    expect(issues.some((i) => i.startsWith("subject_too_long"))).toBe(true);
  });

  it("empty subject is flagged even when body is fine", () => {
    expect(check("", VALID_BODY)).toContain("empty_subject");
  });

  it("a clean subject + body passes every check", () => {
    expect(check(VALID_SUBJECT, VALID_BODY)).toEqual([]);
  });
});

describe("qaCheck — citation gate (audit B3, each rule locked individually)", () => {
  // The wedge sentence — "every email cites a real, dated trigger or refuses"
  // — is enforced HERE, not in the prompt. Relaxing any rule below reopens
  // the hallucination surface the keystone closed.

  it("empty cited_fact_ids fails with no_cited_facts", () => {
    const issues = qaCheck(
      VALID_SUBJECT,
      VALID_BODY,
      null,
      { citedFactIds: [], unsupportedClaims: [] },
      BRIEF_FACTS,
    );
    expect(issues).toContain("no_cited_facts");
  });

  it("a missing (null) self-check fails with no_cited_facts", () => {
    const issues = qaCheck(VALID_SUBJECT, VALID_BODY, null, null, BRIEF_FACTS);
    expect(issues).toContain("no_cited_facts");
  });

  it("each cited id not present in the brief is flagged individually", () => {
    const issues = qaCheck(
      VALID_SUBJECT,
      VALID_BODY,
      null,
      { citedFactIds: ["S1", "S9", "F7"], unsupportedClaims: [] },
      BRIEF_FACTS,
    );
    expect(issues).toContain("unknown_fact_id(S9)");
    expect(issues).toContain("unknown_fact_id(F7)");
    expect(issues.filter((i) => i.startsWith("unknown_fact_id"))).toHaveLength(2);
  });

  it("non-empty unsupported_claims fails with the exact count", () => {
    const issues = qaCheck(
      VALID_SUBJECT,
      VALID_BODY,
      null,
      { citedFactIds: ["S1"], unsupportedClaims: ["claim a", "claim b", "claim c"] },
      BRIEF_FACTS,
    );
    expect(issues).toContain("unsupported_claims(3)");
  });

  it("a fully grounded self-check passes the gate", () => {
    expect(
      qaCheck(VALID_SUBJECT, VALID_BODY, null, GROUNDED_SELF_CHECK, BRIEF_FACTS),
    ).toEqual([]);
  });

  it("a refusal short-circuits the citation gate — exactly one refusal issue, no citation noise", () => {
    const issues = qaCheck(
      "",
      "",
      { reason: "insufficient_grounding", missing: ["signals"] },
      null,
      BRIEF_FACTS,
    );
    expect(issues).toEqual(["refusal:insufficient_grounding"]);
  });
});

/**
 * A fresh, dated, sourced press_mention so the default brief grounds (S1).
 * Without it the in-code evidence gate (audit B3) refuses before the drafter
 * runs and the termination/safety tests below would be vacuous.
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

function mockDepsFor(drafter: SubgraphDeps["drafter"]): SubgraphDeps & {
  recordDryRun: ReturnType<typeof vi.fn>;
} {
  const recordDryRun = vi.fn().mockResolvedValue({ id: "art_regression" });
  return {
    prisma: {
      company: {
        findFirst: vi.fn().mockResolvedValue({
          id: "co_reg",
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
      person: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceEvent: { findMany: vi.fn().mockResolvedValue([freshEvidenceEvent()]) },
      leadScore: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as SubgraphDeps["prisma"],
    llm: { chat: vi.fn() } as unknown as SubgraphDeps["llm"],
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
    drafter,
    recordDryRun,
  };
}

function lead(overrides: Partial<SdrLeadInput> = {}): SdrLeadInput {
  return {
    orgId: "org_regression",
    graphRunId: "graph_regression",
    personId: "p_regression",
    email: "alice@acme.io",
    firstName: "Alice",
    lastName: "Smith",
    title: "VP Sales",
    companyName: "Acme",
    companyDomain: "acme.io",
    ...overrides,
  };
}

// Fixture drafts cite the S1 signal the mockDepsFor brief always contains, so
// they pass the citation gate and each test stays about its own concern.
function draft(subject: string, body: string) {
  return {
    subject,
    body,
    refusal: null,
    groundednessSelfCheck: { citedFactIds: ["S1"], unsupportedClaims: [] },
  };
}

describe("SDR subgraph — MAX_DRAFT_ATTEMPTS termination", () => {
  it("invokes drafter at most MAX_DRAFT_ATTEMPTS (2) times even when QA always fails", async () => {
    const drafter = vi
      .fn()
      .mockResolvedValue(draft("Hello {{firstName}}", VALID_BODY));
    const deps = mockDepsFor(drafter);

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).toHaveBeenCalledTimes(2);
    expect(result.draftAttempts).toBe(2);
    // The artifact is still persisted with issues attached so a human can
    // review what was attempted.
    expect(deps.recordDryRun).toHaveBeenCalledTimes(1);
  });

  it("invokes drafter exactly once when first draft passes QA", async () => {
    const drafter = vi.fn().mockResolvedValue(draft(VALID_SUBJECT, VALID_BODY));
    const deps = mockDepsFor(drafter);

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).toHaveBeenCalledTimes(1);
    expect(result.draftAttempts).toBe(1);
    expect(result.qaIssues).toEqual([]);
  });

  it("invokes drafter twice if first fails and second passes", async () => {
    let attempt = 0;
    const drafter = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return draft("Hi [COMPANY]", VALID_BODY);
      }
      return draft(VALID_SUBJECT, VALID_BODY);
    });
    const deps = mockDepsFor(drafter);

    const result = await runSdrOutreachSubgraph(deps, lead());

    expect(drafter).toHaveBeenCalledTimes(2);
    expect(result.draftAttempts).toBe(2);
    expect(result.qaIssues).toEqual([]);
  });

  it("redraft attempt receives the previous attempt's issues for context", async () => {
    let captured: { issues?: readonly string[] } | undefined;
    let attempt = 0;
    const drafter = vi.fn().mockImplementation(async (input) => {
      attempt += 1;
      if (attempt === 1) {
        return draft("Hello {{firstName}}", VALID_BODY);
      }
      captured = input.previousAttempt;
      return draft(VALID_SUBJECT, VALID_BODY);
    });
    const deps = mockDepsFor(drafter);

    await runSdrOutreachSubgraph(deps, lead());

    expect(captured).toBeDefined();
    expect(
      (captured?.issues ?? []).some((i) => i.includes("placeholder_leak")),
    ).toBe(true);
  });
});

describe("SDR subgraph — Phase 2.5 safety contract", () => {
  it("always routes through recordDryRun (never a direct send)", async () => {
    // The subgraph must persist via OutreachArtifactsService.recordDryRun —
    // never call an LLM tool or external send path. If a future refactor
    // wires up direct sending, this test catches it because recordDryRun
    // is the only persistence side-effect on `outreachArtifacts`.
    const drafter = vi.fn().mockResolvedValue(draft(VALID_SUBJECT, VALID_BODY));
    const deps = mockDepsFor(drafter);

    await runSdrOutreachSubgraph(deps, lead());

    expect(deps.recordDryRun).toHaveBeenCalledTimes(1);
    const call = deps.recordDryRun.mock.calls[0][0];
    expect(call.toolName).toBe("send_email");
    // No sentAt / sendReceiptId fields should leak into the dry-run payload.
    expect(call.toolArgs).not.toHaveProperty("sentAt");
    expect(call.toolArgs).not.toHaveProperty("sendReceiptId");
  });

  it("attaches qaIssues to the artifact payload so reviewers see the gate result", async () => {
    const drafter = vi.fn().mockResolvedValue(draft("Hi [COMPANY]", VALID_BODY));
    const deps = mockDepsFor(drafter);

    await runSdrOutreachSubgraph(deps, lead());

    const call = deps.recordDryRun.mock.calls[0][0];
    expect(Array.isArray(call.toolArgs.qaIssues)).toBe(true);
    expect(call.toolArgs.qaIssues.length).toBeGreaterThan(0);
  });
});
