import { Annotation } from "@langchain/langgraph";

/**
 * Public pipeline state — what nodes read and write, and what the UI sees.
 *
 * Channels use either `LastValue` (default) or array reducers so that nodes
 * can append (e.g. errors, messages) without clobbering. The supervisor is
 * deterministic for the first cut: it inspects which output arrays are
 * populated to decide the next node.
 */
export const PipelineStateAnnotation = Annotation.Root({
  // ── Static context (set at graph entry, never updated) ─────────────────
  orgId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  runId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  icpProfileIds: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  // ── Outputs from each specialist ───────────────────────────────────────
  sourcedCompanies: Annotation<Array<{ id: string; domain: string; name: string }>>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  enrichedPeople: Annotation<
    Array<{ id: string; companyId: string; firstName: string; lastName: string; title?: string; email?: string }>
  >({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  scoredLeads: Annotation<
    Array<{ personId: string; score: number; tier: "A" | "B" | "C" }>
  >({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  outreachResults: Annotation<
    Array<{ personId: string; agentRunId?: string; status: "queued" | "sent" | "failed"; error?: string }>
  >({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  // ── Stage markers (set by each node when it's done, even if output empty) ─
  stagesCompleted: Annotation<string[]>({
    reducer: (prev, next) => [...new Set([...(prev ?? []), ...(next ?? [])])],
    default: () => [],
  }),

  // ── HITL ───────────────────────────────────────────────────────────────
  approved: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  approvedBy: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // ── Audit trail (append-only) ──────────────────────────────────────────
  messages: Annotation<
    Array<{ node: string; ts: string; level: "info" | "warn" | "error"; text: string }>
  >({
    reducer: (prev, next) => [...(prev ?? []), ...(next ?? [])],
    default: () => [],
  }),
  errors: Annotation<Array<{ node: string; error: string; ts: string }>>({
    reducer: (prev, next) => [...(prev ?? []), ...(next ?? [])],
    default: () => [],
  }),
});

export type PipelineState = typeof PipelineStateAnnotation.State;
export type PipelineStateUpdate = typeof PipelineStateAnnotation.Update;

/** Node names — kept as a const so the supervisor + edges can refer to them. */
export const NODE = {
  SUPERVISOR: "supervisor",
  SOURCING: "sourcing_agent",
  ENRICHMENT: "enrichment_agent",
  SCORING: "scoring_agent",
  APPROVAL: "human_approval",
  OUTREACH: "outreach_agent",
} as const;

export type NodeName = (typeof NODE)[keyof typeof NODE];

/** Stage marker strings written to `stagesCompleted` by each node. */
export const STAGE = {
  SOURCING: "sourcing",
  ENRICHMENT: "enrichment",
  SCORING: "scoring",
  APPROVAL: "approval",
  OUTREACH: "outreach",
} as const;
