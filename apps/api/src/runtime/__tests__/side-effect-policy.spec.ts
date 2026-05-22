import { describe, it, expect } from "vitest";
import {
  SideEffectPolicy,
  getToolPolicy,
  TOOL_POLICY_METADATA,
  ToolSideEffectLevel,
  type ApprovalEnvelope,
} from "../tools/side-effect";

const NOW = new Date("2026-05-21T12:00:00Z");

function envelope(overrides: Partial<ApprovalEnvelope> = {}): ApprovalEnvelope {
  return {
    approvalId: "apv_test",
    approvedBy: "user_test",
    approvedAt: "2026-05-21T11:00:00Z",
    scope: "outreach",
    allowedToolNames: ["send_email", "hubspot"],
    expiresAt: "2026-05-21T13:00:00Z",
    dryRunAllowed: true,
    ...overrides,
  };
}

describe("getToolPolicy", () => {
  it("returns registered metadata for known tools", () => {
    expect(getToolPolicy("web_search").sideEffectLevel).toBe(ToolSideEffectLevel.READ_ONLY);
    expect(getToolPolicy("memory").sideEffectLevel).toBe(ToolSideEffectLevel.INTERNAL_WRITE);
    expect(getToolPolicy("send_email").sideEffectLevel).toBe(ToolSideEffectLevel.EXTERNAL_WRITE);
    expect(getToolPolicy("hubspot").sideEffectLevel).toBe(ToolSideEffectLevel.EXTERNAL_WRITE);
  });

  it("fails closed: unknown tools default to EXTERNAL_WRITE + approval required", () => {
    const policy = getToolPolicy("totally_new_third_party_writer");
    expect(policy.sideEffectLevel).toBe(ToolSideEffectLevel.EXTERNAL_WRITE);
    expect(policy.requiresApproval).toBe(true);
    expect(policy.allowedDryRun).toBe(false);
  });

  it("registered EXTERNAL_WRITE tools must declare approval requirement", () => {
    for (const policy of Object.values(TOOL_POLICY_METADATA)) {
      if (policy.sideEffectLevel === ToolSideEffectLevel.EXTERNAL_WRITE) {
        expect(policy.requiresApproval).toBe(true);
      }
    }
  });
});

describe("SideEffectPolicy.check — READ_ONLY / INTERNAL_WRITE", () => {
  it("allows read-only tools without an envelope", () => {
    const decision = SideEffectPolicy.check("web_search", { now: NOW });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });

  it("allows internal-write tools without an envelope", () => {
    const decision = SideEffectPolicy.check("memory", { now: NOW });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });

  it("ignores dry-run flag for read-only tools", () => {
    const decision = SideEffectPolicy.check("web_scrape", { defaultDryRun: true, now: NOW });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });
});

describe("SideEffectPolicy.check — EXTERNAL_WRITE without envelope", () => {
  it("blocks send_email when no envelope and no dry-run requested", () => {
    const decision = SideEffectPolicy.check("send_email", { now: NOW });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("policy_blocked");
      expect(decision.reason).toContain("send_email");
    }
  });

  it("blocks hubspot when no envelope and no dry-run requested", () => {
    const decision = SideEffectPolicy.check("hubspot", { now: NOW });
    expect(decision.allow).toBe(false);
  });

  it("routes send_email to dry_run when defaultDryRun=true and no envelope", () => {
    const decision = SideEffectPolicy.check("send_email", {
      defaultDryRun: true,
      now: NOW,
    });
    expect(decision).toEqual({ allow: true, mode: "dry_run" });
  });

  it("blocks unknown tools even with defaultDryRun (allowedDryRun=false on fail-closed default)", () => {
    const decision = SideEffectPolicy.check("brand_new_writer", {
      defaultDryRun: true,
      now: NOW,
    });
    expect(decision.allow).toBe(false);
  });
});

describe("SideEffectPolicy.check — EXTERNAL_WRITE with envelope", () => {
  it("allows send_email when envelope covers it and is unexpired", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope(),
      now: NOW,
    });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });

  it("blocks send_email when envelope is expired", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ expiresAt: "2026-05-21T11:30:00Z" }),
      now: NOW,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("expired");
    }
  });

  it("blocks send_email when envelope scope does not list it", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ allowedToolNames: ["hubspot"] }),
      now: NOW,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("does not cover");
    }
  });

  it("routes to dry_run when envelope permits it and caller requests dry_run", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ dryRunAllowed: true }),
      defaultDryRun: true,
      now: NOW,
    });
    expect(decision).toEqual({ allow: true, mode: "dry_run" });
  });

  it("executes when envelope.dryRunAllowed=false even if defaultDryRun=true", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ dryRunAllowed: false }),
      defaultDryRun: true,
      now: NOW,
    });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });
});

describe("SideEffectPolicy.check — fail-closed semantics", () => {
  it("unknown tool with no envelope is denied", () => {
    const decision = SideEffectPolicy.check("rm_rf_database", { now: NOW });
    expect(decision.allow).toBe(false);
  });

  it("unknown tool with explicit envelope listing it executes", () => {
    const decision = SideEffectPolicy.check("rm_rf_database", {
      envelope: envelope({ allowedToolNames: ["rm_rf_database"] }),
      now: NOW,
    });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });
});
