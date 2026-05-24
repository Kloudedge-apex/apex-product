/**
 * Side-effect policy for tool calls.
 *
 * Every tool falls into one of four levels. Tools at EXTERNAL_WRITE and
 * DESTRUCTIVE levels cannot execute without a valid ApprovalEnvelope that
 * names them explicitly. Tools marked allowedDryRun can still produce a
 * reviewable artifact when the run is in dry-run mode — they just may not
 * touch the outside world.
 *
 * The guard is intentionally fail-closed: an unknown tool name resolves to
 * EXTERNAL_WRITE and is denied. Registering a new external tool requires
 * adding an entry to TOOL_POLICY_METADATA.
 */

export enum ToolSideEffectLevel {
  READ_ONLY = "read_only",
  INTERNAL_WRITE = "internal_write",
  EXTERNAL_WRITE = "external_write",
  DESTRUCTIVE = "destructive",
}

export interface ToolPolicyMetadata {
  readonly toolName: string;
  readonly sideEffectLevel: ToolSideEffectLevel;
  readonly requiresApproval: boolean;
  readonly allowedDryRun: boolean;
}

export interface ApprovalEnvelope {
  readonly approvalId: string;
  readonly approvedBy: string;
  /** ISO-8601 timestamp */
  readonly approvedAt: string;
  /** Free-text scope tag, e.g. "outreach", "crm-sync" */
  readonly scope: string;
  readonly allowedToolNames: readonly string[];
  /** ISO-8601 timestamp */
  readonly expiresAt: string;
  readonly dryRunAllowed: boolean;
}

export type PolicyDecision =
  | { readonly allow: true; readonly mode: "execute" | "dry_run" }
  | { readonly allow: false; readonly reason: string };

/**
 * Authoritative mapping. The executor consults this table, not per-tool
 * fields, so adding a new external tool requires an explicit policy entry.
 */
export const TOOL_POLICY_METADATA: Readonly<Record<string, ToolPolicyMetadata>> = {
  web_search: {
    toolName: "web_search",
    sideEffectLevel: ToolSideEffectLevel.READ_ONLY,
    requiresApproval: false,
    allowedDryRun: false,
  },
  web_scrape: {
    toolName: "web_scrape",
    sideEffectLevel: ToolSideEffectLevel.READ_ONLY,
    requiresApproval: false,
    allowedDryRun: false,
  },
  company_research: {
    toolName: "company_research",
    sideEffectLevel: ToolSideEffectLevel.READ_ONLY,
    requiresApproval: false,
    allowedDryRun: false,
  },
  lead_score: {
    toolName: "lead_score",
    sideEffectLevel: ToolSideEffectLevel.READ_ONLY,
    requiresApproval: false,
    allowedDryRun: false,
  },
  memory: {
    toolName: "memory",
    sideEffectLevel: ToolSideEffectLevel.INTERNAL_WRITE,
    requiresApproval: false,
    allowedDryRun: false,
  },
  send_email: {
    toolName: "send_email",
    sideEffectLevel: ToolSideEffectLevel.EXTERNAL_WRITE,
    requiresApproval: true,
    allowedDryRun: true,
  },
  hubspot: {
    toolName: "hubspot",
    sideEffectLevel: ToolSideEffectLevel.EXTERNAL_WRITE,
    requiresApproval: true,
    allowedDryRun: true,
  },
  linkedin_send_message: {
    toolName: "linkedin_send_message",
    sideEffectLevel: ToolSideEffectLevel.EXTERNAL_WRITE,
    requiresApproval: true,
    allowedDryRun: true,
  },
};

export function getToolPolicy(toolName: string): ToolPolicyMetadata {
  const known = TOOL_POLICY_METADATA[toolName];
  if (known) return known;
  // Fail closed: unknown tools default to EXTERNAL_WRITE with approval
  // required, so a new external integration can never bypass the guard by
  // forgetting to register policy metadata.
  return {
    toolName,
    sideEffectLevel: ToolSideEffectLevel.EXTERNAL_WRITE,
    requiresApproval: true,
    allowedDryRun: false,
  };
}

export interface PolicyCheckOptions {
  readonly envelope?: ApprovalEnvelope;
  /** When true and the tool allowedDryRun=true, decision is "dry_run". */
  readonly defaultDryRun?: boolean;
  /** Override Date.now() for deterministic tests. */
  readonly now?: Date;
}

export class SideEffectPolicy {
  /**
   * Decide whether the named tool may run given the current envelope.
   * Pure function: no IO, no logging — caller logs the result.
   */
  static check(toolName: string, opts: PolicyCheckOptions = {}): PolicyDecision {
    const policy = getToolPolicy(toolName);
    const { envelope, defaultDryRun = false, now = new Date() } = opts;

    // READ_ONLY and INTERNAL_WRITE never need approval.
    if (
      policy.sideEffectLevel === ToolSideEffectLevel.READ_ONLY ||
      policy.sideEffectLevel === ToolSideEffectLevel.INTERNAL_WRITE
    ) {
      return { allow: true, mode: "execute" };
    }

    // EXTERNAL_WRITE / DESTRUCTIVE: require approval unless dry-run path
    // applies. Dry-run is allowed when (a) policy says so AND
    // (b) caller requested dry-run by default OR envelope permits it.
    if (!envelope) {
      if (policy.allowedDryRun && defaultDryRun) {
        return { allow: true, mode: "dry_run" };
      }
      return {
        allow: false,
        reason: `policy_blocked: ${toolName} requires approval (level=${policy.sideEffectLevel})`,
      };
    }

    if (new Date(envelope.expiresAt).getTime() < now.getTime()) {
      return {
        allow: false,
        reason: `policy_blocked: approval ${envelope.approvalId} expired at ${envelope.expiresAt}`,
      };
    }

    if (!envelope.allowedToolNames.includes(toolName)) {
      return {
        allow: false,
        reason: `policy_blocked: approval ${envelope.approvalId} does not cover ${toolName} (allowed: ${envelope.allowedToolNames.join(",") || "<none>"})`,
      };
    }

    if (envelope.dryRunAllowed && defaultDryRun && policy.allowedDryRun) {
      return { allow: true, mode: "dry_run" };
    }

    return { allow: true, mode: "execute" };
  }
}
