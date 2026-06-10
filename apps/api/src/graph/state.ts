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
  // per-run only: IDs of Person rows sourced in THIS run. Downstream nodes
  // use this set to scope DB reads instead of pulling the org-wide top-N.
  // Kept as a flat string[] (no `Lead` model on disk) per the no-migration
  // rule — see CLAUDE.md and bug 200-lead-leak.
  sourcedPersonIds: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  enrichedPeople: Annotation<
    Array<{ id: string; companyId: string; firstName: string; lastName: string; title?: string; email?: string }>
  >({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  // per-run only: IDs of Person rows the enrichment stage TOUCHED (input
  // set ∪ newly-contacted). Scoring scopes its DB reads to this set.
  enrichedPersonIds: Annotation<string[]>({
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
  // Per-stage richer status. A stage may be in `stagesCompleted` (the
  // supervisor has accepted that it ran) yet still be FAILED or PARTIAL here.
  // Kept in graph state only — no Prisma migration. Downstream nodes consult
  // this map as a defensive gate; the canonical "stop the run" signal is a
  // thrown error from the failing node so the worker flips GraphRun.status
  // to FAILED via graph.service's existing try/catch.
  stageStatuses: Annotation<Record<string, StageStatus>>({
    reducer: (prev, next) => ({ ...(prev ?? {}), ...(next ?? {}) }),
    default: () => ({}),
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
  RESEARCH: "research_agent",
  APPROVAL: "human_approval",
  OUTREACH: "outreach_agent",
} as const;

export type NodeName = (typeof NODE)[keyof typeof NODE];

/** Stage marker strings written to `stagesCompleted` by each node. */
export const STAGE = {
  SOURCING: "sourcing",
  ENRICHMENT: "enrichment",
  SCORING: "scoring",
  RESEARCH: "research",
  APPROVAL: "approval",
  OUTREACH: "outreach",
} as const;

export type StageName = (typeof STAGE)[keyof typeof STAGE];

/**
 * Per-stage status. Lives only in graph state.
 *  - RUNNING:  stage entered, not yet finished (rarely seen post-hoc; nodes
 *              currently set this implicitly before completing).
 *  - COMPLETE: stage finished and produced its expected output (or zero
 *              output is a legitimate outcome — e.g. all leads scored below
 *              threshold, or dry-run outreach with nothing eligible).
 *  - PARTIAL:  stage produced *some* output but less than its input demanded
 *              (e.g. enrichment yielded leads for some ICPs but not others).
 *              Downstream may still proceed; the supervisor does not gate on
 *              this.
 *  - FAILED:   stage produced zero usable output AND that is fatal. The node
 *              must additionally THROW so the worker flips GraphRun.status
 *              to FAILED. Downstream nodes also gate on this defensively.
 */
export type StageStatus = "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED";
