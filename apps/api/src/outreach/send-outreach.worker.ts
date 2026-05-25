import {
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

const IN_MEMORY_POLL_INTERVAL_MS = 5_000;
const IN_MEMORY_BATCH_SIZE = 10;

@Injectable()
export class SendOutreachWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendOutreachWorker.name);

  private bullWorker: Worker<SendJobData> | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  private readonly sendEmailTool = new SendEmailTool();
  private readonly linkedinSendTool: LinkedInSendMessageTool;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: OutreachSendQueueService,
    private readonly integrations: IntegrationsService,
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
  }

  async onModuleDestroy(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
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
   * is still APPROVED, dispatches the send, and either marks SENT or rethrows
   * to trigger BullMQ retry.
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

    const result = await this.dispatch(artifact);
    if (!result.success) {
      // Throw so BullMQ records the failure and applies retry/backoff. Status
      // stays APPROVED so the next attempt re-picks it up.
      throw new Error(result.error ?? "send failed (no error message)");
    }

    const receiptId = extractReceiptId(result);
    const provider = extractProvider(result);

    await this.prisma.outreachArtifact.update({
      where: { id: artifactId },
      data: {
        status: OutreachArtifactStatus.SENT,
        sentAt: new Date(),
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

  /** Channel-dispatch. Add new branches as more send tools come online. */
  private async dispatch(artifact: OutreachArtifact): Promise<ToolResult> {
    switch (artifact.channel) {
      case OutreachChannel.EMAIL: {
        const integrations = await this.loadIntegrations(artifact.orgId);
        const context: ToolContext = {
          orgId: artifact.orgId,
          // No agent/run context post-approval — we're dispatching a human
          // approved artifact, not an agent step. The tool only uses these
          // fields opportunistically.
          agentId: "outreach-worker",
          runId: artifact.graphRunId ?? "outreach-worker",
          integrations,
        };
        const payload = artifact.payload as Record<string, unknown>;
        return this.sendEmailTool.execute(payload, context);
      }
      case OutreachChannel.LINKEDIN: {
        const integrations = await this.loadIntegrations(artifact.orgId);
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
      // Only flip if we still own the row (still APPROVED) and it belongs to
      // the expected org. If it raced to SENT, leave it alone.
      if (!artifact || artifact.orgId !== orgId) return;
      if (artifact.status !== OutreachArtifactStatus.APPROVED) return;

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
