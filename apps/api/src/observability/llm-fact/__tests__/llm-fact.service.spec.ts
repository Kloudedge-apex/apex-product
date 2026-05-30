import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmRequestStatus, Prisma } from "@prisma/client";
import { LlmFactService } from "../llm-fact.service";

describe("LlmFactService", () => {
  const createSpy = vi.fn().mockResolvedValue({ id: "fact_1" });
  const aggregateSpy = vi.fn().mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal(0) } });
  const ledgerSpy = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    createSpy.mockClear();
    aggregateSpy.mockClear();
    ledgerSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recordRequest writes prisma row with correct shape", async () => {
    const prisma = {
      llmRequestFact: {
        create: createSpy,
        aggregate: aggregateSpy,
      },
    } as unknown as { readonly llmRequestFact: { create: typeof createSpy; aggregate: typeof aggregateSpy } };

    const evidence = { llmRequestRecorded: ledgerSpy } as unknown as { llmRequestRecorded: typeof ledgerSpy };

    const svc = new LlmFactService(prisma as any, evidence as any);

    const requestedAt = new Date("2026-05-29T00:00:00Z");
    const completedAt = new Date("2026-05-29T00:00:01Z");

    await expect(
      svc.recordRequest({
        orgId: "org_1",
        campaignId: null,
        leadId: null,
        artifactId: null,
        graphRunId: "graph_1",
        nodeName: "node_1",
        promptVersion: "pv1",
        evalBundleVersion: "eb1",
        model: "gpt-4o-mini",
        provider: "openai",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        latencyMs: 1000,
        costUsd: 0.1234567,
        langsmithRunId: "run_1",
        status: LlmRequestStatus.OK,
        errorKind: null,
        requestedAt,
        completedAt,
      }),
    ).resolves.toBeUndefined();

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [args] = createSpy.mock.calls[0] ?? [];
    expect(args?.data?.orgId).toBe("org_1");
    expect(args?.data?.model).toBe("gpt-4o-mini");
    expect(args?.data?.inputTokens).toBe(10);
    expect(args?.data?.outputTokens).toBe(5);
    expect(args?.data?.cachedInputTokens).toBe(2);
    expect(args?.data?.latencyMs).toBe(1000);
    expect(args?.data?.costUsd).toBe("0.123457");
    expect(args?.data?.langsmithRunId).toBe("run_1");
    expect(args?.data?.status).toBe(LlmRequestStatus.OK);
    expect(args?.data?.errorMessage).toBeNull();
    expect(args?.data?.createdAt).toEqual(requestedAt);

    expect(ledgerSpy).toHaveBeenCalledTimes(1);
    const [ledgerArgs] = ledgerSpy.mock.calls[0] ?? [];
    expect(ledgerArgs?.orgId).toBe("org_1");
    expect(ledgerArgs?.model).toBe("gpt-4o-mini");
    expect(ledgerArgs?.status).toBe(LlmRequestStatus.OK);
  });

  it("never throws when prisma fails (logs + swallows)", async () => {
    const rejectSpy = vi.fn().mockRejectedValue(new Error("db down"));
    const prisma = {
      llmRequestFact: {
        create: rejectSpy,
        aggregate: aggregateSpy,
      },
    } as unknown as { readonly llmRequestFact: { create: typeof rejectSpy; aggregate: typeof aggregateSpy } };

    const svc = new LlmFactService(prisma as any, undefined);
    const warnSpy = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, "warn");

    await expect(
      svc.recordRequest({
        orgId: "org_1",
        model: "gpt-4o-mini",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        latencyMs: 0,
        costUsd: 0,
        status: LlmRequestStatus.ERROR,
        requestedAt: new Date("2026-05-29T00:00:00Z"),
        completedAt: new Date("2026-05-29T00:00:00Z"),
      } as any),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

