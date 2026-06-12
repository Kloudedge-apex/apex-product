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
  OutreachArtifact,
  OutreachArtifactStatus,
  OutreachChannel,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  OutreachSendQueueService,
  OUTREACH_SEND_QUEUE_NAME,
} from "./outreach-send-queue.service";
import { SendEmailTool } from "../runtime/tools/send-email.tool";
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
// age have lost their BullMQ job (Redis flush, enqueue failure post-approve);
// SENDING claims older than the stale age belong to a worker that died
// mid-send (the window enableShutdownHooks cannot cover, e.g. OOM-kill).
const RECONCILE_INTERVAL_MS = 5 * 60_000;
const APPROVED_REQUEUE_AGE_MS = 10 * 60_000;
const SENDING_STALE_AGE_MS = 15 * 60_000;
const RECONCILE_BATCH_LIMIT = 100;

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
  ) {
    // Build the LinkedIn tool with the optional service + ledger so worker-
    // dispatched sends use the same code path as in-loop agent calls. When
    // LinkedInService is absent (e.g. dev with no IntegrationsModule wiring),
    // the tool returns a mock receipt and the artifact gets flipped to SENT
    // with a synthetic mock id — same shape as the email channel's fallback.
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
    // stranded APPROVED rows and release stale SENDING claims. Runs once at
    // boot so a restart doesn't wait a full interval to recover rows the
    // previous pod left behind.
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
   * is still APPROVED, CAS-claims it (APPROVED → SENDING) so concurrent
   * workers cannot double-dispatch, sends, and finishes the claim:
   *
   *   live send succeeded   → SENT
   *   forced-mock succeeded → SIMULATED (mock receipt kept for the audit
   *                           trail; never counted as delivered mail)
   *   dispatch failed       → claim released back to APPROVED, then rethrow
   *                           so BullMQ's retry envelope re-picks it up.
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

    // Suppression check (CAN-SPAM / GDPR e-Privacy). Audit P0 #3. If the
    // recipient has unsubscribed (or bounced / been manually suppressed)
    // since the artifact was approved, terminate the send with a SUPPRESSED
    // status instead of dispatching to the provider. Fail-closed: the
    // suppression service treats a Postgres outage as "suppressed" so a
    // DB blip cannot let a previously-unsubscribed recipient get re-mailed.
    if (artifact.recipientRef) {
      const suppressed = await this.suppression.isSuppressed(
        artifact.orgId,
        artifact.recipientRef,
      );
      if (suppressed) {
        await this.prisma.outreachArtifact.update({
          where: { id: artifactId },
          data: { status: OutreachArtifactStatus.SUPPRESSED },
        });
        this.logger.log(
          `Artifact ${artifactId} skipped — recipient ${artifact.recipientRef} is on the suppression list`,
        );
        return;
      }
    }

    // CAS claim: APPROVED → SENDING. updateMany returns a count instead of
    // throwing, so a concurrent worker that lost the race sees count === 0
    // and skips cleanly. This is what makes dispatch single-owner — the
    // findUnique status guard above is only advisory under concurrency.
    const claim = await this.prisma.outreachArtifact.updateMany({
      where: { id: artifactId, status: OutreachArtifactStatus.APPROVED },
      data: { status: OutreachArtifactStatus.SENDING },
    });
    if (claim.count === 0) {
      this.logger.log(
        `Artifact ${artifactId} already claimed by another worker — skipping`,
      );
      return;
    }

    // Evaluate the live-send gate once so the dispatch branch and the
    // terminal status cannot disagree about whether this was a real send.
    const liveAllowed = isLiveSendAllowedForOrg(artifact.orgId);

    let result: ToolResult;
    try {
      result = await this.dispatch(artifact, liveAllowed);
    } catch (err) {
      // Release the claim before rethrowing so the BullMQ retry envelope
      // still finds the row in APPROVED on the next attempt.
      await this.releaseClaim(artifactId);
      throw err;
    }
    if (!result.success) {
      // Same contract as a thrown dispatch: release, then throw so BullMQ
      // records the failure and applies retry/backoff.
      await this.releaseClaim(artifactId);
      throw new Error(result.error ?? "send failed (no error message)");
    }

    const receiptId = extractReceiptId(result);
    const provider = extractProvider(result);

    // Forced-mock sends terminate as SIMULATED, not SENT — dashboards and the
    // guarantee ledger must never count simulated traffic as delivered mail.
    // The mock_ receipt is kept so the audit trail still shows what happened,
    // but sentAt stays null: per the schema, sentAt + sendReceiptId together
    // prove a REAL send, and DashboardService.stats counts emailsSent via
    // sentAt != null.
    await this.prisma.outreachArtifact.update({
      where: { id: artifactId },
      data: liveAllowed
        ? {
            status: OutreachArtifactStatus.SENT,
            sentAt: new Date(),
            sendReceiptId: receiptId,
          }
        : {
            status: OutreachArtifactStatus.SIMULATED,
            sendReceiptId: receiptId,
          },
    });

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
          select: { id: true, name: true, physicalAddress: true, country: true, senderName: true },
        });
        if (!org) {
          throw new Error(`Org ${artifact.orgId} not found (required for email send)`);
        }
        if (liveAllowed && !org.physicalAddress) {
          throw new BadRequestException(
            `Org ${artifact.orgId} is missing physicalAddress; cannot send live email outreach until configured (CAN-SPAM §7704(a)(5)).`,
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
        return this.sendEmailTool.execute(payload, context);
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
              : artifact.recipientRef ?? "",
          body:
            typeof payload.body === "string"
              ? payload.body
              : artifact.bodyText ?? "",
        };
        if (typeof payload.integration_id === "string") {
          args.integration_id = payload.integration_id;
        }
        return this.linkedinSendTool.execute(args, context);
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
        where: { orgId, status: "CONNECTED" },
      });
      for (const record of records) {
        try {
          const decrypted = await this.integrations.refreshTokenIfNeeded(
            orgId,
            record.provider,
          );
          if (!decrypted) continue;
          integrations.set(record.provider, {
            provider: record.provider,
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

  /**
   * Releases a SENDING claim back to APPROVED after a failed dispatch. The
   * guarded updateMany (status: SENDING) means a row that somehow raced to a
   * terminal state is left untouched. Best-effort: if the release itself
   * fails (DB blip) the row stays SENDING and the reconcile sweep returns it
   * to APPROVED after SENDING_STALE_AGE_MS.
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
        } — reconcile sweep will recover it`,
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
      const { released, requeued } = await this.reconcileStuckArtifacts();
      if (released > 0 || requeued > 0) {
        this.logger.log(
          `Reconcile sweep: released ${released} stale SENDING claim(s), re-enqueued ${requeued} stranded artifact(s)`,
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
   *     released back to APPROVED and re-enqueued. A claim that old means the
   *     worker that won the CAS died before flipping the row terminal; the
   *     guarded updateMany never clobbers a row that raced to
   *     SENT/SIMULATED/SUPPRESSED in the meantime.
   *  2. APPROVED rows whose updatedAt is older than APPROVED_REQUEUE_AGE_MS
   *     are re-enqueued — their BullMQ job was lost (Redis flush, enqueue
   *     failure after approve). jobId == artifactId, so a still-live job
   *     dedupes the add and the sweep stays idempotent.
   *
   * Both queries cap at RECONCILE_BATCH_LIMIT to avoid a thundering herd
   * after a long outage — the next interval picks up the remainder.
   */
  async reconcileStuckArtifacts(): Promise<{
    released: number;
    requeued: number;
  }> {
    let released = 0;
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
        const releasedNow = await this.prisma.outreachArtifact.updateMany({
          where: { id: artifact.id, status: OutreachArtifactStatus.SENDING },
          data: { status: OutreachArtifactStatus.APPROVED },
        });
        // count 0 → the claim resolved (terminal or re-released) between the
        // findMany and the CAS — leave it alone.
        if (releasedNow.count === 0) continue;
        released++;
        await this.queue.enqueue({
          artifactId: artifact.id,
          orgId: artifact.orgId,
        });
        requeued++;
      } catch (err) {
        this.logger.warn(
          `Failed to release stale SENDING claim ${artifact.id}: ${
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
        await this.queue.enqueue({
          artifactId: artifact.id,
          orgId: artifact.orgId,
        });
        requeued++;
      } catch (err) {
        this.logger.warn(
          `Failed to re-enqueue stale APPROVED artifact ${artifact.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { released, requeued };
  }

  /**
   * Called when BullMQ has exhausted retries. There is no FAILED status on
   * OutreachArtifactStatus today (would require a prisma migrate), so we
   * reuse REJECTED with a `reviewerNote="auto-failed: <reason>"` marker as a
   * pragmatic workaround. The "auto-failed:" prefix lets the UI distinguish
   * human rejections from worker-side failures.
   *
   * TODO: once schema gains a FAILED status, switch this to that status and
   * drop the prefix convention.
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
      // Only flip if we still own the row and it belongs to the expected
      // org. "Own" means APPROVED, or a SENDING claim whose release failed —
      // jobId == artifactId keeps the job single-owner, so a SENDING row at
      // retry exhaustion can only be ours. If it raced to SENT/SIMULATED,
      // leave it alone.
      if (!artifact || artifact.orgId !== orgId) return;
      if (
        artifact.status !== OutreachArtifactStatus.APPROVED &&
        artifact.status !== OutreachArtifactStatus.SENDING
      ) {
        return;
      }

      await this.prisma.outreachArtifact.update({
        where: { id: artifactId },
        data: {
          status: OutreachArtifactStatus.REJECTED,
          reviewerNote: `auto-failed: ${reason}`.slice(0, 1000),
          reviewedAt: new Date(),
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
