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
  EmailDirection,
  EmailEventKind,
  EmailIngestSource,
  Prisma,
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
import { SuppressionService } from "../suppression/suppression.service";
import { ConfigService } from "@nestjs/config";

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
 * fall back to their mock branches. Artifacts get marked SENT with a mock
 * receipt — the audit trail records the attempt without an external call.
 */
export function isLiveSendAllowedForOrg(
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OUTREACH_LIVE_FOR_ORGS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const allowlist = new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return allowlist.has(orgId);
}

const IN_MEMORY_POLL_INTERVAL_MS = 5_000;
const IN_MEMORY_BATCH_SIZE = 10;

@Injectable()
export class SendOutreachWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendOutreachWorker.name);

  private bullWorker: Worker<SendJobData> | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  private readonly sendEmailTool: SendEmailTool;
  private readonly linkedinSendTool: LinkedInSendMessageTool;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: OutreachSendQueueService,
    private readonly integrations: IntegrationsService,
    private readonly suppressionService: SuppressionService,
    private readonly config: ConfigService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
    @Optional() private readonly linkedinService?: LinkedInService,
  ) {
    this.sendEmailTool = new SendEmailTool(this.evidenceLedger, this.config);
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
    if (
      artifact.status !== OutreachArtifactStatus.APPROVED &&
      artifact.status !== OutreachArtifactStatus.QUEUED
    ) {
      // Idempotency guard: if already SENT, REJECTED, or anything else, do
      // nothing. This is the property that makes re-running the same job safe.
      this.logger.log(
        `Artifact ${artifactId} is ${artifact.status} — already processed, skipping`,
      );
      return;
    }

    if (artifact.status === OutreachArtifactStatus.APPROVED) {
      const updated = await this.prisma.outreachArtifact.updateMany({
        where: { id: artifactId, orgId, status: OutreachArtifactStatus.APPROVED },
        data: { status: OutreachArtifactStatus.QUEUED },
      });
      if (updated.count > 0) {
        void this.evidenceLedger?.artifactStatusTransition?.({
          orgId,
          runId: artifact.graphRunId ?? null,
          artifactId,
          fromStatus: OutreachArtifactStatus.APPROVED,
          toStatus: OutreachArtifactStatus.QUEUED,
          reason: "send_worker_started",
        });
        artifact.status = OutreachArtifactStatus.QUEUED;
      }
    }

    if (artifact.channel === OutreachChannel.EMAIL) {
      const recipientEmail =
        artifact.recipientRef ??
        (typeof (artifact.payload as Record<string, unknown>)?.to === "string"
          ? String((artifact.payload as Record<string, unknown>).to)
          : null);

      if (recipientEmail && recipientEmail.includes("@")) {
        const threadId = await this.resolveProviderThreadId(artifact);
        const senderMailboxId = await this.resolveSenderMailboxId(artifact);

        const suppression = await this.suppressionService.isSuppressed({
          orgId: artifact.orgId,
          recipientEmail,
          threadId,
          senderMailboxId,
        });

        if (suppression.suppressed) {
          await this.markSuppressed(artifact, suppression.matchedEntries);
          return;
        }
      }
    }

    const statusBeforeSend = artifact.status;
    const result = await this.dispatch(artifact);
    if (!result.success) {
      // Throw so BullMQ records the failure and applies retry/backoff. Status
      // stays APPROVED/QUEUED so the next attempt re-picks it up.
      throw new Error(result.error ?? "send failed (no error message)");
    }

    const receiptId = extractReceiptId(result);
    const provider = extractProvider(result);

    if (artifact.channel === OutreachChannel.EMAIL && provider !== "outlook") {
      await this.persistOutboundEmailTelemetry(artifact, result);
      // Persistence is responsible for flipping the artifact to SENT.
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
      void this.evidenceLedger?.artifactStatusTransition?.({
        orgId: artifact.orgId,
        runId: artifact.graphRunId ?? null,
        artifactId: artifact.id,
        fromStatus: statusBeforeSend,
        toStatus: OutreachArtifactStatus.SENT,
        reason: "sent",
      });
      return;
    }

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
    void this.evidenceLedger?.artifactStatusTransition?.({
      orgId: artifact.orgId,
      runId: artifact.graphRunId ?? null,
      artifactId: artifact.id,
      fromStatus: statusBeforeSend,
      toStatus: OutreachArtifactStatus.SENT,
      reason: "sent",
    });
  }

  private async resolveProviderThreadId(
    artifact: OutreachArtifact,
  ): Promise<string | null> {
    if (!artifact.conversationId) return null;
    const convo = await this.prisma.conversation.findUnique({
      where: { id: artifact.conversationId },
      select: { orgId: true, providerThreadId: true },
    });
    if (!convo || convo.orgId !== artifact.orgId) return null;
    return convo.providerThreadId ?? null;
  }

  private async resolveSenderMailboxId(
    artifact: OutreachArtifact,
  ): Promise<string | null> {
    const payload = (artifact.payload as Record<string, unknown>) ?? {};
    const from =
      typeof payload.from === "string" && payload.from.trim().length > 0
        ? payload.from.trim()
        : null;
    if (from) return from;

    const integration = await this.prisma.integration.findUnique({
      where: { orgId_provider: { orgId: artifact.orgId, provider: "gmail" } },
      select: { credentials: true },
    });
    return readIntegrationAccountEmail(integration?.credentials) ?? null;
  }

  private async markSuppressed(
    artifact: OutreachArtifact,
    matchedEntries: readonly { id: string; kind: string; reason: string | null }[],
  ): Promise<void> {
    const now = new Date();
    const suppressionEntryIds = matchedEntries.map((e) => e.id);
    const kinds = matchedEntries.map((e) => e.kind);
    const suppressionReason = matchedEntries[0]?.reason ?? matchedEntries[0]?.kind ?? "SUPPRESSED";
    const fromStatus = artifact.status;

    await this.prisma.$transaction([
      this.prisma.outreachArtifact.update({
        where: { id: artifact.id },
        data: {
          status: OutreachArtifactStatus.SUPPRESSED,
          sentAt: null,
          sendReceiptId: null,
          suppressionReason,
        },
      }),
      this.prisma.emailEvent.create({
        data: {
          orgId: artifact.orgId,
          kind: EmailEventKind.SUPPRESSED,
          provider: "apex",
          providerMessageId: null,
          occurredAt: now,
          artifactId: artifact.id,
          conversationId: artifact.conversationId ?? null,
          meta: {
            suppressionEntryIds,
            kinds,
          } as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    void this.evidenceLedger?.artifactStatusTransition?.({
      orgId: artifact.orgId,
      runId: artifact.graphRunId ?? null,
      artifactId: artifact.id,
      fromStatus,
      toStatus: OutreachArtifactStatus.SUPPRESSED,
      reason: "suppressed",
    });

    await this.evidenceLedger?.outreachSuppressed({
      orgId: artifact.orgId,
      runId: artifact.graphRunId ?? null,
      artifactId: artifact.id,
      suppressionEntryIds,
      kinds,
    });
  }

  private async persistOutboundEmailTelemetry(
    artifact: OutreachArtifact,
    sendResult: ToolResult,
  ): Promise<void> {
    const now = new Date();
    const payload = (artifact.payload as Record<string, unknown>) ?? {};

    const receiptId = extractReceiptId(sendResult);
    const sendData = parseSendEmailResult(sendResult.data);

    const providerThreadId =
      sendData.threadId ??
      // Gmail returns a threadId on send; mock sends should still be tied to a stable synthetic thread.
      `mock_thread_${artifact.id}`;

    const integration = await this.prisma.integration.findUnique({
      where: { orgId_provider: { orgId: artifact.orgId, provider: "gmail" } },
      select: { credentials: true },
    });
    const integrationEmail = readIntegrationAccountEmail(integration?.credentials);
    const fromEmail =
      (typeof payload.from === "string" && payload.from.trim()
        ? payload.from.trim()
        : integrationEmail) ?? "unknown@send.apex";

    const toEmail =
      (typeof payload.to === "string" && payload.to.trim()
        ? payload.to.trim()
        : artifact.recipientRef) ?? null;

    if (!toEmail) {
      this.logger.error("outreach email send succeeded but recipient missing", {
        orgId: artifact.orgId,
        artifactId: artifact.id,
      });
      return;
    }

    try {
      const conversationUpsert = this.prisma.conversation.upsert({
        where: {
          orgId_provider_providerThreadId: {
            orgId: artifact.orgId,
            provider: "gmail",
            providerThreadId,
          },
        },
        create: {
          orgId: artifact.orgId,
          provider: "gmail",
          providerThreadId,
          subject: artifact.subject ?? undefined,
          lastActivityAt: now,
        },
        update: {
          lastActivityAt: now,
          ...(artifact.subject ? { subject: artifact.subject } : {}),
        },
      });

      const emailMessageCreate = this.prisma.emailMessage.create({
        data: {
          direction: EmailDirection.OUTBOUND,
          ingestSource: EmailIngestSource.APP_SEND,
          provider: "gmail",
          providerMessageId: receiptId ?? `mock_${artifact.id}`,
          providerThreadId,
          rfcMessageId: sendData.rfcMessageId,
          inReplyTo: sendData.inReplyTo,
          references: sendData.references,
          subject: artifact.subject ?? null,
          bodyText: artifact.bodyText ?? null,
          bodyHtml: artifact.bodyHtml ?? null,
          headers: {
            "Message-ID": sendData.rfcMessageId,
            "In-Reply-To": sendData.inReplyTo,
            References: sendData.references,
          } as unknown as Prisma.InputJsonValue,
          fromEmail,
          toEmails: [toEmail],
          cc: [],
          bcc: [],
          senderMailboxId: fromEmail,
          occurredAt: now,
          org: { connect: { id: artifact.orgId } },
          conversation: {
            connect: {
              orgId_provider_providerThreadId: {
                orgId: artifact.orgId,
                provider: "gmail",
                providerThreadId,
              },
            },
          },
          artifact: { connect: { id: artifact.id } },
        },
      });

      const emailEventCreate = this.prisma.emailEvent.create({
        data: {
          kind: EmailEventKind.SENT,
          provider: "gmail",
          providerMessageId: receiptId,
          occurredAt: now,
          meta: {
            providerResponse: {
              id: receiptId,
              threadId: sendData.threadId ?? providerThreadId,
            },
          } as unknown as Prisma.InputJsonValue,
          org: { connect: { id: artifact.orgId } },
          conversation: {
            connect: {
              orgId_provider_providerThreadId: {
                orgId: artifact.orgId,
                provider: "gmail",
                providerThreadId,
              },
            },
          },
          emailMessage: {
            connect: {
              orgId_provider_providerMessageId: {
                orgId: artifact.orgId,
                provider: "gmail",
                providerMessageId: receiptId ?? `mock_${artifact.id}`,
              },
            },
          },
          artifact: { connect: { id: artifact.id } },
        },
      });

      const outreachArtifactUpdate = this.prisma.outreachArtifact.update({
        where: { id: artifact.id },
        data: {
          status: OutreachArtifactStatus.SENT,
          sentAt: now,
          sendReceiptId: receiptId,
          ...(artifact.conversationId
            ? {}
            : {
                conversation: {
                  connect: {
                    orgId_provider_providerThreadId: {
                      orgId: artifact.orgId,
                      provider: "gmail",
                      providerThreadId,
                    },
                  },
                },
              }),
        },
      });

      await this.prisma.$transaction([
        conversationUpsert,
        emailMessageCreate,
        emailEventCreate,
        outreachArtifactUpdate,
      ]);
    } catch (err) {
      this.logger.error("outreach email send succeeded but persistence failed", {
        orgId: artifact.orgId,
        artifactId: artifact.id,
        sendReceiptId: receiptId,
        threadId: providerThreadId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.evidenceLedger?.outreachSendPersistenceFailed({
        orgId: artifact.orgId,
        runId: artifact.graphRunId ?? null,
        artifactId: artifact.id,
        provider: extractProvider(sendResult),
        sendReceiptId: receiptId,
        error: err instanceof Error ? err.message : String(err),
      });

      // Best-effort: avoid re-sending on retries by still marking the artifact SENT.
      try {
        await this.prisma.outreachArtifact.update({
          where: { id: artifact.id },
          data: {
            status: OutreachArtifactStatus.SENT,
            sentAt: now,
            sendReceiptId: receiptId,
          },
        });
      } catch (fallbackErr) {
        this.logger.error("outreach persistence failure fallback update failed", {
          orgId: artifact.orgId,
          artifactId: artifact.id,
          error:
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    }
  }

  /** Channel-dispatch. Add new branches as more send tools come online. */
  private async dispatch(artifact: OutreachArtifact): Promise<ToolResult> {
    // Gate: only allowlisted orgs may load real credentials. For non-listed
    // orgs we pass an empty Map, which causes the send tools to take their
    // mock branch — same shape as having no integration connected.
    const liveAllowed = isLiveSendAllowedForOrg(artifact.orgId);
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
        const integrations = await loadIntegrationsIfAllowed();
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
        return this.sendEmailTool.execute({ ...payload, artifactId: artifact.id }, context);
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
          const credentials: IntegrationCredentials = {
            provider: record.provider,
            accessToken: (decrypted.access_token as string) || "",
            refreshToken: decrypted.refresh_token as string | undefined,
            expiresAt: decrypted.expires_at as number | undefined,
            scopes: decrypted.scope as string | undefined,
          };
          if (record.provider === "gmail") {
            const accountEmail = readIntegrationAccountEmail(record.credentials);
            if (accountEmail) credentials.accountEmail = accountEmail;
          }
          integrations.set(record.provider, credentials);
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
      if (
        artifact.status !== OutreachArtifactStatus.APPROVED &&
        artifact.status !== OutreachArtifactStatus.QUEUED
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
      void this.evidenceLedger?.artifactStatusTransition?.({
        orgId,
        runId: artifact.graphRunId ?? null,
        artifactId,
        fromStatus: artifact.status,
        toStatus: OutreachArtifactStatus.REJECTED,
        reason: `auto_failed:${reason}`.slice(0, 200),
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

function parseSendEmailResult(
  data: unknown,
): {
  readonly threadId: string | null;
  readonly rfcMessageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: string[];
} {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { threadId: null, rfcMessageId: null, inReplyTo: null, references: [] };
  }
  const record = data as Record<string, unknown>;
  const threadId = typeof record.threadId === "string" ? record.threadId : null;
  const rfcMessageId =
    typeof record.rfcMessageId === "string" ? record.rfcMessageId : null;
  const inReplyTo = typeof record.inReplyTo === "string" ? record.inReplyTo : null;
  const references = Array.isArray(record.references)
    ? record.references.filter((v): v is string => typeof v === "string")
    : [];
  return { threadId, rfcMessageId, inReplyTo, references };
}

function readIntegrationAccountEmail(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    return null;
  }
  const record = credentials as Record<string, unknown>;
  const email = record.accountEmail;
  return typeof email === "string" && email.trim() ? email.trim() : null;
}
