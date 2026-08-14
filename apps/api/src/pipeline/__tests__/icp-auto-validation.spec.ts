/**
 * Validation-retry tests for IcpAutoService.
 *
 * Scope: confirm the LLM JSON parse helper is wired up correctly — malformed
 * first response triggers a retry; both malformed returns a BadRequest
 * (the service surfaces null-from-helper as a user-actionable error).
 *
 * We do NOT re-test parseJsonResponse / chatJsonWithRetry behaviour here;
 * those have their own spec.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Bypass the SSRF guard's DNS check in this spec — fetchHomepageText routes
// through ssrfGuardedFetch (audit P0 #17) but this spec asserts on the LLM
// JSON-validation retry behavior, not on the SSRF guard. The guard has its
// own coverage at runtime/util/__tests__/ssrf-guard.spec.ts.
vi.mock("../../runtime/util/ssrf-guard", async () => {
  const actual = await vi.importActual<typeof import("../../runtime/util/ssrf-guard")>(
    "../../runtime/util/ssrf-guard",
  );
  return {
    ...actual,
    ssrfGuardedFetch: (
      input: string | URL,
      init: RequestInit,
      opts: { fetcher?: (u: URL, i: RequestInit) => Promise<Response> } = {},
    ): Promise<Response> => {
      const url = typeof input === "string" ? new URL(input) : input;
      const fetcher = opts.fetcher ?? ((u: URL, i: RequestInit) => fetch(u, i));
      return fetcher(url, init);
    },
    assertUrlIsPublicHttp: async (input: string | URL): Promise<URL> =>
      typeof input === "string" ? new URL(input) : input,
  };
});

import { BadRequestException } from "@nestjs/common";
import { IcpAutoService } from "../icp-auto.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type {
  ChatMessage,
  ChatOptions,
  LLMService,
  LLMResponse,
} from "../../runtime/llm.service";

const ORIGINAL_FETCH = globalThis.fetch;

function homepageHtml(body: string): Response {
  // 600+ chars so we clear the "too short" threshold (200).
  const padding = "<p>About our company doing important things.</p>".repeat(20);
  const html = `<html><head><title>Acme</title></head><body><h1>Acme Corp</h1>${padding}${body}</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function mockPrisma() {
  return {
    org: {
      findUnique: vi.fn().mockResolvedValue({ website: "https://acme.com", name: "Acme" }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    icpProfile: {
      create: vi.fn().mockResolvedValue({ id: "icp-1", name: "Acme — generated from https://acme.com" }),
    },
  } as unknown as PrismaService;
}

function makeLlm(contents: string[]): {
  llm: LLMService;
  chatMock: ReturnType<typeof vi.fn>;
} {
  const queue = [...contents];
  const chatMock = vi.fn(
    async (
      _messages: ChatMessage[],
      _options?: ChatOptions,
    ): Promise<LLMResponse> => {
    const content = queue.shift() ?? "";
    return { content, tokensUsed: 100, model: "gpt-4o-mini-mock", cost: 0 };
    },
  );
  const llm = { chat: chatMock } as unknown as LLMService;
  return { llm, chatMock };
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => homepageHtml("")) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("IcpAutoService.generateForOrg — JSON validation retry", () => {
  it("retries once when the first LLM response is malformed and succeeds on the second", async () => {
    const validIcp = JSON.stringify({
      productSummary: "Sales automation for B2B SaaS",
      industry: "SaaS",
      targetTitles: ["VP of Sales", "Head of RevOps"],
      targetIndustries: ["SaaS", "Fintech"],
      targetGeos: ["United States"],
      intentKeywords: ["outbound automation"],
      minEmployees: 50,
      maxEmployees: 500,
    });
    const { llm, chatMock } = makeLlm(["this is not valid json at all", validIcp]);
    const prisma = mockPrisma();
    const service = new IcpAutoService(prisma, llm);

    const result = await service.generateForOrg("org-1");

    expect(result.id).toBe("icp-1");
    expect(chatMock).toHaveBeenCalledTimes(2);
    // The retry call should include the original 2 turns + assistant echo +
    // system nudge = 4 messages.
    const retryArgs = chatMock.mock.calls[1]![0] as unknown[];
    expect(retryArgs).toHaveLength(4);
    expect(chatMock.mock.calls[0]![1]).toMatchObject({
      orgId: "org-1",
      metadata: { org_id: "org-1" },
    });
  });

  it("throws BadRequestException when both LLM attempts fail to produce valid JSON", async () => {
    const { llm, chatMock } = makeLlm(["garbage one", "garbage two"]);
    const prisma = mockPrisma();
    const service = new IcpAutoService(prisma, llm);

    await expect(service.generateForOrg("org-1")).rejects.toBeInstanceOf(BadRequestException);
    expect(chatMock).toHaveBeenCalledTimes(2);
  });

  it("succeeds without retry when the first response is valid JSON wrapped in a markdown fence", async () => {
    const fenced =
      "```json\n" +
      JSON.stringify({
        productSummary: "Sales automation for B2B software revenue teams",
        industry: "B2B software — sales automation",
        targetTitles: ["VP of Sales", "Head of Revenue Operations"],
        targetIndustries: ["B2B SaaS"],
        targetGeos: ["United States"],
        intentKeywords: ["outbound sales automation"],
        minEmployees: 50,
        maxEmployees: 500,
      }) +
      "\n```";
    const { llm, chatMock } = makeLlm([fenced]);
    const prisma = mockPrisma();
    const service = new IcpAutoService(prisma, llm);

    const result = await service.generateForOrg("org-1");
    expect(result.id).toBe("icp-1");
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});
