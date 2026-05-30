import { Injectable, Logger } from "@nestjs/common";
import { Prisma, ReplyIntent10 } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { LangSmithService } from "../../observability/langsmith.service";
import { LLMService } from "../../runtime/llm.service";
import { classifyDeterministic } from "./stage1-deterministic";
import { classifyWithLlm } from "./stage2-llm";
import { maybeFlagForHitl } from "./stage3-hitl";

export const STAGE1_CLASSIFIER_NAME = "deterministic";
export const STAGE1_CLASSIFIER_VERSION = "1.0.0";

export const STAGE2_CLASSIFIER_NAME = "llm-v1";
export const STAGE2_CLASSIFIER_VERSION = "1.0.0";

@Injectable()
export class ReplyClassifierService {
  private readonly logger = new Logger(ReplyClassifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly langsmith: LangSmithService,
    private readonly llm: LLMService,
    private readonly evidence: EvidenceLedgerService,
  ) {}

  private async upsertClassification(input: {
    readonly orgId: string;
    readonly replyId: string;
    readonly classifierName: string;
    readonly classifierVersion: string;
    readonly intent: ReplyIntent10;
    readonly confidence: number;
    readonly rawOutput: unknown;
    readonly evidenceSpans?: unknown;
    readonly latencyMs: number;
    readonly modelName: string | null;
    readonly requiresHitl: boolean;
  }): Promise<void> {
    await this.prisma.replyClassification.upsert({
      where: {
        replyId_classifierName_classifierVersion: {
          replyId: input.replyId,
          classifierName: input.classifierName,
          classifierVersion: input.classifierVersion,
        },
      },
      create: {
        orgId: input.orgId,
        replyId: input.replyId,
        classifierName: input.classifierName,
        classifierVersion: input.classifierVersion,
        intent: input.intent,
        confidence: input.confidence,
        rawOutput: input.rawOutput as Prisma.InputJsonValue,
        evidenceSpans: (input.evidenceSpans ?? null) as Prisma.InputJsonValue,
        latencyMs: input.latencyMs,
        modelName: input.modelName,
        requiresHitl: input.requiresHitl,
      },
      update: {
        intent: input.intent,
        confidence: input.confidence,
        rawOutput: input.rawOutput as Prisma.InputJsonValue,
        evidenceSpans: (input.evidenceSpans ?? null) as Prisma.InputJsonValue,
        latencyMs: input.latencyMs,
        modelName: input.modelName,
        requiresHitl: input.requiresHitl,
      },
    });
  }

  async classifyReply(input: {
    readonly orgId: string;
    readonly replyId: string;
  }): Promise<void> {
    const reply = await this.prisma.reply.findFirst({
      where: { id: input.replyId, orgId: input.orgId },
      include: { emailMessage: true },
    });
    if (!reply) {
      this.logger.warn(`Reply ${input.replyId} not found for org ${input.orgId}`);
      return;
    }

    const email = reply.emailMessage;
    const headers =
      email.headers && Array.isArray(email.headers)
        ? (email.headers as unknown as Array<{ name?: string; value?: string }>)
        : [];
    const headerBag: Record<string, string> = {};
    for (const h of headers) {
      if (!h?.name) continue;
      headerBag[h.name.trim().toLowerCase()] = String(h.value ?? "");
    }

    const bodyText = email.bodyText ?? "";

    const startedStage1 = Date.now();
    const stage1 = classifyDeterministic({
      fromEmail: email.fromEmail,
      subject: email.subject,
      bodyText,
      headers: headerBag,
    });
    const stage1Latency = Date.now() - startedStage1;

    if (stage1) {
      await this.upsertClassification({
        orgId: input.orgId,
        replyId: reply.id,
        classifierName: STAGE1_CLASSIFIER_NAME,
        classifierVersion: STAGE1_CLASSIFIER_VERSION,
        intent: stage1.intent,
        confidence: stage1.confidence,
        rawOutput: stage1.rawOutput,
        evidenceSpans: stage1.evidenceSpans,
        latencyMs: stage1Latency,
        modelName: null,
        requiresHitl: false,
      });

      await this.evidence.replyClassified({
        orgId: input.orgId,
        replyId: reply.id,
        intent: stage1.intent,
        confidence: stage1.confidence,
        classifierName: STAGE1_CLASSIFIER_NAME,
      });
      return;
    }

    const stage2 = await classifyWithLlm(this.langsmith, this.llm, {
      orgId: input.orgId,
      replyId: reply.id,
      subject: email.subject,
      bodyText,
    });

    await this.upsertClassification({
      orgId: input.orgId,
      replyId: reply.id,
      classifierName: STAGE2_CLASSIFIER_NAME,
      classifierVersion: STAGE2_CLASSIFIER_VERSION,
      intent: stage2.intent,
      confidence: stage2.confidence,
      rawOutput: stage2.rawOutput,
      evidenceSpans: stage2.evidenceSpans,
      latencyMs: stage2.latencyMs,
      modelName: stage2.modelName,
      requiresHitl: false,
    });

    await this.evidence.replyClassified({
      orgId: input.orgId,
      replyId: reply.id,
      intent: stage2.intent,
      confidence: stage2.confidence,
      classifierName: STAGE2_CLASSIFIER_NAME,
    });

    const needsHitl = await maybeFlagForHitl({
      prisma: this.prisma,
      evidence: this.evidence,
      orgId: input.orgId,
      replyId: reply.id,
      llmIntent: stage2.intent,
      llmConfidence: stage2.confidence,
      classifierName: STAGE2_CLASSIFIER_NAME,
      classifierVersion: STAGE2_CLASSIFIER_VERSION,
    });

    if (needsHitl) {
      this.logger.log(
        `Reply ${reply.id} requires HITL (confidence=${stage2.confidence.toFixed(3)})`,
      );
    }
  }
}

