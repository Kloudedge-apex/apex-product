import { Prisma } from "@prisma/client";

type AdvisoryLockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Serializes org-scoped facts that decide whether an outreach artifact may
 * cross APPROVED -> SENDING. Every caller must already be inside a short
 * PostgreSQL transaction; the lock is released automatically at commit or
 * rollback and must never be held across provider I/O.
 */
export async function acquireOrgSendReservationLock(
  tx: AdvisoryLockClient,
  orgId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`outreach-send-reservation:${orgId}`}, 0::bigint)
    )
  `;
}
