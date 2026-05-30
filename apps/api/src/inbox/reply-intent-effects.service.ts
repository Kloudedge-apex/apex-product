import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  OutreachArtifactStatus,
  ReplyIntent10,
  SuppressionKind,
  SuppressionScope,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import { SuppressionService } from "../suppression/suppression.service";

const HIGH_CONFIDENCE = 0.8;
const OOO_COOLDOWN_DAYS = 14;

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

@Injectable()
export class ReplyIntentEffectsService {
  private readonly logger = new Logger(ReplyIntentEffectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
    @Optional() private readonly evidence?: EvidenceLedgerService,
  ) {}

  /**
   * Apply side-effects for the most recent ReplyClassification on a Reply.
   *
   * This is intentionally safe to call multiple times: suppression writes are
   * deduped by partial unique indexes, and artifact status updates are
   * conditional.
   */
  async applyLatest(orgId: string, replyId: string): Promise<void> {
    const reply = await this.prisma.reply.findFirst({
      where: { id: replyId, orgId },
      select: {
        id: true,
        orgId: true,
        artifactId: true,
        emailMessage: { select: { fromEmail: true } },
        classifications: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            classifierName: true,
            classifierVersion: true,
            intent: true,
            confidence: true,
            requiresHitl: true,
            createdAt: true,
          },
        },
      },
    });
    if (!reply) return;
    const cls = reply.classifications[0];
    if (!cls) return;

    const shouldApply =
      cls.classifierName === "human" ||
      (cls.requiresHitl === false && (cls.confidence ?? 0) >= HIGH_CONFIDENCE);

    if (!shouldApply) return;

    const fromEmail = reply.emailMessage?.fromEmail;
    if (!fromEmail || fromEmail.length === 0) {
      this.logger.warn("Reply has no fromEmail; skipping intent side-effects", {
        orgId,
        replyId,
        classificationId: cls.id,
        intent: cls.intent,
      });
      return;
    }

    switch (cls.intent) {
      case ReplyIntent10.unsubscribe: {
        await this.suppression.add({
          orgId,
          scope: SuppressionScope.ORG,
          kind: SuppressionKind.UNSUBSCRIBE,
          subjectEmail: fromEmail,
          source: "intent-classified",
          reason: "reply_intent:unsubscribe",
        });
        return;
      }
      case ReplyIntent10.negative_not_interested: {
        await this.suppression.add({
          orgId,
          scope: SuppressionScope.ORG,
          kind: SuppressionKind.CRM_INACTIVE,
          subjectEmail: fromEmail,
          source: "intent-classified",
          reason: "reply_intent:negative_not_interested",
        });
        return;
      }
      case ReplyIntent10.auto_reply_ooo: {
        const now = new Date();
        await this.suppression.add({
          orgId,
          scope: SuppressionScope.ORG,
          kind: SuppressionKind.OOO_COOLDOWN,
          subjectEmail: fromEmail,
          expiresAt: addDays(now, OOO_COOLDOWN_DAYS),
          source: "intent-classified",
          reason: "reply_intent:auto_reply_ooo",
        });
        return;
      }
      case ReplyIntent10.spam_or_legal_threat: {
        await this.suppression.add({
          orgId,
          scope: SuppressionScope.ORG,
          kind: SuppressionKind.LEGAL,
          subjectEmail: fromEmail,
          source: "intent-classified",
          reason: "reply_intent:spam_or_legal_threat",
        });
        void this.evidence?.replyFlaggedForReview?.({
          orgId,
          runId: null,
          replyId: reply.id,
          intent: ReplyIntent10.spam_or_legal_threat,
          reason: "intent_classified:spam_or_legal_threat",
        });
        return;
      }
      case ReplyIntent10.bounce_or_ndr: {
        if (!reply.artifactId) return;
        const artifactBefore = await this.prisma.outreachArtifact.findFirst({
          where: { orgId, id: reply.artifactId },
          select: { status: true, graphRunId: true },
        });
        const updated = await this.prisma.outreachArtifact.updateMany({
          where: {
            orgId,
            id: reply.artifactId,
            status: {
              in: [
                OutreachArtifactStatus.SENT,
                OutreachArtifactStatus.QUEUED,
                OutreachArtifactStatus.REPLIED,
              ],
            },
          },
          data: { status: OutreachArtifactStatus.BOUNCED },
        });
        if (updated.count > 0 && artifactBefore) {
          void this.evidence?.artifactStatusTransition?.({
            orgId,
            runId: artifactBefore.graphRunId ?? null,
            artifactId: reply.artifactId,
            fromStatus: artifactBefore.status,
            toStatus: OutreachArtifactStatus.BOUNCED,
            reason: "intent_classified:bounce_or_ndr",
          });
        }
        return;
      }

      // Intents that should not auto-suppress by default.
      case ReplyIntent10.positive_interest:
      case ReplyIntent10.question_or_objection:
      case ReplyIntent10.referral:
      case ReplyIntent10.not_now:
      case ReplyIntent10.wrong_person:
      default:
        return;
    }
  }
}
