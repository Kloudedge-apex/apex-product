import { describe, it, expect, vi } from "vitest";
import type { SubgraphDeps, SdrLeadInput } from "../nodes/sdr-outreach-subgraph";
import { runSdrOutreachSubgraph } from "../nodes/sdr-outreach-subgraph";

const VALID_BODY =
  "Hi Alice, noticed Acme is hiring SDRs and scaling pipeline. We help teams tighten outbound without adding headcount. Worth a 15-min look next week?";

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

function mockDeps(): SubgraphDeps {
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
      person: { findFirst: vi.fn().mockResolvedValue(null) },
      evidenceEvent: { findMany: vi.fn().mockResolvedValue([]) },
      leadScore: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as SubgraphDeps["prisma"],
    llm: {
      chat: vi.fn().mockResolvedValue({
        content:
          '{"subject":"Quick question about Acme","body":"' +
          VALID_BODY.replaceAll('"', '\\"') +
          '","refusal":null,"groundedness_self_check":{"cited_fact_ids":[],"unsupported_claims":[]}}',
        tokensUsed: 10,
        model: "gpt-4o-mini",
        cost: 0.001,
      }),
    } as unknown as SubgraphDeps["llm"],
    outreachArtifacts: {
      recordDryRun: vi.fn().mockResolvedValue({ id: "art_1" }),
    } as unknown as SubgraphDeps["outreachArtifacts"],
    evidenceLedger: {
      messageDrafted: vi.fn().mockResolvedValue(undefined),
      artifactPersisted: vi.fn().mockResolvedValue(undefined),
      artifactStatusTransition: vi.fn().mockResolvedValue(undefined),
      qaPass: vi.fn().mockResolvedValue(undefined),
      qaFail: vi.fn().mockResolvedValue(undefined),
    } as unknown as SubgraphDeps["evidenceLedger"],
  };
}

describe("graph LLM context", () => {
  it("threads orgId + graphRunId + nodeName through LLMService.chat options", async () => {
    const deps = mockDeps();

    await runSdrOutreachSubgraph(deps, lead());

    expect(deps.llm.chat).toHaveBeenCalledTimes(1);
    const options = (deps.llm.chat as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(options).toEqual(
      expect.objectContaining({
        orgId: "org_1",
        graphRunId: "graph_1",
        nodeName: "DraftGeneration",
        promptVersion: "v1",
        evalBundleVersion: "v1",
        leadId: "p1",
      }),
    );
  });
});

