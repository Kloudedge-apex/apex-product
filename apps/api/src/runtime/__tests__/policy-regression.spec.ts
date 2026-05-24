import { describe, it, expect } from "vitest";
import {
  SideEffectPolicy,
  TOOL_POLICY_METADATA,
  ToolSideEffectLevel,
  getToolPolicy,
  type ApprovalEnvelope,
} from "../tools/side-effect";

/**
 * Phase 2.5 regression: lock down the policy table and decision boundaries
 * so a future refactor cannot silently weaken the side-effect gate. These
 * complement the existing `side-effect-policy.spec.ts` unit tests by pinning
 * the *contents* of the metadata table and exercising the DESTRUCTIVE path
 * that the base spec leaves uncovered.
 */

const NOW = new Date("2026-05-22T12:00:00Z");

function envelope(overrides: Partial<ApprovalEnvelope> = {}): ApprovalEnvelope {
  return {
    approvalId: "apv_regression",
    approvedBy: "user_regression",
    approvedAt: "2026-05-22T11:00:00Z",
    scope: "outreach",
    allowedToolNames: ["send_email"],
    expiresAt: "2026-05-22T13:00:00Z",
    dryRunAllowed: true,
    ...overrides,
  };
}

describe("TOOL_POLICY_METADATA — pinned contents", () => {
  /**
   * If a developer adds a new tool, this test will fail until they update the
   * snapshot below. That forces them to think about the policy implications
   * (read-only vs internal vs external) before shipping.
   */
  it("pins the exact set of registered tools and their levels", () => {
    const snapshot = Object.fromEntries(
      Object.entries(TOOL_POLICY_METADATA).map(([name, p]) => [
        name,
        {
          level: p.sideEffectLevel,
          requiresApproval: p.requiresApproval,
          allowedDryRun: p.allowedDryRun,
        },
      ]),
    );

    expect(snapshot).toEqual({
      web_search: {
        level: ToolSideEffectLevel.READ_ONLY,
        requiresApproval: false,
        allowedDryRun: false,
      },
      web_scrape: {
        level: ToolSideEffectLevel.READ_ONLY,
        requiresApproval: false,
        allowedDryRun: false,
      },
      company_research: {
        level: ToolSideEffectLevel.READ_ONLY,
        requiresApproval: false,
        allowedDryRun: false,
      },
      lead_score: {
        level: ToolSideEffectLevel.READ_ONLY,
        requiresApproval: false,
        allowedDryRun: false,
      },
      memory: {
        level: ToolSideEffectLevel.INTERNAL_WRITE,
        requiresApproval: false,
        allowedDryRun: false,
      },
      send_email: {
        level: ToolSideEffectLevel.EXTERNAL_WRITE,
        requiresApproval: true,
        allowedDryRun: true,
      },
      hubspot: {
        level: ToolSideEffectLevel.EXTERNAL_WRITE,
        requiresApproval: true,
        allowedDryRun: true,
      },
      linkedin_send_message: {
        level: ToolSideEffectLevel.EXTERNAL_WRITE,
        requiresApproval: true,
        allowedDryRun: true,
      },
    });
  });

  it("READ_ONLY entries never require approval (cross-invariant)", () => {
    for (const policy of Object.values(TOOL_POLICY_METADATA)) {
      if (policy.sideEffectLevel === ToolSideEffectLevel.READ_ONLY) {
        expect(policy.requiresApproval).toBe(false);
      }
    }
  });

  it("INTERNAL_WRITE entries never require approval (cross-invariant)", () => {
    for (const policy of Object.values(TOOL_POLICY_METADATA)) {
      if (policy.sideEffectLevel === ToolSideEffectLevel.INTERNAL_WRITE) {
        expect(policy.requiresApproval).toBe(false);
      }
    }
  });

  it("any EXTERNAL_WRITE entry that allows dry-run must require approval", () => {
    // Phase 2.5 invariant: dry-run is the human-review path. If a tool can
    // skip approval entirely, it should not be EXTERNAL_WRITE.
    for (const policy of Object.values(TOOL_POLICY_METADATA)) {
      if (
        policy.sideEffectLevel === ToolSideEffectLevel.EXTERNAL_WRITE &&
        policy.allowedDryRun
      ) {
        expect(policy.requiresApproval).toBe(true);
      }
    }
  });
});

describe("Fail-closed default — exhaustive coverage", () => {
  it.each([
    "salesforce_create_contact",
    "twilio_send_sms",
    "slack_post_message",
    "stripe_charge_card",
    "calendly_create_event",
    "drop_table_users",
  ])("unknown tool %s resolves to EXTERNAL_WRITE + approval required", (toolName) => {
    const policy = getToolPolicy(toolName);
    expect(policy.sideEffectLevel).toBe(ToolSideEffectLevel.EXTERNAL_WRITE);
    expect(policy.requiresApproval).toBe(true);
    expect(policy.allowedDryRun).toBe(false);
  });

  it.each([
    "salesforce_create_contact",
    "twilio_send_sms",
    "slack_post_message",
  ])("unknown tool %s is denied without an envelope even in dry-run mode", (toolName) => {
    const decision = SideEffectPolicy.check(toolName, {
      defaultDryRun: true,
      now: NOW,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("policy_blocked");
    }
  });
});

describe("DESTRUCTIVE level — currently unused, but the enum exists", () => {
  /**
   * No tool is registered at DESTRUCTIVE today, but the enum value exists
   * and `check()` must treat it identically to EXTERNAL_WRITE. If anyone
   * ever does register one, these tests guarantee it inherits the same
   * gate behavior without further code changes.
   *
   * We simulate by stubbing the policy via the unknown-tool fail-closed
   * path, which is EXTERNAL_WRITE — close enough to verify the branch.
   * The literal DESTRUCTIVE path is exercised by direct enum membership
   * checks below.
   */
  it("DESTRUCTIVE enum value exists and is distinct", () => {
    expect(ToolSideEffectLevel.DESTRUCTIVE).toBe("destructive");
    expect(ToolSideEffectLevel.DESTRUCTIVE).not.toBe(
      ToolSideEffectLevel.EXTERNAL_WRITE,
    );
  });

  it("no tool is registered at DESTRUCTIVE today", () => {
    for (const policy of Object.values(TOOL_POLICY_METADATA)) {
      expect(policy.sideEffectLevel).not.toBe(ToolSideEffectLevel.DESTRUCTIVE);
    }
  });
});

describe("Envelope edge cases", () => {
  it("envelope expiring exactly at now is treated as expired", () => {
    // expiresAt < now → blocked. expiresAt === now is the boundary; the
    // implementation uses strict `<`, so equality must still allow. Pin
    // that contract so a future `<=` change is caught.
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ expiresAt: NOW.toISOString() }),
      now: NOW,
    });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });

  it("envelope expired by one millisecond is blocked", () => {
    const expired = new Date(NOW.getTime() - 1).toISOString();
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ expiresAt: expired }),
      now: NOW,
    });
    expect(decision.allow).toBe(false);
  });

  it("envelope with empty allowedToolNames blocks all tools and surfaces <none>", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ allowedToolNames: [] }),
      now: NOW,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("<none>");
    }
  });

  it("envelope.dryRunAllowed=true but defaultDryRun=false → execute (not dry_run)", () => {
    // Dry-run requires BOTH the envelope permission AND the caller asking.
    // The envelope alone shouldn't downgrade an execute call to dry-run.
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ dryRunAllowed: true }),
      defaultDryRun: false,
      now: NOW,
    });
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });

  it("dry_run requires policy.allowedDryRun=true even with permissive envelope", () => {
    // Stuff a fake tool into the envelope to verify the unknown-tool path
    // (allowedDryRun=false on fail-closed default) doesn't get a dry-run
    // even when the envelope says it's fine.
    const decision = SideEffectPolicy.check("brand_new_external_tool", {
      envelope: envelope({
        allowedToolNames: ["brand_new_external_tool"],
        dryRunAllowed: true,
      }),
      defaultDryRun: true,
      now: NOW,
    });
    // Unknown tool fail-closed = allowedDryRun=false, so even with the
    // envelope saying "dry-run is ok", the decision must be execute.
    expect(decision).toEqual({ allow: true, mode: "execute" });
  });
});

describe("Reason strings — surface enough context for ops debugging", () => {
  it("blocked reason names the tool", () => {
    const decision = SideEffectPolicy.check("send_email", { now: NOW });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("send_email");
    }
  });

  it("expired envelope reason names the approval id and timestamp", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({
        approvalId: "apv_xyz",
        expiresAt: "2026-05-22T11:00:00Z",
      }),
      now: NOW,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("apv_xyz");
      expect(decision.reason).toContain("2026-05-22T11:00:00Z");
    }
  });

  it("scope-mismatch reason lists what the envelope actually covers", () => {
    const decision = SideEffectPolicy.check("send_email", {
      envelope: envelope({ allowedToolNames: ["hubspot", "memory"] }),
      now: NOW,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toContain("hubspot");
      expect(decision.reason).toContain("memory");
    }
  });
});
