import { describe, expect, it } from "vitest";
import {
  isIcpExcludedDomain,
  normalizeIcpDomain,
} from "../icp-domain-exclusions";

describe("ICP domain exclusions", () => {
  it("canonicalizes web domains without retaining URL presentation details", () => {
    expect(normalizeIcpDomain(" HTTPS://WWW.Competitor.COM/jobs ")).toBe(
      "competitor.com",
    );
    expect(normalizeIcpDomain("partner.example.com.")).toBe(
      "partner.example.com",
    );
  });

  it("rejects values that cannot be safe company-domain boundaries", () => {
    expect(normalizeIcpDomain("localhost")).toBeNull();
    expect(normalizeIcpDomain("https://user:pass@example.com")).toBeNull();
    expect(normalizeIcpDomain("https://example.com:8443")).toBeNull();
    expect(normalizeIcpDomain("127.0.0.1")).toBeNull();
    expect(normalizeIcpDomain("not a domain")).toBeNull();
  });

  it("matches exact domains and subdomains without matching suffix lookalikes", () => {
    const exclusions = ["competitor.com"];
    expect(isIcpExcludedDomain("competitor.com", exclusions)).toBe(true);
    expect(isIcpExcludedDomain("careers.competitor.com", exclusions)).toBe(
      true,
    );
    expect(isIcpExcludedDomain("notcompetitor.com", exclusions)).toBe(false);
  });
});
