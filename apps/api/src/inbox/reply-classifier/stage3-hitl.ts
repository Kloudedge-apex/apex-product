import type { PrismaService } from "../../prisma/prisma.service";
import type { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import type { ReplyIntent10 } from "@prisma/client";
import { Prisma } from "@prisma/client";

export const HITL_CONFIDENCE_THRESHOLD = 0.65;

export async function maybeFlagForHitl(input: {
  readonly prisma: PrismaService;
  readonly evidence: EvidenceLedgerService | undefined;
  readonly orgId: string;
  readonly replyId: string;
  readonly llmIntent: ReplyIntent10;
  readonly llmConfidence: number;
  readonly classifierName: string;
  readonly classifierVersion: string;
}): Promise<boolean> {
  if (input.llmConfidence >= HITL_CONFIDENCE_THRESHOLD) return false;

  await input.prisma.replyClassification.upsert({
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
      // Must be valid enum; the caller should have already persisted the LLM
      // row, so this create path is defensive only.
      intent: input.llmIntent,
      confidence: input.llmConfidence,
      rawOutput: { stage: "stage3", note: "late_create_from_hitl_flag" } as any,
      evidenceSpans: Prisma.JsonNull,
      latencyMs: 0,
      modelName: null,
      requiresHitl: true,
    },
    update: { requiresHitl: true },
  });

  await input.evidence?.replyClassificationNeedsReview({
    orgId: input.orgId,
    replyId: input.replyId,
    llmIntent: input.llmIntent,
    llmConfidence: input.llmConfidence,
  });

  return true;
}
