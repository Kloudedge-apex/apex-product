import { describe, expect, it } from "vitest";
import {
  gmailWatchExpiration,
  isGmailWatchFresh,
  normalizeGmailWatchExpiration,
  withGmailWatchExpiration,
} from "../gmail-watch-freshness";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const FUTURE = String(NOW.getTime() + 60_000);

describe("Gmail provider watch expiration", () => {
  it("accepts and preserves a valid future provider timestamp", () => {
    const credentials = withGmailWatchExpiration(
      { accountEmail: "owner@example.com", encrypted: "opaque" },
      FUTURE,
    );

    expect(normalizeGmailWatchExpiration(FUTURE, NOW)).toBe(FUTURE);
    expect(gmailWatchExpiration(credentials, NOW)).toBe(FUTURE);
    expect(isGmailWatchFresh(credentials, NOW)).toBe(true);
    expect(credentials).toMatchObject({
      accountEmail: "owner@example.com",
      encrypted: "opaque",
    });
  });

  it.each([
    ["missing", {}],
    ["malformed", { watchExpiration: "tomorrow" }],
    ["expired", { watchExpiration: String(NOW.getTime()) }],
    [
      "implausibly far future",
      { watchExpiration: String(NOW.getTime() + 9 * 24 * 60 * 60 * 1000) },
    ],
    ["unsafe integer", { watchExpiration: "999999999999999999999" }],
  ])("fails closed for %s expiration", (_name, credentials) => {
    expect(isGmailWatchFresh(credentials, NOW)).toBe(false);
  });
});
