import { describe, it, expect } from "vitest";
import {
  API_GLOBAL_PREFIX,
  buildUnsubscribeUrl,
  verifyUnsubscribeToken,
} from "../unsubscribe-token.util";

/**
 * Audit B11: main.ts mounts every controller under setGlobalPrefix("api"),
 * so the live route is /api/u/:token — but the builder used to emit
 * /u/:token, which 404'd in prod and broke one-click unsubscribe for every
 * tenant-zero send. These specs pin the advertised URL to the mounted path.
 */

/** Explicit env double so specs never depend on ambient process.env. */
function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { UNSUBSCRIBE_HMAC_SECRET: "spec-secret", ...overrides } as NodeJS.ProcessEnv;
}

describe("buildUnsubscribeUrl — global api prefix (audit B11)", () => {
  it("matches the prefix main.ts actually mounts", () => {
    expect(API_GLOBAL_PREFIX).toBe("api");
  });

  it("advertises the /api/u/ path that resolves behind the global prefix", () => {
    const url = buildUnsubscribeUrl(
      "org_1",
      "person@example.com",
      envWith({ API_PUBLIC_URL: "https://api.nikxius.com" }),
    );
    expect(url).toMatch(/^https:\/\/api\.nikxius\.com\/api\/u\/[A-Za-z0-9_.~%-]+$/);
    expect(url).toContain("/api/u/");
  });

  it("strips trailing slashes from the base before appending", () => {
    const url = buildUnsubscribeUrl(
      "org_1",
      "person@example.com",
      envWith({ API_PUBLIC_URL: "https://api.nikxius.com///" }),
    );
    expect(url.startsWith("https://api.nikxius.com/api/u/")).toBe(true);
    expect(url).not.toContain("///");
  });

  it("does not double the prefix when API_PUBLIC_URL already ends in /api", () => {
    const url = buildUnsubscribeUrl(
      "org_1",
      "person@example.com",
      envWith({ API_PUBLIC_URL: "https://api.nikxius.com/api" }),
    );
    expect(url.startsWith("https://api.nikxius.com/api/u/")).toBe(true);
    expect(url).not.toContain("/api/api/");
  });

  it("applies the prefix on the legacy BASE_URL fallback too", () => {
    const url = buildUnsubscribeUrl(
      "org_1",
      "person@example.com",
      envWith({ BASE_URL: "https://legacy.nikxius.com" }),
    );
    expect(url.startsWith("https://legacy.nikxius.com/api/u/")).toBe(true);
  });

  it("applies the prefix on the localhost dev fallback", () => {
    const url = buildUnsubscribeUrl("org_1", "person@example.com", envWith({}));
    expect(url.startsWith("http://localhost:3000/api/u/")).toBe(true);
  });

  it("round-trips: the token embedded in the URL verifies back to org + recipient", () => {
    const env = envWith({ API_PUBLIC_URL: "https://api.nikxius.com" });
    const url = buildUnsubscribeUrl("org_1", "Person@Example.com ", env);
    const token = decodeURIComponent(url.split("/u/")[1]);

    const verified = verifyUnsubscribeToken(token, env);
    expect(verified).not.toBeNull();
    expect(verified?.orgId).toBe("org_1");
    // Builder normalizes recipientRef the same way the suppression table keys it.
    expect(verified?.recipientRef).toBe("person@example.com");
  });
});
