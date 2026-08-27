import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { hasRequiredClerkOrgSession } from "../common/org-role-authority";

interface ClerkWebhookEvent {
  type: string;
  data: unknown;
}

export interface ClerkWebhookDelivery {
  id: string;
  timestampSeconds: number;
}

interface ClerkOrganization {
  id: string;
  name: string;
  slug: string;
  eventVersion: bigint;
}

type ClerkLocalRole =
  | typeof UserRole.ADMIN
  | typeof UserRole.MANAGER
  | typeof UserRole.MEMBER;

interface ClerkMembership {
  id: string;
  userId: string;
  organizationId: string;
  email: string;
  role: ClerkLocalRole;
  eventVersion: bigint;
}

type MembershipEventType = "created" | "updated" | "deleted";
type OrganizationEventType = "created" | "updated";

interface VersionedLifecycle {
  eventVersion: bigint;
  eventRank: number;
  lastEventId: string;
}

interface MembershipLifecycle extends VersionedLifecycle {
  clerkUserId: string;
  clerkOrgId: string;
  role: UserRole;
  deleted: boolean;
}

interface UserLifecycleCursor {
  deleted: boolean;
  clerkMembershipId: string | null;
  clerkOrgId: string | null;
  membershipEventVersion: bigint | null;
  membershipEventRank: number | null;
  membershipActive: boolean;
  role: UserRole;
  lastEventId: string;
}

const EVENT_RANK = {
  created: 1,
  updated: 2,
  deleted: 3,
} as const;

const SHA256_EVIDENCE = /^sha256:[0-9a-f]{64}$/;
const UNARMED_CUTOVER_VERSION = 9223372036854775807n;
const MAX_SAFE_EVENT_VERSION = BigInt(Number.MAX_SAFE_INTEGER);
const CUTOVER_CLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

const SAFE_AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
  org: {
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      clerkOrgId: true,
    },
  },
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getUserByClerkId(
    clerkId: string,
    claims: { clerkOrgId?: string; clerkOrgRole?: string } = {},
  ) {
    const user = await this.prisma.user.findFirst({
      where: { clerkId, membershipActive: true },
      select: SAFE_AUTH_USER_SELECT,
    });
    if (!user) throw new NotFoundException("User not found");
    if (!hasRequiredClerkOrgSession(user.org.clerkOrgId, claims)) {
      throw new ForbiddenException("Active Clerk organization session required");
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      org: {
        id: user.org.id,
        name: user.org.name,
        slug: user.org.slug,
        plan: user.org.plan,
      },
    };
  }

  async handleWebhook(body: unknown, delivery?: ClerkWebhookDelivery) {
    const event = body as Partial<ClerkWebhookEvent>;
    if (typeof event.type !== "string") return { received: true };

    switch (event.type) {
      case "user.created":
        // User<->org linkage happens on organizationMembership.created.
        return { received: true };

      case "user.deleted": {
        const verifiedDelivery = requireDelivery(delivery);
        await this.deactivateDeletedUser(event.data, verifiedDelivery);
        return { received: true };
      }

      case "organization.created":
      case "organization.updated": {
        const verifiedDelivery = requireDelivery(delivery);
        const eventType: OrganizationEventType =
          event.type === "organization.created" ? "created" : "updated";
        await this.syncOrganization(
          parseOrganization(event.data),
          eventType,
          verifiedDelivery.id,
        );
        return { received: true };
      }

      case "organization.deleted": {
        const verifiedDelivery = requireDelivery(delivery);
        await this.deactivateOrganization(event.data, verifiedDelivery);
        return { received: true };
      }

      case "organizationMembership.created":
      case "organizationMembership.updated":
      case "organizationMembership.deleted": {
        const verifiedDelivery = requireDelivery(delivery);
        const eventType: MembershipEventType =
          event.type === "organizationMembership.created"
            ? "created"
            : event.type === "organizationMembership.updated"
              ? "updated"
              : "deleted";
        await this.applyMembershipEvent(
          parseMembership(event.data),
          eventType,
          verifiedDelivery.id,
        );
        return { received: true };
      }

      default:
        return { received: true };
    }
  }

  private async syncOrganization(
    data: ClerkOrganization,
    eventType: OrganizationEventType,
    eventId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await acquireIdentityLocks(tx, [`org:${data.id}`]);

      if (!(await acceptsAuthorityEvent(tx, data.eventVersion))) return;

      const existing = await tx.clerkOrganizationLifecycle.findUnique({
        where: { clerkOrgId: data.id },
      });
      const incoming = {
        eventVersion: data.eventVersion,
        eventRank: EVENT_RANK[eventType],
        lastEventId: eventId,
      };

      // Clerk ids are immutable. Once deletion is observed, no later delivery
      // may recreate the same external tenant.
      if (existing?.deleted || !isNewerLifecycle(existing, incoming)) return;

      if (existing) {
        await tx.clerkOrganizationLifecycle.update({
          where: { clerkOrgId: data.id },
          data: { ...incoming, deleted: false },
        });
      } else {
        await tx.clerkOrganizationLifecycle.create({
          data: { clerkOrgId: data.id, ...incoming, deleted: false },
        });
      }

      // The immutable Clerk id is the only external binding authority. A
      // human slug can change or collide with an unrelated internal tenant.
      await tx.org.upsert({
        where: { clerkOrgId: data.id },
        create: {
          clerkOrgId: data.id,
          name: data.name,
          slug: data.slug,
        },
        update: {
          name: data.name,
          slug: data.slug,
        },
      });
    });
  }

  private async deactivateOrganization(
    value: unknown,
    delivery: ClerkWebhookDelivery,
  ): Promise<void> {
    const clerkOrgId = requiredString(
      asRecord(value)["id"],
      "organization.deleted id",
    );
    const incoming = {
      eventVersion: deliveryVersion(delivery),
      eventRank: EVENT_RANK.deleted,
      lastEventId: delivery.id,
    };

    await this.prisma.$transaction(async (tx) => {
      await acquireIdentityLocks(tx, [`org:${clerkOrgId}`]);
      const existing = await tx.clerkOrganizationLifecycle.findUnique({
        where: { clerkOrgId },
      });

      if (!existing) {
        await tx.clerkOrganizationLifecycle.create({
          data: { clerkOrgId, ...incoming, deleted: true },
        });
      } else if (!existing.deleted) {
        await tx.clerkOrganizationLifecycle.update({
          where: { clerkOrgId },
          data: { ...incoming, deleted: true },
        });
      }

      const org = await tx.org.findUnique({
        where: { clerkOrgId },
        select: { id: true },
      });
      if (!org) return;

      // Preserve tenant data for operator reconciliation, but revoke every
      // local principal even if membership.deleted deliveries are delayed.
      await tx.user.updateMany({
        where: { orgId: org.id },
        data: { membershipActive: false, role: UserRole.MEMBER },
      });
    });
  }

  private async applyMembershipEvent(
    data: ClerkMembership,
    eventType: MembershipEventType,
    eventId: string,
  ): Promise<void> {
    const eventRank = EVENT_RANK[eventType];
    const knownMembership =
      await this.prisma.clerkMembershipLifecycle.findUnique({
        where: { clerkMembershipId: data.id },
        select: { clerkUserId: true, clerkOrgId: true },
      });

    await this.prisma.$transaction(async (tx) => {
      // Organization first gives organization.deleted a single serialization
      // boundary with every grant. Canonical acquisition avoids lock drift.
      await acquireIdentityLocks(tx, [
        `org:${data.organizationId}`,
        `user:${data.userId}`,
        `membership:${data.id}`,
        ...(knownMembership
          ? [
              `org:${knownMembership.clerkOrgId}`,
              `user:${knownMembership.clerkUserId}`,
            ]
          : []),
      ]);

      if (
        eventType !== "deleted" &&
        !(await acceptsAuthorityEvent(tx, data.eventVersion))
      ) {
        return;
      }

      const existingMembership =
        await tx.clerkMembershipLifecycle.findUnique({
          where: { clerkMembershipId: data.id },
        });
      const incoming = {
        eventVersion: data.eventVersion,
        eventRank,
        lastEventId: eventId,
      };

      if (
        existingMembership &&
        (existingMembership.clerkUserId !== data.userId ||
          existingMembership.clerkOrgId !== data.organizationId)
      ) {
        if (
          !knownMembership ||
          knownMembership.clerkUserId !== existingMembership.clerkUserId ||
          knownMembership.clerkOrgId !== existingMembership.clerkOrgId
        ) {
          // The row appeared or changed after the pre-read, so this transaction
          // does not hold every original tuple lock. Roll back and let Clerk
          // retry; the next attempt will acquire the complete lock set.
          throw new ServiceUnavailableException(
            "Clerk membership identity changed during synchronization",
          );
        }
        await quarantineMembershipTuple(
          tx,
          existingMembership,
          data,
          incoming,
        );
        this.logger.error(
          `Quarantined Clerk membership ${data.id}: immutable identity tuple changed`,
        );
        return;
      }

      if (
        !shouldApplyMembershipLifecycle(
          existingMembership,
          incoming,
          data.role,
        )
      ) {
        return;
      }

      await persistMembershipLifecycle(
        tx,
        existingMembership,
        data,
        incoming,
        eventType === "deleted",
      );

      const userCursor = await tx.clerkUserLifecycle.findUnique({
        where: { clerkUserId: data.userId },
      });
      if (userCursor?.deleted) {
        this.logger.warn(
          `Ignored Clerk membership ${data.id}: user is permanently deleted`,
        );
        return;
      }

      const orgLifecycle =
        await tx.clerkOrganizationLifecycle.findUnique({
          where: { clerkOrgId: data.organizationId },
        });
      const org = await tx.org.findUnique({
        where: { clerkOrgId: data.organizationId },
        select: { id: true },
      });

      if (
        eventType !== "deleted" &&
        (!orgLifecycle || orgLifecycle.deleted || !org)
      ) {
        throw new ServiceUnavailableException(
          "Clerk organization lifecycle is not synchronized",
        );
      }

      const localUser = await tx.user.findUnique({
        where: { clerkId: data.userId },
        select: {
          id: true,
          orgId: true,
          role: true,
          clerkMembershipId: true,
          membershipActive: true,
        },
      });

      if (org && localUser && localUser.orgId !== org.id) {
        // The current local schema is one-user/one-tenant. A second Clerk org
        // must never silently move a principal across tenant boundaries.
        this.logger.warn(
          `Ignored Clerk membership ${data.id}: user is bound to another tenant`,
        );
        return;
      }

      if (eventType === "created") {
        if (!org) return;
        if (!shouldAdvanceUserCursor(userCursor, data, eventRank)) return;

        await persistUserCursor(tx, userCursor, data, incoming, true);
        if (!localUser) {
          await tx.user.create({
            data: {
              clerkId: data.userId,
              clerkMembershipId: data.id,
              membershipActive: true,
              orgId: org.id,
              email: data.email || `${data.userId}@no-email.workforceos.local`,
              role: data.role,
            },
          });
          return;
        }

        await tx.user.update({
          where: { id: localUser.id },
          data: {
            clerkMembershipId: data.id,
            membershipActive: true,
            role: nextLocalRole(localUser.role, data.role),
          },
        });
        return;
      }

      if (eventType === "updated") {
        if (
          !org ||
          !localUser ||
          !userCursor?.membershipActive ||
          userCursor.clerkMembershipId !== data.id ||
          !shouldAdvanceUserCursor(userCursor, data, eventRank)
        ) {
          // Updates never create or reactivate authority. A missing create
          // stays fail closed until Clerk retries that original event.
          this.logger.warn(
            `Ignored unsynchronized Clerk membership update ${data.id}`,
          );
          throw new ServiceUnavailableException(
            "Clerk membership create has not been synchronized",
          );
        }

        await persistUserCursor(tx, userCursor, data, incoming, true);
        await tx.user.update({
          where: { id: localUser.id },
          data: {
            clerkMembershipId: data.id,
            role: nextLocalRole(localUser.role, data.role),
          },
        });
        return;
      }

      // A delete for membership A cannot revoke a newer membership B. It is
      // still retained above as A's permanent tombstone.
      if (
        userCursor?.clerkMembershipId &&
        userCursor.clerkMembershipId !== data.id
      ) {
        return;
      }
      if (
        userCursor &&
        !shouldAdvanceUserCursor(userCursor, data, eventRank)
      ) {
        return;
      }

      await persistUserCursor(tx, userCursor, data, incoming, false);
      if (!localUser) return;
      if (
        localUser.clerkMembershipId !== null &&
        localUser.clerkMembershipId !== data.id
      ) {
        return;
      }

      await tx.user.update({
        where: { id: localUser.id },
        data: {
          clerkMembershipId: data.id,
          membershipActive: false,
          role: UserRole.MEMBER,
        },
      });
    });
  }

  private async deactivateDeletedUser(
    value: unknown,
    delivery: ClerkWebhookDelivery,
  ): Promise<void> {
    const clerkUserId = requiredString(
      asRecord(value)["id"],
      "user.deleted id",
    );

    await this.prisma.$transaction(async (tx) => {
      await acquireIdentityLocks(tx, [`user:${clerkUserId}`]);
      const existing = await tx.clerkUserLifecycle.findUnique({
        where: { clerkUserId },
      });
      const eventVersion = deliveryVersion(delivery);

      if (existing) {
        await tx.clerkUserLifecycle.update({
          where: { clerkUserId },
          data: {
            deleted: true,
            membershipActive: false,
            role: UserRole.MEMBER,
            membershipEventVersion: eventVersion,
            membershipEventRank: EVENT_RANK.deleted,
            lastEventId: delivery.id,
          },
        });
      } else {
        await tx.clerkUserLifecycle.create({
          data: {
            clerkUserId,
            deleted: true,
            membershipActive: false,
            role: UserRole.MEMBER,
            membershipEventVersion: eventVersion,
            membershipEventRank: EVENT_RANK.deleted,
            lastEventId: delivery.id,
          },
        });
      }

      await tx.user.updateMany({
        where: { clerkId: clerkUserId },
        data: { membershipActive: false, role: UserRole.MEMBER },
      });
    });
  }
}

async function acquireIdentityLocks(
  tx: Prisma.TransactionClient,
  lockKeys: string[],
): Promise<void> {
  const lockOrder = { org: 0, user: 1, membership: 2 } as const;
  const keys = [...new Set(lockKeys)].sort((left, right) => {
    const leftType = left.split(":", 1)[0] as keyof typeof lockOrder;
    const rightType = right.split(":", 1)[0] as keyof typeof lockOrder;
    const priority = lockOrder[leftType] - lockOrder[rightType];
    return priority || left.localeCompare(right);
  });
  for (const key of keys) {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`workforce-os:clerk:${key}`}, 0)) IS NULL AS acquired
    `;
  }
}

async function acceptsAuthorityEvent(
  tx: Prisma.TransactionClient,
  eventVersion: bigint,
): Promise<boolean> {
  const cutover = await tx.clerkIdentityCutover.findUnique({
    where: { id: 1 },
    select: {
      minimumEventVersion: true,
      ready: true,
      inventoryEvidenceHash: true,
      expectedActiveOrganizationCount: true,
      expectedActiveMembershipCount: true,
      expectedActiveUserCount: true,
      establishedAt: true,
    },
  });
  if (
    !cutover?.ready ||
    cutover.minimumEventVersion <= 0n ||
    cutover.minimumEventVersion > MAX_SAFE_EVENT_VERSION ||
    cutover.minimumEventVersion === UNARMED_CUTOVER_VERSION ||
    !Number.isFinite(cutover.establishedAt.getTime()) ||
    Math.abs(
      Number(cutover.minimumEventVersion) - cutover.establishedAt.getTime(),
    ) > CUTOVER_CLOCK_WINDOW_MS ||
    !cutover.inventoryEvidenceHash ||
    !SHA256_EVIDENCE.test(cutover.inventoryEvidenceHash) ||
    !Number.isSafeInteger(cutover.expectedActiveOrganizationCount) ||
    cutover.expectedActiveOrganizationCount < 0 ||
    !Number.isSafeInteger(cutover.expectedActiveMembershipCount) ||
    cutover.expectedActiveMembershipCount < 0 ||
    !Number.isSafeInteger(cutover.expectedActiveUserCount) ||
    cutover.expectedActiveUserCount < 0
  ) {
    throw new ServiceUnavailableException(
      "Clerk identity cutover is not ready",
    );
  }
  return eventVersion >= cutover.minimumEventVersion;
}

async function persistMembershipLifecycle(
  tx: Prisma.TransactionClient,
  existing: MembershipLifecycle | null,
  data: ClerkMembership,
  incoming: VersionedLifecycle,
  deleted: boolean,
): Promise<void> {
  const lifecycle = {
    clerkUserId: data.userId,
    clerkOrgId: data.organizationId,
    ...incoming,
    role: data.role,
    deleted,
  };
  if (existing) {
    await tx.clerkMembershipLifecycle.update({
      where: { clerkMembershipId: data.id },
      data: lifecycle,
    });
  } else {
    await tx.clerkMembershipLifecycle.create({
      data: { clerkMembershipId: data.id, ...lifecycle },
    });
  }
}

async function quarantineMembershipTuple(
  tx: Prisma.TransactionClient,
  existing: MembershipLifecycle,
  incoming: ClerkMembership,
  incomingEvent: VersionedLifecycle,
): Promise<void> {
  const eventVersion =
    incomingEvent.eventVersion > existing.eventVersion
      ? incomingEvent.eventVersion
      : existing.eventVersion;
  await tx.clerkMembershipLifecycle.update({
    where: { clerkMembershipId: incoming.id },
    data: {
      eventVersion,
      eventRank: EVENT_RANK.deleted,
      role: UserRole.MEMBER,
      deleted: true,
      lastEventId: incomingEvent.lastEventId,
    },
  });

  const cursor = await tx.clerkUserLifecycle.findUnique({
    where: { clerkUserId: existing.clerkUserId },
  });
  if (cursor?.clerkMembershipId === incoming.id) {
    const cursorVersion = cursor.membershipEventVersion ?? 0n;
    await tx.clerkUserLifecycle.update({
      where: { clerkUserId: existing.clerkUserId },
      data: {
        membershipEventVersion:
          eventVersion > cursorVersion ? eventVersion : cursorVersion,
        membershipEventRank: EVENT_RANK.deleted,
        membershipActive: false,
        role: UserRole.MEMBER,
        lastEventId: incomingEvent.lastEventId,
      },
    });
  }

  const localUser = await tx.user.findUnique({
    where: { clerkId: existing.clerkUserId },
    select: { id: true, clerkMembershipId: true },
  });
  if (localUser?.clerkMembershipId === incoming.id) {
    await tx.user.update({
      where: { id: localUser.id },
      data: { membershipActive: false, role: UserRole.MEMBER },
    });
  }
}

async function persistUserCursor(
  tx: Prisma.TransactionClient,
  existing: UserLifecycleCursor | null,
  data: ClerkMembership,
  incoming: VersionedLifecycle,
  active: boolean,
): Promise<void> {
  const cursor = {
    deleted: false,
    clerkMembershipId: data.id,
    clerkOrgId: data.organizationId,
    membershipEventVersion: incoming.eventVersion,
    membershipEventRank: incoming.eventRank,
    membershipActive: active,
    role: active ? data.role : UserRole.MEMBER,
    lastEventId: incoming.lastEventId,
  };
  if (existing) {
    await tx.clerkUserLifecycle.update({
      where: { clerkUserId: data.userId },
      data: cursor,
    });
  } else {
    await tx.clerkUserLifecycle.create({
      data: { clerkUserId: data.userId, ...cursor },
    });
  }
}

function shouldApplyMembershipLifecycle(
  existing: MembershipLifecycle | null,
  incoming: VersionedLifecycle,
  incomingRole: ClerkLocalRole,
): boolean {
  if (!existing) return true;
  if (existing.deleted) return false;
  if (incoming.eventVersion > existing.eventVersion) return true;
  if (incoming.eventVersion < existing.eventVersion) return false;
  if (incoming.eventRank > existing.eventRank) return true;
  if (incoming.eventRank < existing.eventRank) return false;
  if (incoming.lastEventId === existing.lastEventId) return false;

  // Clerk timestamps are millisecond precision. If two distinct updates still
  // tie, choose the least-privileged interpretation rather than arrival order.
  return roleAuthority(incomingRole) < roleAuthority(existing.role);
}

function shouldAdvanceUserCursor(
  existing: UserLifecycleCursor | null,
  data: ClerkMembership,
  eventRank: number,
): boolean {
  if (!existing) return true;
  if (existing.deleted) return false;
  if (existing.membershipEventVersion === null) return true;
  if (data.eventVersion > existing.membershipEventVersion) return true;
  if (data.eventVersion < existing.membershipEventVersion) return false;
  const existingRank = existing.membershipEventRank ?? 0;
  if (eventRank > existingRank) return true;
  if (eventRank < existingRank) return false;
  if (existing.clerkMembershipId !== data.id) return false;
  return roleAuthority(data.role) < roleAuthority(existing.role);
}

function isNewerLifecycle(
  existing: VersionedLifecycle | null,
  incoming: VersionedLifecycle,
): boolean {
  if (!existing) return true;
  if (incoming.eventVersion !== existing.eventVersion) {
    return incoming.eventVersion > existing.eventVersion;
  }
  if (incoming.eventRank !== existing.eventRank) {
    return incoming.eventRank > existing.eventRank;
  }
  return false;
}

function parseOrganization(value: unknown): ClerkOrganization {
  const data = asRecord(value);
  return {
    id: requiredString(data["id"], "organization id"),
    name: requiredString(data["name"], "organization name"),
    slug: requiredString(data["slug"], "organization slug"),
    eventVersion: requiredEpochMilliseconds(
      data["updated_at"],
      "organization updated_at",
    ),
  };
}

function parseMembership(value: unknown): ClerkMembership {
  const data = asRecord(value);
  const organization = asRecord(data["organization"]);
  const publicUserData = asRecord(data["public_user_data"]);
  return {
    id: requiredString(data["id"], "membership id"),
    userId: requiredString(publicUserData["user_id"], "membership user id"),
    organizationId: requiredString(
      organization["id"],
      "membership organization id",
    ),
    email: optionalString(publicUserData["identifier"]),
    role: mapClerkRole(requiredString(data["role"], "membership role")),
    eventVersion: requiredEpochMilliseconds(
      data["updated_at"],
      "membership updated_at",
    ),
  };
}

function mapClerkRole(role: string): ClerkLocalRole {
  switch (role.trim().toUpperCase()) {
    case "ORG:ADMIN":
    case "ORG:OWNER":
    case "ADMIN":
    case "OWNER":
      return UserRole.ADMIN;
    case "ORG:MANAGER":
    case "MANAGER":
      return UserRole.MANAGER;
    default:
      return UserRole.MEMBER;
  }
}

function nextLocalRole(
  current: UserRole,
  clerkRole: ClerkMembership["role"],
): UserRole {
  return current === UserRole.OWNER && clerkRole === UserRole.ADMIN
    ? UserRole.OWNER
    : clerkRole;
}

function roleAuthority(role: UserRole): number {
  switch (role) {
    case UserRole.OWNER:
      return 4;
    case UserRole.ADMIN:
      return 3;
    case UserRole.MANAGER:
      return 2;
    default:
      return 1;
  }
}

function requireDelivery(
  delivery: ClerkWebhookDelivery | undefined,
): ClerkWebhookDelivery {
  if (
    !delivery ||
    typeof delivery.id !== "string" ||
    delivery.id.trim().length === 0 ||
    !Number.isSafeInteger(delivery.timestampSeconds) ||
    delivery.timestampSeconds <= 0
  ) {
    throw new BadRequestException("Verified Clerk delivery metadata is required");
  }
  return { id: delivery.id.trim(), timestampSeconds: delivery.timestampSeconds };
}

function deliveryVersion(delivery: ClerkWebhookDelivery): bigint {
  return BigInt(delivery.timestampSeconds) * 1000n;
}

function requiredEpochMilliseconds(value: unknown, field: string): bigint {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new BadRequestException(`Malformed Clerk webhook: missing ${field}`);
  }
  return BigInt(Number(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("Malformed Clerk webhook payload");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`Malformed Clerk webhook: missing ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
