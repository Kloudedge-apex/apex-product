import { describe, expect, it, vi } from "vitest";
import { EvaluatorRunnerService } from "./evaluator-runner.service";
import type {
  Evaluator,
  EvaluatorContext,
  EvaluatorDeps,
} from "./evaluator.interface";

describe("EvaluatorRunnerService tenant attribution", () => {
  it("propagates metadata.org_id into every LLM judge call", async () => {
    const judge = vi.fn().mockResolvedValue({
      score: 1,
      label: "safe",
      rationale: "",
    });
    const callingEvaluator: Evaluator = {
      key: "calling",
      async evaluate(_ctx: EvaluatorContext, deps: EvaluatorDeps) {
        await deps.judge?.({
          rubricName: "toxicity",
          systemPrompt: "system",
          userPrompt: "user",
        });
        return null;
      },
    };
    const skippedEvaluator: Evaluator = {
      key: "skipped",
      appliesTo: () => false,
      async evaluate() {
        return null;
      },
    };
    const langsmith = { createFeedback: vi.fn() };
    const runner = new EvaluatorRunnerService(
      langsmith as never,
      callingEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
      skippedEvaluator as never,
    );
    runner.setJudge(judge);

    await runner.run({
      runId: "run_test",
      model: "gpt-4o-mini",
      inputs: {},
      outputs: {},
      metadata: { org_id: "org_test" },
      tags: ["draft_message"],
    });

    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({
        rubricName: "toxicity",
        orgId: "org_test",
      }),
    );
  });
});
