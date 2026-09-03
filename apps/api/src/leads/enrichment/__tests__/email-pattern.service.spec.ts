import { EmailSource } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { EmailPatternService } from "../email-pattern.service";

describe("EmailPatternService", () => {
  it("marks an address generated from a learned public pattern", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      patterns: [{ pattern: "first.last", frequency: 2, confidence: 0.9 }],
    });
    const service = new EmailPatternService(
      {
        patternStore: { findUnique },
      } as never,
      { get: vi.fn().mockReturnValue(undefined) } as never,
    );

    const candidates = await service.generateCandidates(
      "org-test",
      "Ada",
      "Lovelace",
      "example.com",
    );

    expect(candidates[0]).toMatchObject({
      email: "ada.lovelace@example.com",
      source: EmailSource.VERIFIED_PATTERN,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { orgId_domain: { orgId: "org-test", domain: "example.com" } },
    });
  });
});
