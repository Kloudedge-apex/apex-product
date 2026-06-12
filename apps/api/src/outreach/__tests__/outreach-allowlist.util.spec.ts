/**
 * GL8c: the "*" wildcard arms live outbound email for every org. In
 * production it must be refused unless the operator sets the explicit
 * OUTREACH_ALLOW_WILDCARD=true escape hatch. (Boot-time mirror lives in
 * common/env-validation.ts; baseline allowlist semantics are pinned in
 * send-outreach.worker.spec.ts.)
 */

import { describe, expect, it } from "vitest";
import { isLiveSendAllowedForOrg } from "../outreach-allowlist.util";

describe("isLiveSendAllowedForOrg — production wildcard guard (GL8c)", () => {
  it("refuses the wildcard in production without the escape hatch", () => {
    expect(
      isLiveSendAllowedForOrg("org_any", {
        NODE_ENV: "production",
        OUTREACH_LIVE_FOR_ORGS: "*",
      }),
    ).toBe(false);
  });

  it("allows the wildcard in production WITH OUTREACH_ALLOW_WILDCARD=true", () => {
    expect(
      isLiveSendAllowedForOrg("org_any", {
        NODE_ENV: "production",
        OUTREACH_LIVE_FOR_ORGS: "*",
        OUTREACH_ALLOW_WILDCARD: "true",
      }),
    ).toBe(true);
  });

  it("treats any non-'true' escape-hatch value as unset (strict gating)", () => {
    for (const value of ["false", "TRUE", "1", "yes", ""]) {
      expect(
        isLiveSendAllowedForOrg("org_any", {
          NODE_ENV: "production",
          OUTREACH_LIVE_FOR_ORGS: "*",
          OUTREACH_ALLOW_WILDCARD: value,
        }),
      ).toBe(false);
    }
  });

  it("still allows the wildcard outside production (dev convenience)", () => {
    expect(
      isLiveSendAllowedForOrg("org_any", {
        NODE_ENV: "development",
        OUTREACH_LIVE_FOR_ORGS: "*",
      }),
    ).toBe(true);
    expect(
      isLiveSendAllowedForOrg("org_any", { OUTREACH_LIVE_FOR_ORGS: "*" }),
    ).toBe(true);
  });

  it("leaves explicit allowlists untouched in production", () => {
    const env = {
      NODE_ENV: "production",
      OUTREACH_LIVE_FOR_ORGS: "org_a,org_b",
    };
    expect(isLiveSendAllowedForOrg("org_a", env)).toBe(true);
    expect(isLiveSendAllowedForOrg("org_z", env)).toBe(false);
  });

  it("trims whitespace around the wildcard before guarding", () => {
    expect(
      isLiveSendAllowedForOrg("org_any", {
        NODE_ENV: "production",
        OUTREACH_LIVE_FOR_ORGS: "  *  ",
      }),
    ).toBe(false);
  });
});
