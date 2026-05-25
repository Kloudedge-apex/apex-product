import { describe, it, expect } from "vitest";
import { BoilerplateEvaluator } from "../boilerplate.evaluator";
import { AiTellEvaluator } from "../ai-tell.evaluator";
import { CitationCoverageEvaluator } from "../citation-coverage.evaluator";
import { PiiLeakageEvaluator } from "../pii-leakage.evaluator";
import type { EvaluatorContext } from "../evaluator.interface";

function baseCtx(overrides: Partial<EvaluatorContext>): EvaluatorContext {
  return {
    runId: "run_test",
    model: "gpt-4o-mini",
    agent: "sdr_agent.draft_message",
    tags: ["draft_message"],
    inputs: {},
    outputs: {},
    ...overrides,
  };
}

describe("BoilerplateEvaluator", () => {
  const ev = new BoilerplateEvaluator();

  it("scores 1.0 on clean copy", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { body: "Saw Lumen rolled out multi-entity forecasting. Worth a 15-min chat?" } }),
    );
    expect(r?.score).toBe(1);
    expect(r?.value).toBe("clean");
  });

  it("flags 'I hope this finds you well'", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { body: "Hi Priya, I hope this finds you well. We help companies like yours." } }),
    );
    expect(r).not.toBeNull();
    expect(r!.score).toBeLessThan(1);
    expect(r!.value).not.toBe("clean");
  });

  it("flags unresolved template variables", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { body: "Hi {{firstName}}, quick question about Lumen." } }),
    );
    expect(r!.score).toBeLessThan(1);
  });

  it("only fires on sdr_agent or content_writer", () => {
    expect(ev.appliesTo(baseCtx({ agent: "supervisor", tags: [] }))).toBe(false);
    expect(ev.appliesTo(baseCtx({ agent: "sdr_agent.draft_message" }))).toBe(true);
  });
});

describe("AiTellEvaluator", () => {
  const ev = new AiTellEvaluator();

  it("scores 1.0 when no AI tells present", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { body: "Saw the Series B. Wondering how the new SDR will source mid-market accounts." } }),
    );
    expect(r?.score).toBe(1);
  });

  it("flags em-dashes", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { body: "We help teams unlock the potential — happy to chat." } }),
    );
    expect(r!.score).toBeLessThan(1);
  });

  it("flags 'leverage' and 'delve'", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { body: "We delve into your funnel to leverage growth opportunities." } }),
    );
    expect(r!.score).toBeLessThan(1);
    expect(r!.comment).toMatch(/leverage|delve/);
  });
});

describe("CitationCoverageEvaluator", () => {
  const ev = new CitationCoverageEvaluator();

  const briefInputs = [
    { role: "system", content: "system prompt" },
    {
      role: "user",
      content: `<brief>
  <firmographic>
    <fact id="F1" source="company.registry">Company: Lumen Treasury (lumentreasury.com), B2B Fintech, 51-100 employees.</fact>
  </firmographic>
  <signals>
    <fact id="S1" source="evidence_event.recent_hire" date="2026-05-18">Lumen Treasury posted a job for "Senior SDR" on LinkedIn.</fact>
    <fact id="S2" source="evidence_event.funding_event" date="2026-02-11">Raised $34M Series B led by Bessemer.</fact>
  </signals>
</brief>`,
    },
  ];

  it("returns 1.0 when fact-bearing sentences cite the right fact_id", async () => {
    const r = await ev.evaluate(
      baseCtx({
        inputs: briefInputs,
        outputs: {
          body: "Saw Lumen Treasury raised $34M Series B led by Bessemer. Worth a quick chat?",
          groundednessSelfCheck: { citedFactIds: ["S2"], unsupportedClaims: [] },
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThanOrEqual(0.5);
  });

  it("scores < 1 when a fact-bearing claim is uncited", async () => {
    const r = await ev.evaluate(
      baseCtx({
        inputs: briefInputs,
        outputs: {
          body: "Saw Lumen raised $34M Series B. Also noticed they're hiring SDRs. Worth a chat?",
          groundednessSelfCheck: { citedFactIds: [], unsupportedClaims: [] },
        },
      }),
    );
    expect(r!.score).toBeLessThan(1);
    expect(r!.value).toBe("uncited");
  });

  it("returns null when brief XML can't be found in inputs", async () => {
    const r = await ev.evaluate(
      baseCtx({
        inputs: "no brief here",
        outputs: { body: "Saw the recent Series B at Lumen. Worth a chat?", groundednessSelfCheck: { citedFactIds: [] } },
      }),
    );
    expect(r).toBeNull();
  });

  it("returns 1.0 'no_claims' when the draft has no fact-bearing sentences", async () => {
    const r = await ev.evaluate(
      baseCtx({
        inputs: briefInputs,
        outputs: {
          body: "Hi Priya, hope you have a great week ahead. Open to a quick chat?",
          groundednessSelfCheck: { citedFactIds: [], unsupportedClaims: [] },
        },
      }),
    );
    expect(r?.score).toBe(1);
    expect(r?.value).toBe("no_claims");
  });
});

describe("PiiLeakageEvaluator — tightened phone regex", () => {
  const ev = new PiiLeakageEvaluator();

  it("does NOT flag a 10-digit number that's clearly not a phone (e.g. price + ID)", async () => {
    const r = await ev.evaluate(
      baseCtx({
        outputs: {
          content:
            "Lumen Treasury raised $1500000000 in 2026 and now serves 1234567890 customers across multiple markets.",
        },
      }),
    );
    expect(r?.value).toBe("clean");
  });

  it("does NOT flag dates / years that look like digit runs", async () => {
    const r = await ev.evaluate(
      baseCtx({
        outputs: { content: "Founded 2020-01-15, Series A in 2022, Series B in 2024." },
      }),
    );
    expect(r?.value).toBe("clean");
  });

  it("DOES flag a strict NANP-formatted phone number", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { content: "Reach me anytime at (415) 555-0173 for details." } }),
    );
    expect(r?.value).toBe("moderate_leak");
    expect(r?.comment).toContain("phone");
  });

  it("DOES flag a 10-digit number when 'phone' context is nearby", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { content: "My phone is 4155550173 if you want to chat." } }),
    );
    expect(r?.value).toBe("moderate_leak");
  });

  it("does NOT flag a 10-digit number without phone-context tokens", async () => {
    const r = await ev.evaluate(
      baseCtx({ outputs: { content: "We've processed 4155550173 records this quarter." } }),
    );
    expect(r?.value).toBe("clean");
  });
});
