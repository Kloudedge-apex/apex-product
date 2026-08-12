import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  Optional,
} from "@nestjs/common";
import {
  OutreachArtifact,
  OutreachArtifactStatus,
  OutreachChannel,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import { LangSmithService } from "../observability/langsmith.service";
import { OutreachSendQueueService } from "./outreach-send-queue.service";

/** Dataset name for the regression set of rejected SDR drafts. */
const BAD_SDR_DRAFTS_DATASET = "apex-bad-sdr-drafts";

/** Dataset name for the positive set of human-approved SDR drafts. */
const GOOD_SDR_DRAFTS_DATASET = "apex-good-sdr-drafts";

type ReviewDecision =
  | typeof OutreachArtifactStatus.APPROVED
  | typeof OutreachArtifactStatus.REJECTED;

/**
 * Extract the LangSmith run id stashed on the artifact at create-time.
 * Today this lives in `payload.langsmith_run_id` because OutreachArtifact has
 * no first-class column for it; if/when that column is added, prefer it and
 * fall back here for legacy rows. Returns null for legacy artifacts created
 * before runId capture was wired up.
 */
function extractLangsmithRunId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = (payload as Record<string, unknown>).langsmith_run_id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/**
 * Maps the tool name reported by the executor to the channel enum we store
 * on the artifact. Keep this in sync with TOOL_POLICY_METADATA — every tool
 * whose dry-run produces an artifact must map to a channel here.
 */
function channelForTool(toolName: string): OutreachChannel | null {
  switch (toolName) {
    case "send_email":
      return OutreachChannel.EMAIL;
    case "hubspot":
      return OutreachChannel.HUBSPOT_NOTE;
    default:
      return null;
  }
}

export interface CreateDryRunArtifactInput {
  readonly orgId: string;
  readonly graphRunId?: string | null;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
}

@Injectable()
export class OutreachArtifactsService {
  private readonly logger = new Logger(OutreachArtifactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
    @Optional() private readonly sendQueue?: OutreachSendQueueService,
    @Optional() private readonly langsmith?: LangSmithService,
  ) {}

  /**
   * Persist a dry-run capture of what would have been sent. Returns null
   * for tools that do not map to a channel — those calls produce no
   * reviewable artifact (e.g. read-only tools should never reach here).
   */
  async recordDryRun(input: CreateDryRunArtifactInput): Promise<OutreachArtifact | null> {
    const channel = channelForTool(input.toolName);
    if (!channel) {
      this.logger.warn(
        `Skipping artifact for ${input.toolName} — no channel mapping`,
      );
      return null;
    }

    const { subject, bodyText, bodyHtml, recipientRef } = extractFromArgs(
      input.toolName,
      input.toolArgs,
    );

    // Idempotency: a retry of the outer outreach loop must not produce a
    // duplicate artifact for the same (graphRunId, recipientRef, toolName)
    // triple. Audit P0 #9: without this guard, BullMQ retries of the outer
    // pipeline node multiplied artifacts — OUTREACH_ATTEMPTS=3 produced 3
    // PENDING_REVIEW rows for one lead. The DB-side @@unique constraint that
    // backs this is in docs/migrations/2026-06-01_outreach-artifact-unique.sql
    // (operator-gated; this guard is correct on its own under steady state).
    if (input.graphRunId && recipientRef) {
      const existing = await this.prisma.outreachArtifact.findFirst({
        where: {
          orgId: input.orgId,
          graphRunId: input.graphRunId,
          toolName: input.toolName,
          recipientRef,
        },
      });
      if (existing) {
        this.logger.log(
          `OutreachArtifact already exists for graphRun=${input.graphRunId} recipient=${recipientRef} tool=${input.toolName}; returning existing id=${existing.id}`,
        );
        return existing;
      }
    }

    const artifact = await this.prisma.outreachArtifact.create({
      data: {
        orgId: input.orgId,
        graphRunId: input.graphRunId ?? null,
        toolName: input.toolName,
        channel,
        recipientRef,
        subject,
        bodyText,
        bodyHtml,
        payload: input.toolArgs as Prisma.InputJsonValue,
        status: OutreachArtifactStatus.PENDING_REVIEW,
      },
    });

    void this.evidenceLedger?.artifactPersisted({
      orgId: input.orgId,
      runId: input.graphRunId ?? null,
      artifactId: artifact.id,
      status: artifact.status,
      channel: artifact.channel,
    });

    return artifact;
  }

  async listForOrg(orgId: string, opts: { status?: OutreachArtifactStatus } = {}) {
    return this.prisma.outreachArtifact.findMany({
      where: {
        orgId,
        ...(opts.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async listPageForOrg(
    orgId: string,
    opts: { status?: OutreachArtifactStatus; page: number; limit: number },
  ) {
    const where = {
      orgId,
      ...(opts.status ? { status: opts.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.outreachArtifact.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
      }),
      this.prisma.outreachArtifact.count({ where }),
    ]);
    return { items, total, page: opts.page, limit: opts.limit };
  }

  async listForGraphRun(orgId: string, graphRunId: string) {
    return this.prisma.outreachArtifact.findMany({
      where: { orgId, graphRunId },
      orderBy: { createdAt: "asc" },
    });
  }

  async get(orgId: string, id: string): Promise<OutreachArtifact> {
    const artifact = await this.prisma.outreachArtifact.findUnique({ where: { id } });
    if (!artifact || artifact.orgId !== orgId) {
      throw new NotFoundException(`OutreachArtifact ${id} not found`);
    }
    return artifact;
  }

  async approve(
    orgId: string,
    id: string,
    reviewedBy: string,
  ): Promise<OutreachArtifact> {
    const updated = await this.transitionReview(
      orgId,
      id,
      reviewedBy,
      OutreachArtifactStatus.APPROVED,
    );

    // Best-effort: append the generating LangSmith run to the good-drafts
    // dataset — the positive mirror of the reject-side bad-drafts append —
    // so evaluators can be calibrated against human-approved outputs too.
    // Never throws — dataset upload must not block the approve API. Emitted
    // before the queue hand-off because the human judgment stands regardless
    // of whether enqueueing succeeds.
    const runId = extractLangsmithRunId(updated.payload);
    if (!runId) {
      this.logger.debug(
        `Artifact ${id} has no langsmith_run_id — skipping dataset append (legacy or tracing-disabled)`,
      );
    } else if (this.langsmith) {
      void this.langsmith
        .addRunToDataset(GOOD_SDR_DRAFTS_DATASET, runId, {
          label: "approved",
          artifact_id: updated.id,
          org_id: updated.orgId,
          graph_run_id: updated.graphRunId,
          channel: updated.channel,
          recipient_ref: updated.recipientRef,
          reviewer_note: null,
          reviewed_by: reviewedBy,
        })
        .catch((err) => {
          this.logger.warn(
            `addRunToDataset threw for artifact=${updated.id} runId=${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    // Hand off to the send worker. The APPROVED status is already persisted
    // above, so a queue outage cannot lose the approval — the reconcile sweep
    // in SendOutreachWorker (and the dev DB poller) will pick up APPROVED
    // rows that never made it onto the queue. Audit B11: we must NOT swallow
    // the failure, though — the caller deserves to know the send is queued
    // nowhere yet, so rethrow as 503 after logging loudly.
    if (this.sendQueue) {
      try {
        await this.sendQueue.enqueue({
          artifactId: updated.id,
          orgId: updated.orgId,
        });
      } catch (err) {
        this.logger.error(
          `Failed to enqueue artifact ${updated.id} for send (status=APPROVED persisted; recovery sweep will retry): ${
            err instanceof Error ? err.message : String(err)
          }`,
          err instanceof Error ? err.stack : undefined,
        );
        throw new ServiceUnavailableException(
          `Artifact ${updated.id} was approved but could not be queued for sending. ` +
            `The approval is saved; the recovery sweep will queue it automatically.`,
        );
      }
    }

    return updated;
  }

  async reject(
    orgId: string,
    id: string,
    reviewedBy: string,
    reviewerNote?: string,
  ): Promise<OutreachArtifact> {
    const updated = await this.transitionReview(
      orgId,
      id,
      reviewedBy,
      OutreachArtifactStatus.REJECTED,
      reviewerNote,
    );

    // Best-effort: append the generating LangSmith run to the bad-drafts
    // regression dataset so evaluators can be tested against real human
    // judgments. Never throws — dataset upload must not block the reject API.
    const runId = extractLangsmithRunId(updated.payload);
    if (!runId) {
      this.logger.debug(
        `Artifact ${id} has no langsmith_run_id — skipping dataset append (legacy or tracing-disabled)`,
      );
    } else if (this.langsmith) {
      void this.langsmith
        .addRunToDataset(BAD_SDR_DRAFTS_DATASET, runId, {
          artifact_id: updated.id,
          org_id: updated.orgId,
          graph_run_id: updated.graphRunId,
          channel: updated.channel,
          recipient_ref: updated.recipientRef,
          reviewer_note: reviewerNote ?? null,
          reviewed_by: reviewedBy,
        })
        .catch((err) => {
          this.logger.warn(
            `addRunToDataset threw for artifact=${updated.id} runId=${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    return updated;
  }

  /**
   * Atomically claim the one allowed human review transition. Both the
   * tenant and the expected PENDING_REVIEW state are part of the update
   * predicate, so concurrent approve/reject requests cannot both win after
   * reading the same pending row. All external effects run only after this
   * transaction commits and only for the caller whose CAS changed one row.
   */
  private async transitionReview(
    orgId: string,
    id: string,
    reviewedBy: string,
    decision: ReviewDecision,
    reviewerNote?: string,
  ): Promise<OutreachArtifact> {
    const action =
      decision === OutreachArtifactStatus.APPROVED ? "approved" : "rejected";

    try {
      return await this.prisma.$transaction(async (tx) => {
        const artifact = await tx.outreachArtifact.findUnique({
          where: { id_orgId: { id, orgId } },
        });
        if (!artifact || artifact.orgId !== orgId) {
          throw new NotFoundException(`OutreachArtifact ${id} not found`);
        }
        if (artifact.status !== OutreachArtifactStatus.PENDING_REVIEW) {
          throw new BadRequestException(
            `Artifact ${id} is ${artifact.status}; only PENDING_REVIEW can be ${action}`,
          );
        }
        if (
          decision === OutreachArtifactStatus.APPROVED &&
          artifact.channel === OutreachChannel.HUBSPOT_NOTE
        ) {
          throw new BadRequestException(
            "HubSpot note approval is unavailable because dispatch is not implemented",
          );
        }

        return tx.outreachArtifact.update({
          where: {
            id_orgId: { id, orgId },
            status: OutreachArtifactStatus.PENDING_REVIEW,
          },
          data: {
            status: decision,
            reviewedBy,
            reviewedAt: new Date(),
            ...(decision === OutreachArtifactStatus.REJECTED
              ? { reviewerNote: reviewerNote ?? null }
              : {}),
          },
        });
      });
    } catch (err) {
      // Prisma reports a failed conditional update as P2025. Re-read through
      // the compound tenant key so the loser gets the committed decision and
      // never proceeds to dataset or queue side effects.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2025") {
        throw err;
      }
      const current = await this.prisma.outreachArtifact.findUnique({
        where: { id_orgId: { id, orgId } },
      });
      if (!current) {
        throw new NotFoundException(`OutreachArtifact ${id} not found`);
      }
      throw new BadRequestException(
        `Artifact ${id} is ${current.status}; only PENDING_REVIEW can be ${action}`,
      );
    }
  }
}

/**
 * Best-effort extraction of human-readable fields from the tool args.
 * The payload column always stores the verbatim args, so missing/empty
 * extracted fields are not fatal — they just degrade the reviewer UI.
 */
function extractFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): {
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  recipientRef: string | null;
} {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  if (toolName === "send_email") {
    return {
      subject: str(args.subject),
      bodyText: str(args.body) ?? str(args.bodyText) ?? str(args.text),
      bodyHtml: str(args.html) ?? str(args.bodyHtml),
      recipientRef: str(args.to) ?? str(args.recipient) ?? str(args.email),
    };
  }
  if (toolName === "hubspot") {
    return {
      subject: str(args.summary) ?? str(args.title),
      bodyText: str(args.note) ?? str(args.body),
      bodyHtml: null,
      recipientRef:
        str(args.contactEmail) ?? str(args.contactId) ?? str(args.companyId),
    };
  }
  return { subject: null, bodyText: null, bodyHtml: null, recipientRef: null };
}
