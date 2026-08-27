import { OutreachArtifactStatus, Prisma } from "@prisma/client";

/**
 * States that retain the one real-reply slot for an inbound message.
 *
 * REJECTED, FAILED, SUPPRESSED, and SIMULATED are deliberately absent: none can
 * reach a live provider, so a separately reviewed replacement may be
 * created. SENT and DELIVERY_UNKNOWN remain blocking because another send
 * could duplicate a delivery that happened (or may have happened).
 */
export const REPLY_SINGLE_FLIGHT_STATUSES = [
  OutreachArtifactStatus.DRAFT,
  OutreachArtifactStatus.PENDING_REVIEW,
  OutreachArtifactStatus.APPROVED,
  OutreachArtifactStatus.SENDING,
  OutreachArtifactStatus.SENT,
  OutreachArtifactStatus.DELIVERY_UNKNOWN,
] as const;

type AdvisoryLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Locks the tenant-qualified conversation/provider-thread first, then the
 * inbound source message when one is known. The conversation-wide lock is
 * intentional: legacy REPLY rows can have a null replyToMessageId and must
 * serialize with every source-aware row before the dispatch boundary.
 *
 * Every caller must already be inside a short PostgreSQL transaction. These
 * transaction-scoped locks must never be held across LLM or provider I/O.
 */
export async function acquireReplySingleFlightLock(
  tx: AdvisoryLockClient,
  orgId: string,
  threadScope: string | readonly string[],
  sourceMessageId: string | null,
): Promise<void> {
  const threadScopes = [
    ...new Set(
      (Array.isArray(threadScope) ? threadScope : [threadScope]).filter(
        Boolean,
      ),
    ),
  ].sort();

  // Always acquire every available identity in lexical order. Modern Gmail
  // replies have both a Conversation id and provider thread id; locking both
  // makes them serialize with provider-only legacy rows without deadlocks.
  for (const scope of threadScopes) {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`outreach-reply-thread:${orgId}:${scope}`},
          0::bigint
        )
      ) IS NULL AS acquired
    `;
  }

  if (sourceMessageId) {
    for (const scope of threadScopes) {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`outreach-reply-source:${orgId}:${scope}:${sourceMessageId}`},
            0::bigint
          )
        ) IS NULL AS acquired
      `;
    }
  }
}

export function conversationReplyThreadScope(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function providerReplyThreadScope(providerThreadId: string): string {
  return `provider-thread:${providerThreadId}`;
}
