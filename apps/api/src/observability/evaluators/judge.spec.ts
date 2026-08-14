import { describe, it, expect, vi } from "vitest";
import { callJudge } from "./judge";
import type { LLMService } from "../../runtime/llm.service";

/**
 * Pins the contract that the judge model is resolved from
 * LANGSMITH_JUDGE_MODEL when the caller doesn't pass `args.model`. Judge is
 * intentionally system-level (not template-driven), so the env override is
 * the only knob ops have for tuning evaluator cost/quality.
 */
describe("callJudge model resolution", () => {
  function makeLlmStub() {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({ score: 0.5, label: "ok", rationale: "" }),
      tokensUsed: 10,
      model: "stub",
      cost: 0,
    });
    return { llm: { chat } as unknown as LLMService, chat };
  }

  it("uses args.model when caller specifies it (highest priority)", async () => {
    const { llm, chat } = makeLlmStub();
    await callJudge(llm, {
      rubricName: "pii",
      systemPrompt: "s",
      userPrompt: "u",
      model: "custom-judge-model",
    });
    expect(chat.mock.calls[0][1].model).toBe("custom-judge-model");
  });

  it("charges a tenant-attributed judge call to the originating org", async () => {
    const { llm, chat } = makeLlmStub();
    await callJudge(llm, {
      rubricName: "toxicity",
      systemPrompt: "s",
      userPrompt: "u",
      orgId: "org_test",
    });
    expect(chat.mock.calls[0][1]).toMatchObject({
      orgId: "org_test",
      metadata: { org_id: "org_test" },
    });
  });

  it("falls back to LANGSMITH_JUDGE_MODEL env when args.model is undefined", async () => {
    const prev = process.env.LANGSMITH_JUDGE_MODEL;
    process.env.LANGSMITH_JUDGE_MODEL = "judge-via-env";
    try {
      const { llm, chat } = makeLlmStub();
      await callJudge(llm, { rubricName: "pii", systemPrompt: "s", userPrompt: "u" });
      expect(chat.mock.calls[0][1].model).toBe("judge-via-env");
    } finally {
      if (prev === undefined) delete process.env.LANGSMITH_JUDGE_MODEL;
      else process.env.LANGSMITH_JUDGE_MODEL = prev;
    }
  });

  it("falls back to hardcoded gpt-4o-mini when both args.model and env are unset", async () => {
    const prev = process.env.LANGSMITH_JUDGE_MODEL;
    delete process.env.LANGSMITH_JUDGE_MODEL;
    try {
      const { llm, chat } = makeLlmStub();
      await callJudge(llm, { rubricName: "pii", systemPrompt: "s", userPrompt: "u" });
      expect(chat.mock.calls[0][1].model).toBe("gpt-4o-mini");
    } finally {
      if (prev !== undefined) process.env.LANGSMITH_JUDGE_MODEL = prev;
    }
  });
});
