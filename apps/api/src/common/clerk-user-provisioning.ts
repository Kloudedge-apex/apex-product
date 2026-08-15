import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const CLERK_USER_DELETED_MESSAGE = "Clerk user is permanently deleted";

export async function assertClerkUserNotDeleted(
  client: Pick<PrismaService, "clerkUserLifecycle">,
  clerkUserId: string,
): Promise<void> {
  const lifecycle = await client.clerkUserLifecycle.findUnique({
    where: { clerkUserId },
    select: { deleted: true },
  });
  if (lifecycle?.deleted) {
    throw new ForbiddenException(CLERK_USER_DELETED_MESSAGE);
  }
}

/**
 * Serializes every local authority-creation path with `user.deleted` and
 * rejects a durable Clerk user tombstone before the callback may create an
 * active local principal. The lock key deliberately matches AuthService's
 * Clerk identity lock namespace.
 */
export async function withProvisionableClerkUser<T>(
  prisma: PrismaService,
  clerkUserId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`workforce-os:clerk:user:${clerkUserId}`}, 0)
      )
    `;

    await assertClerkUserNotDeleted(tx, clerkUserId);

    return operation(tx);
  });
}
