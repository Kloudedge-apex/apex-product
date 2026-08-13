import { EmailSource, VerificationResult } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  selectOutreachRecipient,
  type OutreachEmailCandidate,
} from "../outreach-recipient";

const BASE_TIME = new Date("2026-06-01T00:00:00.000Z");

function candidate(
  overrides: Partial<OutreachEmailCandidate> = {},
): OutreachEmailCandidate {
  return {
    id: "email_1",
    email: "alice@example.com",
    source: EmailSource.PATTERN_GUESS,
    verified: false,
    verificationResult: VerificationResult.UNKNOWN,
    confidence: 0.5,
    verifiedAt: null,
    createdAt: BASE_TIME,
    ...overrides,
  };
}

describe("selectOutreachRecipient", () => {
  it("prefers VERIFIED+VALID over a higher-confidence source-confirmed address", () => {
    const selected = selectOutreachRecipient([
      candidate({
        id: "source",
        email: "source@example.com",
        source: EmailSource.TEAM_PAGE,
        confidence: 0.99,
      }),
      candidate({
        id: "verified",
        email: " VERIFIED@Example.com ",
        verified: true,
        verificationResult: VerificationResult.VALID,
        confidence: 0.6,
        verifiedAt: new Date("2026-06-02T00:00:00.000Z"),
      }),
    ]);

    expect(selected).toEqual({
      candidateId: "verified",
      email: "verified@example.com",
      source: EmailSource.PATTERN_GUESS,
      verified: true,
      verificationResult: VerificationResult.VALID,
      confidence: 0.6,
      verifiedAt: "2026-06-02T00:00:00.000Z",
      selectionBasis: "VERIFIED_VALID",
    });
  });

  it("selects a source-confirmed fallback deterministically regardless of row order", () => {
    const lower = candidate({
      id: "a",
      email: "lower@example.com",
      source: EmailSource.SEC_FILING,
      confidence: 0.7,
    });
    const higher = candidate({
      id: "b",
      email: "higher@example.com",
      source: EmailSource.PRESS_RELEASE,
      confidence: 0.9,
    });

    const forward = selectOutreachRecipient([lower, higher]);
    const reverse = selectOutreachRecipient([higher, lower]);

    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      candidateId: "b",
      email: "higher@example.com",
      selectionBasis: "SOURCE_CONFIRMED",
      verificationResult: VerificationResult.UNKNOWN,
    });
  });

  it("rejects INVALID candidates and unverified pattern/Hunter guesses", () => {
    const selected = selectOutreachRecipient([
      candidate({
        id: "invalid-source",
        source: EmailSource.GITHUB_COMMIT,
        verified: true,
        verificationResult: VerificationResult.INVALID,
      }),
      candidate({ id: "pattern", source: EmailSource.PATTERN_GUESS }),
      candidate({ id: "hunter", source: EmailSource.HUNTER }),
    ]);

    expect(selected).toBeNull();
  });

  it("uses stable timestamps and ids to break equal-confidence ties", () => {
    const selected = selectOutreachRecipient([
      candidate({
        id: "later-created",
        email: "later@example.com",
        source: EmailSource.TEAM_PAGE,
        confidence: 0.8,
        createdAt: new Date("2026-06-03T00:00:00.000Z"),
      }),
      candidate({
        id: "earlier-created",
        email: "earlier@example.com",
        source: EmailSource.TEAM_PAGE,
        confidence: 0.8,
        createdAt: new Date("2026-06-02T00:00:00.000Z"),
      }),
    ]);

    expect(selected?.candidateId).toBe("earlier-created");
  });
});
