import { describe, expect, it } from "vitest";
import { GMAIL_OAUTH_SCOPES } from "../gmail-oauth-scopes";

describe("Gmail OAuth least-privilege contract", () => {
  it("requests only approved-send and read-only reply monitoring access", () => {
    expect([...GMAIL_OAUTH_SCOPES]).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(new Set(GMAIL_OAUTH_SCOPES).size).toBe(GMAIL_OAUTH_SCOPES.length);
  });

  it("does not request redundant draft or mailbox mutation authority", () => {
    expect(GMAIL_OAUTH_SCOPES).not.toContain(
      "https://www.googleapis.com/auth/gmail.compose",
    );
    expect(GMAIL_OAUTH_SCOPES).not.toContain(
      "https://www.googleapis.com/auth/gmail.modify",
    );
    expect(GMAIL_OAUTH_SCOPES).not.toContain(
      "https://mail.google.com/",
    );
  });
});
