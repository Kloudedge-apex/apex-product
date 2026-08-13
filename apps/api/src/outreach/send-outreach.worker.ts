import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { Job, Worker } from "bullmq";
import {
  ConversationDirection,
  Prisma,
  OutreachArtifact,
  OutreachArtifactPurpose,
  OutreachArtifactStatus,
  OutreachChannel,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  OutreachSendQueueService,
  OUTREACH_SEND_QUEUE_NAME,
} from "./outreach-send-queue.service";
import {
  EMAIL_DISPATCH_OUTCOME,
  SendEmailTool,
  getEmailDispatchOutcome,
  isMockModeResult,
} from "../runtime/tools/send-email.tool";
import { LinkedInSendMessageTool } from "../runtime/tools/linkedin-send-message.tool";
import {
  IntegrationCredentials,
  ToolContext,
  ToolResult,
} from "../runtime/tools/tool.interface";
import { IntegrationsService } from "../integrations/integrations.service";
import { LinkedInService } from "../integrations/linkedin/linkedin.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import { isLiveSendAllowedForOrg } from "./outreach-allowlist.util";
import { SuppressionService } from "./suppression.service";
import { ConversationStoreService } from "../conversation-store/conversation-store.service";
import { acquireOrgSendReservationLock } from "./outreach-send-reservation-lock";
import {
  acquireReplySingleFlightLock,
  conversationReplyThreadScope,
  providerReplyThreadScope,
} from "./reply-single-flight";
import {
  assertArtifactDispatchEligible,
  assertArtifactRecipientCurrent,
} from "./outreach-artifact-eligibility";
import { isGmailWatchFresh } from "../integrations/gmail/gmail-watch-freshness";
import { senderIdentityReadiness } from "./sender-identity.util";

export { isLiveSendAllowedForOrg } from "./outreach-allowlist.util";

interface SendJobData {
  artifactId: string;
  orgId: string;
}

/**
 * Strict gating: only "true" enables this worker. Defaults off so an API
 * container won't start dispatching sends unless explicitly opted in. This
 * mirrors WorkerService.isWorkerEnabled() semantics but uses a separate env
 * var so the agent-runs worker and outreach-send worker can be deployed in
 * different processes.
 */
export function isOutreachWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OUTREACH_WORKER_ENABLED === "true";
}

const FAILED_STATUS_WRITE_ACK = "readers-drained-legacy-inventory-reviewed-v1";

/**
 * New enum writes stay disabled until every API/BFF reader is enum-aware and
 * the legacy marker inventory has been reviewed. Requiring both values keeps
 * a partial or mistyped production configuration on the legacy-compatible
 * representation during the expand phase.
 */
export function failedStatusWritesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.OUTREACH_FAILED_STATUS_WRITES_ENABLED === "true" &&
    env.OUTREACH_FAILED_STATUS_WRITES_ACK === FAILED_STATUS_WRITE_ACK
  );
}

/**
 * Per-org allowlist for real outbound sends. Without this gate, any org with
 * connected Gmail/Outlook credentials would real-send post-approval — there
 * is no other dry-run check on the LangGraph approval path (the legacy
 * SideEffectPolicy.defaultDryRun only applies to the direct executor).
 *
 *   OUTREACH_LIVE_FOR_ORGS unset / empty → no orgs may real-send (fail-closed)
 *   OUTREACH_LIVE_FOR_ORGS="org_a,org_b" → only those orgs may real-send
 *   OUTREACH_LIVE_FOR_ORGS="*"           → all orgs (dev convenience only)
 *
 * Orgs NOT in the allowlist still progress through the worker, but their
 * integrations Map is left empty so SendEmailTool / LinkedInSendMessageTool
 * fall back to their mock branches. Artifacts get marked SIMULATED with a
 * mock receipt — the audit trail records the attempt without an external
 * call, and dashboards never count it as delivered mail.
 */
const IN_MEMORY_POLL_INTERVAL_MS = 5_000;
const IN_MEMORY_BATCH_SIZE = 10;

// Reconcile sweep cadence + thresholds. APPROVED rows older than the requeue
// age have lost their BullMQ job (Redis flush, enqueue failure post-approve).
// A stale SENDING claim cannot reveal whether its worker died before or after
// the provider accepted the POST, so it must become terminal
// DELIVERY_UNKNOWN rather than being released and automatically re-sent.
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const APPROVED_REQUEUE_AGE_MS = 10 * 60_000;
const SENDING_STALE_AGE_MS = 15 * 60_000;
const RECONCILE_BATCH_LIMIT = 100;

// GL8a: per-org daily live-send cap. Confirmed sends, fresh in-flight claims,
// and unresolved delivery outcomes all reserve capacity; over-cap artifacts
// are deferred (left APPROVED, job completes) — never terminal-failed — and
// the reconcile sweep retries them until the UTC-midnight reset clears
// headroom.
const DEFAULT_DAILY_SEND_CAP_PER_ORG = 40;

// GL8b: per-recipient cooldown. Confirmed SENT and DELIVERY_UNKNOWN outcomes
// within this window suppress another contact; a fresh SENDING reservation
// defers it until the first outcome resolves. Comparisons are trimmed and
// case-folded inside the org boundary.
const RECIPIENT_COOLDOWN_DAYS = 14;
const RECIPIENT_COOLDOWN_MS = RECIPIENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

/**
 * Raised only after a live-provider tool invocation began and then rejected
 * without a structured outcome. The caller must not release/retry the claim.
 */
class ProviderDispatchUnknownError extends Error {
  readonly name = "ProviderDispatchUnknownError";
}

/**
 * Resolves the per-org daily send cap. OUTREACH_DAILY_CAP_PER_ORG overrides
 * the default (40); non-numeric or non-positive values fall back to the
 * default so a typo can never disable the cap (fail-closed).
 */
export function getDailySendCapPerOrg(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.OUTREACH_DAILY_CAP_PER_ORG?.trim();
  if (!raw) return DEFAULT_DAILY_SEND_CAP_PER_ORG;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_DAILY_SEND_CAP_PER_ORG;
  }
  return parsed;
}

/** Midnight UTC of the day containing `now` — the daily-cap window floor. */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * Capacity-risk rows for the current UTC day. A fresh SENDING claim may have
 * crossed midnight, so its short safety window is intentionally independent
 * of the day boundary. DELIVERY_UNKNOWN is terminal and consumes capacity on
 * the day it was recorded because the provider may have delivered it.
 */
export function dailySendCapacityWhere(
  now: Date = new Date(),
): Prisma.OutreachArtifactWhereInput {
  return {
    OR: [
      {
        status: OutreachArtifactStatus.SENT,
        sentAt: { gte: startOfUtcDay(now) },
      },
      {
        status: OutreachArtifactStatus.SENDING,
        updatedAt: {
          gte: new Date(now.getTime() - SENDING_STALE_AGE_MS),
        },
      },
      {
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        updatedAt: { gte: startOfUtcDay(now) },
      },
    ],
  };
}

interface RecipientDeliveryRisk {
  id: string;
  status: OutreachArtifactStatus;
  sentAt: Date | null;
  updatedAt: Date;
}

type SendReservationDecision =
  | { kind: "CLAIMED" }
  | { kind: "SKIPPED" }
  | { kind: "PERSISTED_SUPPRESSION" }
  | { kind: "SEQUENCE_STOPPED"; conversationId: string }
  | { kind: "RECIPIENT_IN_FLIGHT"; risk: RecipientDeliveryRisk }
  | { kind: "RECIPIENT_SUPPRESSED"; risk: RecipientDeliveryRisk }
  | {
      kind: "REPLY_CONFLICT";
      reason: string;
      blockerId: string | null;
      blockerStatus: OutreachArtifactStatus | null;
    }
  | { kind: "DAILY_CAP"; capacityUsed: number; cap: number };

@Injectable()
export class SendOutreachWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendOutreachWorker.name);

  private bullWorker: Worker<SendJobData> | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private reconcileHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private reconcileInFlight = false;

  private readonly sendEmailTool = new SendEmailTool();
  private readonly linkedinSendTool: LinkedInSendMessageTool;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: OutreachSendQueueService,
    private readonly integrations: IntegrationsService,
    private readonly suppression: SuppressionService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
    @Optional() private readonly linkedinService?: LinkedInService,
    @Optional() private readonly conversationStore?: ConversationStoreService,
  ) {
    // Build the LinkedIn tool with the optional service + ledger so worker-
    // dispatched sends use the same code path as in-loop agent calls. When
    // LinkedInService is absent (e.g. dev with no IntegrationsModule wiring),
    // the tool returns a mock receipt — for non-allowlisted orgs that ends as
    // SIMULATED; for liveAllowed orgs the GL2 guard in processArtifact treats
    // it as a failed dispatch (mock mode must never be recorded as SENT).
    this.linkedinSendTool = new LinkedInSendMessageTool(
      this.linkedinService,
      this.evidenceLedger,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!isOutreachWorkerEnabled()) {
      this.logger.log(
        "SendOutreachWorker disabled (set OUTREACH_WORKER_ENABLED=true to enable)",
      );
      return;
    }

    if (this.queue.isBullMode()) {
      const connection = this.queue.getConnection();
      if (!connection) {
        throw new Error(
          "OutreachSendQueueService reported BullMQ mode but connection missing",
        );
      }
      this.bullWorker = new Worker<SendJobData>(
        OUTREACH_SEND_QUEUE_NAME,
        async (job) => this.handleJob(job),
        { connection, concurrency: 5 },
      );
      this.bullWorker.on("failed", async (job, err) => {
        this.logger.error(
          `Outreach send job ${job?.id} failed: ${err.message} (attempt ${job?.attemptsMade}/${job?.opts?.attempts ?? "?"})`,
        );
        // BullMQ's retry budget exhausted? Persist a terminal failure on the
        // artifact so the UI can surface it.
        const attempts = job?.opts?.attempts ?? 1;
        if (job && job.attemptsMade >= attempts) {
          await this.markTerminalFailure(
            job.data.artifactId,
            job.data.orgId,
            err.message,
          );
        }
      });
      this.bullWorker.on("error", (err) => {
        this.logger.error(`Outreach BullMQ worker error: ${err.message}`);
      });
      this.logger.log(
        `SendOutreachWorker enabled (BullMQ, queue=${OUTREACH_SEND_QUEUE_NAME})`,
      );
    } else {
      this.intervalHandle = setInterval(
        () => this.pollInMemory(),
        IN_MEMORY_POLL_INTERVAL_MS,
      );
      this.logger.log(
        `SendOutreachWorker enabled (in-memory polling every ${IN_MEMORY_POLL_INTERVAL_MS}ms, batch=${IN_MEMORY_BATCH_SIZE})`,
      );
    }

    // Periodic reconcile sweep (mirrors GraphRunWorker's crash-recovery
    // sweep, but on an interval because send work is continuous): re-enqueue
    // stranded APPROVED rows and quarantine stale SENDING claims as terminal
    // DELIVERY_UNKNOWN. Runs once at boot so a restart doesn't wait a full
    // interval to make ambiguous claims safe.
    this.reconcileHandle = setInterval(
      () => void this.runReconcileSweep(),
      RECONCILE_INTERVAL_MS,
    );
    await this.runReconcileSweep();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.reconcileHandle) {
      clearInterval(this.reconcileHandle);
      this.reconcileHandle = null;
    }
    if (this.bullWorker) {
      await this.bullWorker.close();
      this.bullWorker = null;
    }
  }

  /** BullMQ entrypoint. Throws to let BullMQ record failure + retry. */
  private async handleJob(job: Job<SendJobData>): Promise<void> {
    await this.processArtifact(job.data.artifactId, job.data.orgId);
  }

  /**
   * In-memory polling fallback. Used when REDIS_URL is unset (dev/test). Loads
   * up to IN_MEMORY_BATCH_SIZE APPROVED artifacts per tick. Single-flight via
   * `inFlight` so overlapping intervals don't double-process.
   */
  private async pollInMemory(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const approved = await this.prisma.outreachArtifact.findMany({
        where: { status: OutreachArtifactStatus.APPROVED },
        orderBy: { reviewedAt: "asc" },
        take: IN_MEMORY_BATCH_SIZE,
      });
      for (const artifact of approved) {
        try {
          await this.processArtifact(artifact.id, artifact.orgId);
        } catch (err) {
          // In-memory mode has no BullMQ retry — surface the error and leave
          // the row in APPROVED so the next tick picks it up. We do NOT mark
          // terminal failure here because we have no attempt counter.
          this.logger.warn(
            `In-memory send failed for artifact ${artifact.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `In-memory poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Core idempotent processing path. Re-reads the artifact, aborts unless it
   * is still APPROVED, runs the policy gates (suppression list, GL8b
   * recipient cooldown, GL8a daily cap), CAS-claims it (APPROVED → SENDING)
   * so concurrent workers cannot double-dispatch, sends, and finishes:
   *
   *   live send succeeded   → SENT
   *   forced-mock succeeded → SIMULATED (mock receipt kept for the audit
   *                           trail; never counted as delivered mail)
   *   mock result while live→ FAILURE (GL2): claim released, throw — a mock
   *                           fallback for a liveAllowed org is a delivery
   *                           outage and must never be recorded SENT
   *   recipient in cooldown → SUPPRESSED with "policy-skip:" reviewerNote
   *   daily cap reached     → deferred: row left APPROVED (no claim), the
   *                           reconcile sweep retries after midnight UTC
   *   provider rejected/no-attempt → claim released back to APPROVED, then
   *                           rethrow so BullMQ may safely retry
   *   response lost/ambiguous → DELIVERY_UNKNOWN; never auto-retried
   *
   * This is at-most-once automatic dispatch, not exactly-once delivery. An
   * unknown outcome requires provider/manual reconciliation because the
   * provider may have accepted a request whose response never arrived.
   */
  async processArtifact(artifactId: string, orgId: string): Promise<void> {
    const artifact = await this.prisma.outreachArtifact.findUnique({
      where: { id: artifactId },
    });
    if (!artifact) {
      this.logger.warn(`Artifact ${artifactId} not found — skipping`);
      return;
    }
    if (artifact.orgId !== orgId) {
      this.logger.warn(
        `Artifact ${artifactId} org mismatch (expected ${orgId}, got ${artifact.orgId}) — skipping`,
      );
      return;
    }
    if (artifact.status !== OutreachArtifactStatus.APPROVED) {
      // Idempotency guard: if already SENT, REJECTED, or anything else, do
      // nothing. This is the property that makes re-running the same job safe.
      this.logger.log(
        `Artifact ${artifactId} is ${artifact.status} — already processed, skipping`,
      );
      return;
    }

    // Evaluate the live-send gate once so the dispatch branch and the
    // terminal status cannot disagree about whether this was a real send.
    const liveAllowed = isLiveSendAllowedForOrg(artifact.orgId);

    // Serialize every org's reservation phase in PostgreSQL. The transaction
    // re-checks tenant ownership/status, persisted suppression, sequence-stop,
    // normalized recipient risk, and daily capacity, then CAS-claims
    // APPROVED → SENDING. It commits before dispatch so no database lock is
    // held across provider I/O.
    const reservation = await this.reserveForDispatch(artifact, liveAllowed);
    switch (reservation.kind) {
      case "SKIPPED":
        this.logger.log(
          `Artifact ${artifactId} is no longer claimable — skipping`,
        );
        return;
      case "PERSISTED_SUPPRESSION":
        this.logger.log(
          `Artifact ${artifactId} skipped at reservation — recipient ${artifact.recipientRef} is on the persisted suppression list`,
        );
        return;
      case "SEQUENCE_STOPPED":
        this.logger.log(
          `Artifact ${artifactId} policy-skipped at reservation — recipient replied in conversation ${reservation.conversationId}`,
        );
        return;
      case "RECIPIENT_IN_FLIGHT":
        this.logger.log(
          `Artifact ${artifactId} deferred — recipient ${artifact.recipientRef} has fresh SENDING artifact ${reservation.risk.id}`,
        );
        return;
      case "RECIPIENT_SUPPRESSED":
        this.logger.log(
          `Artifact ${artifactId} policy-skipped — recipient ${artifact.recipientRef} has recent ${reservation.risk.status} delivery risk (artifact ${reservation.risk.id}, org ${artifact.orgId})`,
        );
        return;
      case "REPLY_CONFLICT":
        this.logger.warn(
          `Reply artifact ${artifactId} policy-skipped — ${reservation.reason}`,
        );
        return;
      case "DAILY_CAP":
        this.logger.warn(
          `Daily send cap reached for org ${artifact.orgId} (${reservation.capacityUsed}/${reservation.cap} confirmed or unresolved sends, UTC) — deferring artifact ${artifactId}; row stays APPROVED for the reconcile sweep`,
        );
        return;
      case "CLAIMED":
        break;
    }

    let result: ToolResult;
    try {
      // Defense in depth for rows approved by an older build or a direct data
      // repair. Reservation policy gates run first, but this validation still
      // occurs after the claim and before any provider or credential access.
      // A failure releases the claim through the normal provable-no-send path.
      if (artifact.channel === OutreachChannel.EMAIL) {
        assertArtifactDispatchEligible(artifact);
        await assertArtifactRecipientCurrent(this.prisma, artifact);
      }
      result = await this.dispatch(artifact, liveAllowed);
    } catch (err) {
      if (liveAllowed && err instanceof ProviderDispatchUnknownError) {
        await this.markDeliveryUnknown(artifactId, err.message);
        return;
      }
      // Errors before a provider invocation are safe to retry. Release the
      // claim before rethrowing so BullMQ can find APPROVED next attempt.
      await this.releaseClaim(artifactId);
      throw err;
    }
    if (!result.success) {
      if (liveAllowed && isAmbiguousLiveFailure(artifact.channel, result)) {
        await this.markDeliveryUnknown(
          artifactId,
          result.error ?? "live provider outcome was not classified",
        );
        return;
      }
      // A provider response confirmed rejection, or the tool proved no call
      // was made. Release and throw so BullMQ can safely apply retry/backoff.
      await this.releaseClaim(artifactId);
      throw new Error(result.error ?? "send failed (no error message)");
    }

    // GL2 — the worst lie in the system: when liveAllowed but every
    // credential failed to load (loadIntegrations catch-skip, expired token,
    // mock_ placeholder creds), the send tools "succeed" in mock mode. That
    // is a delivery OUTAGE, not a delivery. Recording SENT+sentAt here would
    // tell the customer their email went out when nothing left the building.
    // Treat it exactly like a failed dispatch: release the claim and throw so
    // BullMQ's retry envelope re-attempts and, at exhaustion, the failed
    // handler marks the artifact terminal FAILED. Non-allowlisted orgs
    // never reach this branch — their mock results stay on the honest
    // SIMULATED path below.
    if (liveAllowed && isMockModeResult(result)) {
      await this.releaseClaim(artifactId);
      throw new Error(
        `live send required for org ${artifact.orgId} but dispatch fell back to mock mode ` +
          `(provider=${extractProvider(result) ?? "<unknown>"}) — no usable credential; refusing to record SENT`,
      );
    }

    if (liveAllowed && artifact.channel === OutreachChannel.EMAIL) {
      const outcome = getEmailDispatchOutcome(result);
      if (outcome !== EMAIL_DISPATCH_OUTCOME.CONFIRMED_SENT) {
        if (outcome === EMAIL_DISPATCH_OUTCOME.NOT_ATTEMPTED) {
          await this.releaseClaim(artifactId);
          throw new Error(
            `live email dispatch for artifact ${artifactId} made no provider attempt`,
          );
        }
        await this.markDeliveryUnknown(
          artifactId,
          `live email returned success without a confirmed-send outcome (${outcome ?? "unclassified"})`,
        );
        return;
      }
    }

    const receiptId = extractReceiptId(result);
    const provider = extractProvider(result);
    const providerThreadId =
      liveAllowed && provider === "gmail" ? extractThreadId(result) : null;

    // Forced-mock sends terminate as SIMULATED, not SENT — dashboards and the
    // guarantee ledger must never count simulated traffic as delivered mail.
    // The mock_ receipt is kept so the audit trail still shows what happened,
    // but sentAt stays null: per the schema, sentAt + sendReceiptId together
    // prove a REAL send, and DashboardService.stats counts emailsSent via
    // sentAt != null.
    const deliveredAt = liveAllowed ? new Date() : null;
    await this.prisma.outreachArtifact.update({
      where: { id: artifactId },
      data: liveAllowed
        ? {
            status: OutreachArtifactStatus.SENT,
            sentAt: deliveredAt,
            sendReceiptId: receiptId,
            ...(providerThreadId ? { providerThreadId } : {}),
          }
        : {
            status: OutreachArtifactStatus.SIMULATED,
            sendReceiptId: receiptId,
          },
    });

    // Materialize real Gmail delivery into the durable conversation store
    // only after SENT + providerThreadId are committed on the artifact. A
    // projection failure must never retry the already-successful provider call
    // (which could duplicate delivery); the artifact remains sufficient for
    // inbound correlation and is the recovery source for a later backfill.
    if (
      liveAllowed &&
      provider === "gmail" &&
      deliveredAt &&
      receiptId &&
      this.conversationStore
    ) {
      try {
        await this.recordGmailConversationDelivery(
          artifact,
          result,
          receiptId,
          deliveredAt,
        );
      } catch (err) {
        this.logger.error(
          `Gmail delivery ${receiptId} was SENT but conversation projection failed for artifact ${artifact.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    void this.evidenceLedger?.messageSent({
      orgId: artifact.orgId,
      runId: artifact.graphRunId ?? null,
      artifactId: artifact.id,
      channel: artifact.channel,
      recipientRef: artifact.recipientRef ?? null,
      subject: artifact.subject ?? null,
      sendReceiptId: receiptId,
      provider,
    });
  }

  /**
   * Atomically reserves one org's next dispatch. The advisory transaction
   * lock closes the gap between "capacity/cooldown is clear" and the SENDING
   * claim for different artifacts in the same org. Provider I/O is
   * deliberately not part of this transaction.
   */
  private async reserveForDispatch(
    artifact: OutreachArtifact,
    liveAllowed: boolean,
  ): Promise<SendReservationDecision> {
    const now = new Date();
    const cooldownFloor = new Date(now.getTime() - RECIPIENT_COOLDOWN_MS);
    const freshSendingFloor = new Date(now.getTime() - SENDING_STALE_AGE_MS);

    return this.prisma.$transaction(async (tx) => {
      await acquireOrgSendReservationLock(tx, artifact.orgId);

      // Re-read after acquiring the org lock. Every mutation below includes
      // orgId and APPROVED so a stale/cross-tenant job always fails closed.
      const current = await tx.outreachArtifact.findUnique({
        where: { id: artifact.id },
        select: {
          orgId: true,
          status: true,
          purpose: true,
          channel: true,
          recipientRef: true,
          conversationId: true,
          providerThreadId: true,
          replyToMessageId: true,
        },
      });
      if (
        !current ||
        current.orgId !== artifact.orgId ||
        current.status !== OutreachArtifactStatus.APPROVED
      ) {
        return { kind: "SKIPPED" };
      }

      // This persisted read under the same org lock as legal/manual
      // suppression writes is the authoritative dispatch boundary. Only an
      // APPROVED REPLY may bypass the exact historical MANUAL/gmail_reply
      // marker.
      if (current.recipientRef) {
        const suppressed = await this.suppression.isSuppressedInTransaction(
          tx,
          current.orgId,
          current.recipientRef,
          {
            allowLegacyReplyStop:
              current.purpose === OutreachArtifactPurpose.REPLY,
          },
        );
        if (suppressed) {
          const update = await tx.outreachArtifact.updateMany({
            where: {
              id: artifact.id,
              orgId: artifact.orgId,
              status: OutreachArtifactStatus.APPROVED,
            },
            data: { status: OutreachArtifactStatus.SUPPRESSED },
          });
          return update.count === 1
            ? { kind: "PERSISTED_SUPPRESSION" }
            : { kind: "SKIPPED" };
        }
      }

      if (current.purpose === OutreachArtifactPurpose.REPLY) {
        const threadScopes = [
          ...(current.conversationId
            ? [conversationReplyThreadScope(current.conversationId)]
            : []),
          ...(current.providerThreadId
            ? [providerReplyThreadScope(current.providerThreadId)]
            : []),
        ];

        if (threadScopes.length === 0) {
          const update = await tx.outreachArtifact.updateMany({
            where: {
              id: artifact.id,
              orgId: artifact.orgId,
              status: OutreachArtifactStatus.APPROVED,
            },
            data: {
              status: OutreachArtifactStatus.SUPPRESSED,
              reviewerNote:
                "policy-skip: reply has no durable conversation or provider-thread identity; dispatch refused",
            },
          });
          return update.count === 1
            ? {
                kind: "REPLY_CONFLICT",
                reason:
                  "it has no durable conversation or provider-thread identity",
                blockerId: null,
                blockerStatus: null,
              }
            : { kind: "SKIPPED" };
        }

        // Creation and dispatch share these tenant/thread/source locks. The
        // thread lock is always acquired, even for source-aware rows, so a
        // legacy null replyToMessageId can never race a modern reply through
        // the provider boundary.
        await acquireReplySingleFlightLock(
          tx,
          current.orgId,
          threadScopes,
          current.replyToMessageId,
        );

        const threadIdentityWhere: Prisma.OutreachArtifactWhereInput = {
          OR: [
            ...(current.conversationId
              ? [{ conversationId: current.conversationId }]
              : []),
            ...(current.providerThreadId
              ? [{ providerThreadId: current.providerThreadId }]
              : []),
          ],
        };
        const sourceIdentityWhere: Prisma.OutreachArtifactWhereInput =
          current.replyToMessageId
            ? {
                OR: [
                  { replyToMessageId: current.replyToMessageId },
                  { replyToMessageId: null },
                ],
              }
            : {};
        const replyThreadWhere: Prisma.OutreachArtifactWhereInput = {
          orgId: current.orgId,
          purpose: OutreachArtifactPurpose.REPLY,
          AND: [threadIdentityWhere],
        };
        const replySourceWhere: Prisma.OutreachArtifactWhereInput = {
          ...replyThreadWhere,
          AND: [threadIdentityWhere, sourceIdentityWhere],
        };

        if (current.conversationId && current.replyToMessageId) {
          const latestInbound = await tx.conversationMessage.findFirst({
            where: {
              orgId: current.orgId,
              conversationId: current.conversationId,
              direction: ConversationDirection.INBOUND,
            },
            orderBy: [{ sentAt: "desc" }, { id: "desc" }],
            select: { id: true },
          });
          if (!latestInbound || latestInbound.id !== current.replyToMessageId) {
            const update = await tx.outreachArtifact.updateMany({
              where: {
                id: artifact.id,
                orgId: artifact.orgId,
                status: OutreachArtifactStatus.APPROVED,
              },
              data: {
                status: OutreachArtifactStatus.SUPPRESSED,
                reviewerNote:
                  "policy-skip: reply draft is stale because a newer inbound message exists",
              },
            });
            return update.count === 1
              ? {
                  kind: "REPLY_CONFLICT",
                  reason:
                    "its source is no longer the latest inbound message in the conversation",
                  blockerId: null,
                  blockerStatus: null,
                }
              : { kind: "SKIPPED" };
          }
        }

        // An in-flight or ambiguous reply anywhere in the same thread blocks
        // every newer source until provider truth is known.
        const threadDeliveryBlocker = await tx.outreachArtifact.findFirst({
          where: {
            ...replyThreadWhere,
            id: { not: artifact.id },
            status: {
              in: [
                OutreachArtifactStatus.SENDING,
                OutreachArtifactStatus.DELIVERY_UNKNOWN,
              ],
            },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, status: true },
        });

        // A confirmed send blocks only the same inbound source. A newer
        // inbound message is a distinct reply turn once no earlier send is
        // in-flight or ambiguous.
        const sourceDeliveryBlocker = threadDeliveryBlocker
          ? null
          : await tx.outreachArtifact.findFirst({
              where: {
                ...replySourceWhere,
                id: { not: artifact.id },
                status: OutreachArtifactStatus.SENT,
              },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: { id: true, status: true },
            });

        // For pre-index legacy duplicates that are merely reviewable, the
        // oldest (createdAt, id) row is the deterministic owner. A later row
        // can never jump the queue merely because it was approved first.
        const canonicalReviewable =
          threadDeliveryBlocker || sourceDeliveryBlocker
            ? null
            : await tx.outreachArtifact.findFirst({
                where: {
                  ...replySourceWhere,
                  status: {
                    in: [
                      OutreachArtifactStatus.DRAFT,
                      OutreachArtifactStatus.PENDING_REVIEW,
                      OutreachArtifactStatus.APPROVED,
                    ],
                  },
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                select: { id: true, status: true },
              });
        if (
          !threadDeliveryBlocker &&
          !sourceDeliveryBlocker &&
          !canonicalReviewable
        ) {
          const update = await tx.outreachArtifact.updateMany({
            where: {
              id: artifact.id,
              orgId: artifact.orgId,
              status: OutreachArtifactStatus.APPROVED,
            },
            data: {
              status: OutreachArtifactStatus.SUPPRESSED,
              reviewerNote:
                "policy-skip: reply slot ownership could not be established at dispatch",
            },
          });
          return update.count === 1
            ? {
                kind: "REPLY_CONFLICT",
                reason:
                  "reply slot ownership could not be established at dispatch",
                blockerId: null,
                blockerStatus: null,
              }
            : { kind: "SKIPPED" };
        }
        const replyBlocker =
          threadDeliveryBlocker ??
          sourceDeliveryBlocker ??
          (canonicalReviewable?.id !== artifact.id
            ? canonicalReviewable
            : null);

        if (replyBlocker) {
          const update = await tx.outreachArtifact.updateMany({
            where: {
              id: artifact.id,
              orgId: artifact.orgId,
              status: OutreachArtifactStatus.APPROVED,
            },
            data: {
              status: OutreachArtifactStatus.SUPPRESSED,
              reviewerNote: (
                `policy-skip: duplicate reply for the same conversation/source; ` +
                `${replyBlocker.status} artifact ${replyBlocker.id} owns the reply slot`
              ).slice(0, 1_000),
            },
          });
          return update.count === 1
            ? {
                kind: "REPLY_CONFLICT",
                reason: `${replyBlocker.status} artifact ${replyBlocker.id} already owns the applicable reply slot`,
                blockerId: replyBlocker.id,
                blockerStatus: replyBlocker.status,
              }
            : { kind: "SKIPPED" };
        }
      }

      // A reply ingestion transaction uses this same advisory lock when it
      // commits sequenceStoppedAt. Whichever transaction acquires the lock
      // first becomes the truthful boundary: stop-before-claim suppresses;
      // stop-after-claim affects future outreach only.
      const sequenceLookup = [
        ...(current.conversationId ? [{ id: current.conversationId }] : []),
        ...(current.recipientRef
          ? [{ contactEmail: current.recipientRef.trim().toLowerCase() }]
          : []),
      ];
      if (
        current.purpose !== OutreachArtifactPurpose.REPLY &&
        sequenceLookup.length > 0
      ) {
        const stoppedConversation = await tx.conversation.findFirst({
          where: {
            orgId: current.orgId,
            sequenceStoppedAt: { not: null },
            OR: sequenceLookup,
          },
          select: { id: true, sequenceStoppedAt: true },
        });
        if (stoppedConversation) {
          const update = await tx.outreachArtifact.updateMany({
            where: {
              id: artifact.id,
              orgId: artifact.orgId,
              status: OutreachArtifactStatus.APPROVED,
            },
            data: {
              status: OutreachArtifactStatus.SUPPRESSED,
              reviewerNote:
                `policy-skip: outreach sequence stopped after recipient reply ` +
                `(conversation ${stoppedConversation.id}, ${
                  stoppedConversation.sequenceStoppedAt?.toISOString() ??
                  "time unknown"
                })`,
            },
          });
          return update.count === 1
            ? {
                kind: "SEQUENCE_STOPPED",
                conversationId: stoppedConversation.id,
              }
            : { kind: "SKIPPED" };
        }
      }

      if (
        current.recipientRef &&
        current.purpose !== OutreachArtifactPurpose.REPLY
      ) {
        const normalizedRecipient = current.recipientRef.trim().toLowerCase();
        if (normalizedRecipient.length > 0) {
          const risks = await tx.$queryRaw<RecipientDeliveryRisk[]>`
            SELECT "id", "status", "sentAt", "updatedAt"
            FROM "OutreachArtifact"
            WHERE "orgId" = ${artifact.orgId}
              AND "id" <> ${artifact.id}
              AND "channel" = ${current.channel}::"OutreachChannel"
              AND "recipientRef" IS NOT NULL
              AND lower(btrim("recipientRef")) = ${normalizedRecipient}
              AND (
                (
                  "status" = 'SENT'::"OutreachArtifactStatus"
                  AND "sentAt" >= ${cooldownFloor}
                )
                OR (
                  "status" = 'SENDING'::"OutreachArtifactStatus"
                  AND "updatedAt" >= ${freshSendingFloor}
                )
                OR (
                  "status" = 'DELIVERY_UNKNOWN'::"OutreachArtifactStatus"
                  AND "updatedAt" >= ${cooldownFloor}
                )
              )
            ORDER BY COALESCE("sentAt", "updatedAt") DESC
            LIMIT 1
          `;
          const risk = risks[0];
          if (risk?.status === OutreachArtifactStatus.SENDING) {
            // This is transient contention, not a terminal policy skip. Leave
            // the artifact APPROVED for reconciliation after the first claim
            // resolves or becomes DELIVERY_UNKNOWN.
            return { kind: "RECIPIENT_IN_FLIGHT", risk };
          }
          if (risk) {
            const riskAt =
              risk.status === OutreachArtifactStatus.SENT
                ? risk.sentAt
                : risk.updatedAt;
            const update = await tx.outreachArtifact.updateMany({
              where: {
                id: artifact.id,
                orgId: artifact.orgId,
                status: OutreachArtifactStatus.APPROVED,
              },
              data: {
                status: OutreachArtifactStatus.SUPPRESSED,
                reviewerNote: (
                  `policy-skip: recipient has ${risk.status} delivery risk within ${RECIPIENT_COOLDOWN_DAYS}-day cooldown ` +
                  `(${riskAt?.toISOString() ?? "<unknown>"} via artifact ${risk.id})`
                ).slice(0, 1000),
              },
            });
            return update.count === 1
              ? { kind: "RECIPIENT_SUPPRESSED", risk }
              : { kind: "SKIPPED" };
          }
        }
      }

      if (liveAllowed) {
        const cap = getDailySendCapPerOrg();
        const capacityUsed = await tx.outreachArtifact.count({
          where: {
            orgId: artifact.orgId,
            ...dailySendCapacityWhere(now),
          },
        });
        if (capacityUsed >= cap) {
          return { kind: "DAILY_CAP", capacityUsed, cap };
        }
      }

      const claim = await tx.outreachArtifact.updateMany({
        where: {
          id: artifact.id,
          orgId: artifact.orgId,
          status: OutreachArtifactStatus.APPROVED,
        },
        data: { status: OutreachArtifactStatus.SENDING },
      });
      return claim.count === 1 ? { kind: "CLAIMED" } : { kind: "SKIPPED" };
    });
  }

  /**
   * Channel-dispatch. Add new branches as more send tools come online.
   * `liveAllowed` is evaluated once by the caller (processArtifact) so the
   * mock/live branch here and the SENT/SIMULATED terminal status stay in
   * lockstep.
   */
  private async dispatch(
    artifact: OutreachArtifact,
    liveAllowed: boolean,
  ): Promise<ToolResult> {
    // Gate: only allowlisted orgs may load real credentials. For non-listed
    // orgs we pass an empty Map, which causes the send tools to take their
    // mock branch — same shape as having no integration connected.
    if (!liveAllowed) {
      this.logger.log(
        `Org ${artifact.orgId} not in OUTREACH_LIVE_FOR_ORGS — forcing mock send for artifact ${artifact.id}`,
      );
    }
    const loadIntegrationsIfAllowed = async () =>
      liveAllowed
        ? this.loadIntegrations(artifact.orgId)
        : new Map<string, IntegrationCredentials>();

    switch (artifact.channel) {
      case OutreachChannel.EMAIL: {
        // Fetch the Org's CAN-SPAM identity fields. Live sends fail-closed
        // when physicalAddress is null — the body footer required by
        // §7704(a)(5) cannot be composed without it. Audit P0 #2.
        const org = await this.prisma.org.findUnique({
          where: { id: artifact.orgId },
          select: {
            id: true,
            name: true,
            physicalAddress: true,
            country: true,
            senderName: true,
          },
        });
        if (!org) {
          throw new Error(
            `Org ${artifact.orgId} not found (required for email send)`,
          );
        }
        const senderIdentity = senderIdentityReadiness(org);
        if (liveAllowed && !senderIdentity.physicalAddressSet) {
          throw new BadRequestException(
            `Org ${artifact.orgId} is missing physicalAddress; cannot send live email outreach until configured (CAN-SPAM §7704(a)(5)).`,
          );
        }
        if (liveAllowed && !senderIdentity.senderNameSet) {
          throw new BadRequestException(
            `Org ${artifact.orgId} is missing senderName; cannot send live email outreach until the reviewed sender identity is configured.`,
          );
        }
        if (liveAllowed && !senderIdentity.countrySet) {
          throw new BadRequestException(
            `Org ${artifact.orgId} is missing a valid two-letter country; cannot send live email outreach until the sender identity is complete.`,
          );
        }

        const integrations = await loadIntegrationsIfAllowed();
        const context: ToolContext = {
          orgId: artifact.orgId,
          agentId: "outreach-worker",
          runId: artifact.graphRunId ?? "outreach-worker",
          integrations,
          senderOrg: {
            orgName: org.name,
            physicalAddress: org.physicalAddress,
            country: org.country,
            senderName: org.senderName,
          },
        };
        const payload = artifact.payload as Record<string, unknown>;
        try {
          return await this.sendEmailTool.execute(payload, context);
        } catch (err) {
          if (!liveAllowed) throw err;
          throw new ProviderDispatchUnknownError(
            `email provider invocation rejected without a delivery outcome: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      case OutreachChannel.LINKEDIN: {
        const integrations = await loadIntegrationsIfAllowed();
        const context: ToolContext = {
          orgId: artifact.orgId,
          agentId: "outreach-worker",
          runId: artifact.graphRunId ?? "outreach-worker",
          integrations,
        };
        // The artifact payload was authored either by an agent's tool call or
        // by an approval-review UI. Expected fields: recipient_urn, body.
        // Fall back to artifact.recipientRef / bodyText for artifacts created
        // before the linkedin tool was wired so we don't reject otherwise-good
        // rows.
        const payload = (artifact.payload as Record<string, unknown>) ?? {};
        const args: Record<string, unknown> = {
          recipient_urn:
            typeof payload.recipient_urn === "string"
              ? payload.recipient_urn
              : (artifact.recipientRef ?? ""),
          body:
            typeof payload.body === "string"
              ? payload.body
              : (artifact.bodyText ?? ""),
        };
        if (typeof payload.integration_id === "string") {
          args.integration_id = payload.integration_id;
        }
        try {
          return await this.linkedinSendTool.execute(args, context);
        } catch (err) {
          if (!liveAllowed) throw err;
          throw new ProviderDispatchUnknownError(
            `LinkedIn provider invocation rejected without a delivery outcome: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      case OutreachChannel.HUBSPOT_NOTE: {
        // HubSpot notes aren't a "send" in the outbound-message sense. Leaving
        // unwired until product confirms whether this channel should actually
        // hit HubSpot post-approval.
        return {
          success: false,
          data: null,
          error: "hubspot_note send not yet wired",
        };
      }
      default: {
        // Exhaustiveness check at the type level.
        const _exhaustive: never = artifact.channel;
        void _exhaustive;
        return {
          success: false,
          data: null,
          error: `unsupported channel: ${artifact.channel as string}`,
        };
      }
    }
  }

  private async loadIntegrations(
    orgId: string,
  ): Promise<Map<string, IntegrationCredentials>> {
    const integrations = new Map<string, IntegrationCredentials>();
    try {
      const records = await this.prisma.integration.findMany({
        where: {
          orgId,
          provider: "gmail",
          status: "CONNECTED",
          encryptedCredentials: { not: null },
          credentials: {
            path: ["accountEmail"],
            string_contains: "@",
          },
          lastHistoryId: { not: null },
        },
      });
      for (const record of records) {
        if (
          record.provider !== "gmail" ||
          !isGmailWatchFresh(record.credentials)
        ) {
          continue;
        }
        try {
          const decrypted = await this.integrations.refreshTokenIfNeeded(
            orgId,
            "gmail",
          );
          if (!decrypted) continue;
          integrations.set("gmail", {
            provider: "gmail",
            accessToken: (decrypted.access_token as string) || "",
            refreshToken: decrypted.refresh_token as string | undefined,
            expiresAt: decrypted.expires_at as number | undefined,
            scopes: decrypted.scope as string | undefined,
          });
        } catch {
          // Skip integrations with bad credentials — SendEmailTool will fall
          // back to mock mode if no live provider is available.
        }
      }
    } catch (err) {
      this.logger.warn(
        `Failed to load integrations for org ${orgId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return integrations;
  }

  private async recordGmailConversationDelivery(
    artifact: OutreachArtifact,
    result: ToolResult,
    providerMessageId: string,
    sentAt: Date,
  ): Promise<void> {
    if (!this.conversationStore) return;
    const providerThreadId = extractThreadId(result);
    if (!providerThreadId) {
      this.logger.warn(
        `Gmail send ${providerMessageId} returned no threadId; conversation projection deferred`,
      );
      return;
    }
    const integration = await this.prisma.integration.findFirst({
      where: { orgId: artifact.orgId, provider: "gmail", status: "CONNECTED" },
      select: { id: true, credentials: true },
    });
    if (!integration) {
      this.logger.warn(
        `Gmail integration missing after send ${providerMessageId}; conversation projection deferred`,
      );
      return;
    }
    const payload = artifact.payload as Record<string, unknown>;
    const senderEmail = accountEmailFromCredentials(integration.credentials);
    const recipient =
      typeof payload.to === "string" ? payload.to : artifact.recipientRef;
    if (!senderEmail || !recipient) {
      this.logger.warn(
        `Gmail send ${providerMessageId} lacks sender/recipient identity; conversation projection deferred`,
      );
      return;
    }
    await this.conversationStore.recordDeliveredGmailArtifact({
      orgId: artifact.orgId,
      integrationId: integration.id,
      artifactId: artifact.id,
      providerThreadId,
      providerMessageId,
      senderEmail,
      toEmails: [recipient],
      subject:
        typeof payload.subject === "string"
          ? payload.subject
          : artifact.subject,
      bodyText: artifact.bodyText,
      bodyHtml: artifact.bodyHtml,
      snippet: artifact.bodyText?.slice(0, 500) ?? null,
      sentAt,
    });
  }

  /**
   * Releases a SENDING claim back to APPROVED only after a provable no-send:
   * either no provider request was attempted or a provider response rejected
   * it. The guarded updateMany leaves a row that raced terminal untouched.
   * If this best-effort release fails, SENDING is intentionally not retried;
   * the stale sweep later quarantines it as DELIVERY_UNKNOWN.
   */
  private async releaseClaim(artifactId: string): Promise<void> {
    try {
      await this.prisma.outreachArtifact.updateMany({
        where: { id: artifactId, status: OutreachArtifactStatus.SENDING },
        data: { status: OutreachArtifactStatus.APPROVED },
      });
    } catch (err) {
      this.logger.error(
        `Failed to release SENDING claim for ${artifactId}: ${
          err instanceof Error ? err.message : String(err)
        } — reconcile sweep will quarantine it as DELIVERY_UNKNOWN`,
      );
    }
  }

  /**
   * Permanently quarantine an ambiguous live-provider outcome. This guarded
   * SENDING -> DELIVERY_UNKNOWN transition is terminal: BullMQ redelivery and
   * the reconcile sweep both skip it. Operators must inspect the provider's
   * Sent mailbox/API before considering a separately reviewed replacement.
   */
  private async markDeliveryUnknown(
    artifactId: string,
    reason: string,
  ): Promise<void> {
    const note =
      `delivery-unknown: ${reason}; automatic retry disabled - ` +
      `reconcile provider state before any replacement send`;
    const result = await this.prisma.outreachArtifact.updateMany({
      where: { id: artifactId, status: OutreachArtifactStatus.SENDING },
      data: {
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        reviewerNote: note.slice(0, 1000),
      },
    });
    if (result.count > 0) {
      this.logger.error(
        `Artifact ${artifactId} moved to DELIVERY_UNKNOWN - automatic dispatch is disabled pending provider reconciliation`,
      );
    }
  }

  /**
   * Single-flight wrapper around the reconcile sweep so a slow pass can't
   * stack with the next interval tick. Failures are logged, never thrown —
   * the sweep is best-effort recovery, not a correctness dependency.
   */
  private async runReconcileSweep(): Promise<void> {
    if (this.reconcileInFlight) return;
    this.reconcileInFlight = true;
    try {
      const { deliveryUnknown, requeued } =
        await this.reconcileStuckArtifacts();
      if (deliveryUnknown > 0 || requeued > 0) {
        this.logger.log(
          `Reconcile sweep: quarantined ${deliveryUnknown} stale SENDING claim(s) as DELIVERY_UNKNOWN, re-enqueued ${requeued} stranded APPROVED artifact(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Reconcile sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.reconcileInFlight = false;
    }
  }

  /**
   * Recovery sweep (public so tests can drive it deterministically, mirroring
   * GraphRunWorker.recoverOrphanedRuns):
   *
   *  1. SENDING claims whose updatedAt is older than SENDING_STALE_AGE_MS are
   *     quarantined as terminal DELIVERY_UNKNOWN. Process death does not tell
   *     us whether the provider accepted the POST, so automatic release and
   *     re-dispatch would create a duplicate-delivery window. The guarded
   *     updateMany never clobbers a row that raced terminal in the meantime.
   *  2. APPROVED rows whose updatedAt is older than APPROVED_REQUEUE_AGE_MS
   *     are re-enqueued — their BullMQ job was lost (Redis flush, enqueue
   *     failure after approve). jobId == artifactId, so a still-live job
   *     dedupes the add and the sweep stays idempotent.
   *
   * Both queries cap at RECONCILE_BATCH_LIMIT to avoid a thundering herd
   * after a long outage — the next interval picks up the remainder. This is
   * at-most-once automatic dispatch, not guaranteed exactly-once delivery.
   */
  async reconcileStuckArtifacts(): Promise<{
    deliveryUnknown: number;
    requeued: number;
  }> {
    let deliveryUnknown = 0;
    let requeued = 0;

    const staleClaims = await this.prisma.outreachArtifact.findMany({
      where: {
        status: OutreachArtifactStatus.SENDING,
        updatedAt: { lt: new Date(Date.now() - SENDING_STALE_AGE_MS) },
      },
      orderBy: { updatedAt: "asc" },
      take: RECONCILE_BATCH_LIMIT,
    });
    for (const artifact of staleClaims) {
      try {
        const quarantinedNow = await this.prisma.outreachArtifact.updateMany({
          where: { id: artifact.id, status: OutreachArtifactStatus.SENDING },
          data: {
            status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
            reviewerNote:
              "delivery-unknown: stale SENDING claim after worker/process loss; automatic retry disabled - reconcile provider state before any replacement send",
          },
        });
        // count 0 → the claim resolved between findMany and the guarded
        // transition. Leave the winning state alone.
        if (quarantinedNow.count === 0) continue;
        deliveryUnknown++;
      } catch (err) {
        this.logger.warn(
          `Failed to quarantine stale SENDING claim ${artifact.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const staleApproved = await this.prisma.outreachArtifact.findMany({
      where: {
        status: OutreachArtifactStatus.APPROVED,
        updatedAt: { lt: new Date(Date.now() - APPROVED_REQUEUE_AGE_MS) },
      },
      orderBy: { updatedAt: "asc" },
      take: RECONCILE_BATCH_LIMIT,
    });
    for (const artifact of staleApproved) {
      try {
        await this.requeueArtifact(artifact.id, artifact.orgId);
        requeued++;
      } catch (err) {
        this.logger.warn(
          `Failed to re-enqueue stale APPROVED artifact ${artifact.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { deliveryUnknown, requeued };
  }

  /**
   * Re-enqueue an artifact for the reconcile sweep, first clearing a stale
   * COMPLETED BullMQ job under the same id. jobId == artifactId for dedup,
   * but a cap-deferred send (GL8a) completes its job while the row stays
   * APPROVED — and queue.add() against a completed jobId is a silent no-op
   * until removeOnComplete prunes it (up to 24h). Removing the completed job
   * first lets the deferred retry actually enqueue. Jobs in any other state
   * (active / delayed / waiting / failed) are left alone: BullMQ owns their
   * lifecycle and the add() dedup is then the behavior we want. In-memory
   * mode (getBullQueue() === null) skips straight to enqueue, which is a
   * no-op there anyway — the poller reads the DB directly.
   */
  private async requeueArtifact(
    artifactId: string,
    orgId: string,
  ): Promise<void> {
    const bullQueue = this.queue.getBullQueue();
    if (bullQueue) {
      try {
        const existing = await bullQueue.getJob(artifactId);
        if (existing && (await existing.isCompleted())) {
          await existing.remove();
        }
      } catch (err) {
        this.logger.warn(
          `Failed to clear completed job for artifact ${artifactId} before re-enqueue: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await this.queue.enqueue({ artifactId, orgId });
  }

  /**
   * Called when BullMQ has exhausted retries. An APPROVED row is a confirmed
   * pre-dispatch/provider-rejected failure and becomes terminal FAILED. The
   * original human approval identity/timestamp remain untouched; operational
   * evidence is written to failureReason/failedAt. A row still SENDING is not
   * safe to classify: the claim-release or unknown-outcome persistence may
   * have failed, so it is quarantined as DELIVERY_UNKNOWN rather than being
   * auto-retried or called failed.
   */
  private async markTerminalFailure(
    artifactId: string,
    orgId: string,
    reason: string,
  ): Promise<void> {
    try {
      const artifact = await this.prisma.outreachArtifact.findUnique({
        where: { id: artifactId },
      });
      // Only flip if it belongs to the expected org. Every write below is
      // status-guarded so a concurrent terminal success is never clobbered.
      if (!artifact || artifact.orgId !== orgId) return;
      if (artifact.status === OutreachArtifactStatus.SENDING) {
        await this.markDeliveryUnknown(
          artifactId,
          `SENDING claim remained unresolved when BullMQ exhausted retries: ${reason}`,
        );
        return;
      }
      if (artifact.status !== OutreachArtifactStatus.APPROVED) {
        return;
      }

      const failedAt = new Date();
      const failureReason = reason.slice(0, 1000);
      const writeFirstClassFailure = failedStatusWritesEnabled();
      await this.prisma.outreachArtifact.updateMany({
        where: {
          id: artifactId,
          orgId,
          status: OutreachArtifactStatus.APPROVED,
        },
        data: writeFirstClassFailure
          ? {
              status: OutreachArtifactStatus.FAILED,
              failureReason,
              failedAt,
            }
          : {
              status: OutreachArtifactStatus.REJECTED,
              reviewerNote: `auto-failed: ${failureReason}`.slice(0, 1000),
              failureReason,
              failedAt,
            },
      });
    } catch (err) {
      this.logger.error(
        `Failed to mark terminal failure for ${artifactId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Decide whether a live failure may have been accepted by its provider.
 * Email has an explicit tool contract. LinkedIn response status proves a
 * rejection; known local credential errors prove no attempt; a status-less
 * transport failure remains ambiguous. HUBSPOT_NOTE never invokes a provider.
 */
function isAmbiguousLiveFailure(
  channel: OutreachChannel,
  result: ToolResult,
): boolean {
  if (channel === OutreachChannel.EMAIL) {
    return (
      getEmailDispatchOutcome(result) ===
        EMAIL_DISPATCH_OUTCOME.DELIVERY_UNKNOWN ||
      getEmailDispatchOutcome(result) === null
    );
  }
  if (channel === OutreachChannel.LINKEDIN) {
    if (
      !result.data ||
      typeof result.data !== "object" ||
      Array.isArray(result.data)
    ) {
      return true;
    }
    const data = result.data as Record<string, unknown>;
    if (typeof data.status === "number") return false;
    return ![
      "linkedin_not_connected",
      "linkedin_mock_credentials",
      "linkedin_circuit_open",
      "linkedin_api_not_available",
      "linkedin_recipient_not_found",
      "linkedin_invalid_request",
    ].includes(typeof data.error === "string" ? data.error : "");
  }
  return false;
}

function extractReceiptId(result: ToolResult): string | null {
  if (!result.data || typeof result.data !== "object") return null;
  const data = result.data as Record<string, unknown>;
  const id = data.messageId;
  return typeof id === "string" ? id : null;
}

function extractProvider(result: ToolResult): string | null {
  if (!result.data || typeof result.data !== "object") return null;
  const data = result.data as Record<string, unknown>;
  const provider = data.provider;
  return typeof provider === "string" ? provider : null;
}

function extractThreadId(result: ToolResult): string | null {
  if (!result.data || typeof result.data !== "object") return null;
  const data = result.data as Record<string, unknown>;
  const threadId = data.threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

function accountEmailFromCredentials(credentials: unknown): string | null {
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    return null;
  }
  const value = (credentials as Record<string, unknown>).accountEmail;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}
