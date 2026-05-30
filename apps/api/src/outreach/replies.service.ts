import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Prisma, ReplyIntent10 } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ReplyIntentEffectsService } from "../inbox/reply-intent-effects.service";

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

@Injectable()
export class RepliesService {
  private readonly logger = new Logger(RepliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intentEffects: ReplyIntentEffectsService,
  ) {}

  async listRequiresHitl(orgId: string, limit = 50): Promise<{
    replies: Array<{
      id: string;
      artifactId: string | null;
      conversationId: string;
      isOrphan: boolean;
      receivedAt: Date;
      fromEmail: string;
      subject: string | null;
      bodyText: string | null;
      latestClassification: {
        id: string;
        classifierName: string;
        classifierVersion: string;
        intent: ReplyIntent10;
        confidence: number;
        requiresHitl: boolean;
        createdAt: Date;
      };
    }>;
  }> {
    const latest = await this.prisma.replyClassification.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      distinct: ["replyId"],
      take: Math.min(500, Math.max(1, limit) * 10),
      select: {
        id: true,
        replyId: true,
        classifierName: true,
        classifierVersion: true,
        intent: true,
        confidence: true,
        requiresHitl: true,
        createdAt: true,
      },
    });

    const hitl = latest.filter((c) => c.requiresHitl === true).slice(0, Math.max(1, limit));
    const replyIds = hitl.map((c) => c.replyId);
    if (replyIds.length === 0) return { replies: [] };

    const replies = await this.prisma.reply.findMany({
      where: { orgId, id: { in: replyIds } },
      orderBy: { receivedAt: "desc" },
      take: Math.max(1, limit),
      select: {
        id: true,
        artifactId: true,
        conversationId: true,
        isOrphan: true,
        receivedAt: true,
        emailMessage: {
          select: { fromEmail: true, subject: true, bodyText: true },
        },
      },
    });

    const byReplyId = new Map(hitl.map((c) => [c.replyId, c]));
    return {
      replies: replies
        .map((r) => {
          const cls = byReplyId.get(r.id);
          if (!cls) return null;
          return {
            id: r.id,
            artifactId: r.artifactId ?? null,
            conversationId: r.conversationId,
            isOrphan: r.isOrphan,
            receivedAt: r.receivedAt,
            fromEmail: r.emailMessage.fromEmail,
            subject: r.emailMessage.subject ?? null,
            bodyText: r.emailMessage.bodyText ?? null,
            latestClassification: {
              id: cls.id,
              classifierName: cls.classifierName,
              classifierVersion: cls.classifierVersion,
              intent: cls.intent,
              confidence: cls.confidence,
              requiresHitl: cls.requiresHitl,
              createdAt: cls.createdAt,
            },
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null),
    };
  }

  async resolveHitl(
    orgId: string,
    replyId: string,
    input: { intentOverride: ReplyIntent10; note?: string | null },
  ): Promise<{ classificationId: string }> {
    const reply = await this.prisma.reply.findFirst({
      where: { id: replyId, orgId },
      select: { id: true },
    });
    if (!reply) throw new BadRequestException("Reply not found");

    const payload: Prisma.InputJsonValue = {
      intentOverride: input.intentOverride,
      note: input.note ?? null,
    };

    try {
      const created = await this.prisma.replyClassification.create({
        data: {
          orgId,
          replyId,
          classifierName: "human",
          classifierVersion: "1.0.0",
          intent: input.intentOverride,
          confidence: 1.0,
          rawOutput: payload,
          evidenceSpans: Prisma.DbNull,
          latencyMs: 0,
          modelName: null,
          requiresHitl: false,
        },
        select: { id: true },
      });

      await this.intentEffects.applyLatest(orgId, replyId);
      return { classificationId: created.id };
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        const existing = await this.prisma.replyClassification.findUnique({
          where: {
            replyId_classifierName_classifierVersion: {
              replyId,
              classifierName: "human",
              classifierVersion: "1.0.0",
            },
          },
          select: { id: true, orgId: true },
        });
        if (existing && existing.orgId === orgId) {
          return { classificationId: existing.id };
        }
      }
      this.logger.warn(
        `resolveHitl failed (orgId=${orgId} replyId=${replyId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }
}
