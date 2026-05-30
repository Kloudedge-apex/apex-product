import { describe, it, expect, vi } from "vitest";
import { EvaluatorRunnerService } from "../evaluator-runner.service";
import { EvaluatorTargetType } from "@prisma/client";

function makeEvaluator(key: string, score = 1) {
  return {
    key,
    evaluate: vi.fn(async () => ({ key, score, value: score >= 0.5 ? "ok" : "bad", comment: "note" })),
  };
}

describe("EvaluatorRunnerService", () => {
  it("records EvaluatorRun with expected shape (org + target + feedback id) and never throws", async () => {
    const langsmith = {
      createFeedback: vi.fn(async () => "fb_123"),
    };

    const evaluatorFacts = {
      recordEvaluatorRun: vi.fn(async () => {}),
    };

    const runner = new EvaluatorRunnerService(
      langsmith as any,
      evaluatorFacts as any,
      makeEvaluator("pii_leakage") as any,
      makeEvaluator("prompt_injection") as any,
      makeEvaluator("toxicity") as any,
      makeEvaluator("bias_fairness") as any,
      makeEvaluator("hallucination") as any,
      makeEvaluator("correctness") as any,
      makeEvaluator("tool_use_correctness") as any,
      makeEvaluator("boilerplate") as any,
      makeEvaluator("ai_tell") as any,
      makeEvaluator("citation_coverage") as any,
    );

    await expect(
      runner.run({
        runId: "ls_run_1",
        model: "mock",
        inputs: { ok: true },
        outputs: { body: "hi" },
        metadata: { org_id: "org_a", outreach_artifact_id: "artifact_1" },
        tags: ["draft_message"],
        agent: "sdr_agent.draft_message",
        node: "sdr_outreach.draft_message",
      }),
    ).resolves.toBeUndefined();

    expect(langsmith.createFeedback).toHaveBeenCalled();
    expect(evaluatorFacts.recordEvaluatorRun).toHaveBeenCalled();
    const call = (evaluatorFacts.recordEvaluatorRun as any).mock.calls[0][0];
    expect(call.orgId).toBe("org_a");
    expect(call.targetType).toBe(EvaluatorTargetType.ARTIFACT);
    expect(call.targetId).toBe("artifact_1");
    expect(call.langsmithFeedbackId).toBe("fb_123");
    expect(typeof call.latencyMs).toBe("number");
  });

  it("swallows persistence promise rejections (no unhandled)", async () => {
    const langsmith = { createFeedback: vi.fn(async () => null) };
    const evaluatorFacts = {
      recordEvaluatorRun: vi.fn(async () => {
        throw new Error("persist fail");
      }),
    };

    const runner = new EvaluatorRunnerService(
      langsmith as any,
      evaluatorFacts as any,
      makeEvaluator("pii_leakage") as any,
      makeEvaluator("prompt_injection") as any,
      makeEvaluator("toxicity") as any,
      makeEvaluator("bias_fairness") as any,
      makeEvaluator("hallucination") as any,
      makeEvaluator("correctness") as any,
      makeEvaluator("tool_use_correctness") as any,
      makeEvaluator("boilerplate") as any,
      makeEvaluator("ai_tell") as any,
      makeEvaluator("citation_coverage") as any,
    );

    await expect(
      runner.run({
        runId: "ls_run_2",
        model: "mock",
        inputs: {},
        outputs: {},
        metadata: { org_id: "org_a" },
      } as any),
    ).resolves.toBeUndefined();
  });
});

