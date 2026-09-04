/**
 * Wiring test for EmailPatternService.queryHunter — confirms the Hunter.io
 * lookup retries on a 429 via the shared utility.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { circuitBreakerRegistry } from "../../../common/http-retry.util";
import type { PrismaService } from "../../../prisma/prisma.service";

const ORIGINAL_FETCH = globalThis.fetch;

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockPrisma(): PrismaService {
  return {
    patternStore: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService;
}

beforeEach(() => {
  circuitBreakerRegistry._resetForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("EmailPatternService — Hunter retry wiring", () => {
  it("retries on 429 from Hunter.io and surfaces the hit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(429, {}))
      .mockResolvedValueOnce(
        mockResponse(200, { data: { email: "jane@acme.com", score: 90 } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { EmailPatternService } = await import("../email-pattern.service");
    const svc = new EmailPatternService(
      mockPrisma(),
      new ConfigService({ HUNTER_API_KEY: "test" }),
    );

    const candidates = await svc.generateCandidates(
      "org-test",
      "Jane",
      "Doe",
      "acme.com",
    );
    // Hunter retried once (429 -> 200) and contributed a HUNTER-sourced entry.
    // Whether unshifted or merged onto an existing pattern, the HUNTER source
    // must be present somewhere in the candidate list.
    const hunterHit = candidates.find((c) => c.source === "HUNTER");
    expect(hunterHit).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("hunter.io");
    expect(String(url)).not.toContain("api_key");
    expect((request as RequestInit).headers).toMatchObject({
      "X-API-KEY": "test",
    });
  });
});
