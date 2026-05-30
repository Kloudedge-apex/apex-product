import { describe, it, expect, beforeEach } from "vitest";
import { signToken, verifyToken } from "../unsubscribe-token.util";

describe("unsubscribe-token.util", () => {
  beforeEach(() => {
    process.env.OUTREACH_UNSUBSCRIBE_SECRET = "test_secret_" + "x".repeat(32);
  });

  it("signs and verifies round-trip", () => {
    const claims = {
      orgId: "org_1",
      recipientEmail: "dest@example.com",
      artifactId: "art_1",
    } as const;
    const token = signToken(claims);
    const verified = verifyToken(token);
    expect(verified).toEqual(claims);
  });

  it("rejects tampered tokens", () => {
    const token = signToken({
      orgId: "org_1",
      recipientEmail: "dest@example.com",
      artifactId: "art_1",
    });

    const tampered = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
    expect(verifyToken(tampered)).toBeNull();
  });
});

