import {
  OutreachArtifactStatus,
  OutreachChannel,
  OutreachSuppressionReason,
  VerificationResult,
} from "@prisma/client";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";
import { SuppressionService } from "../suppression.service";

function mockPrisma() {
  const outreachArtifact = {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  };
  const outreachSuppression = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const person = { findMany: vi.fn() };
  const client = {
    outreachArtifact,
    outreachSuppression,
    person,
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(
    async (operation: (tx: typeof client) => Promise<unknown>) =>
      operation(client),
  );
  return {
    client: client as unknown as PrismaService,
    outreachArtifact,
    outreachSuppression,
    person,
    $queryRaw: client.$queryRaw,
    $transaction: client.$transaction,
  };
}

const actor = { userId: "user_1", clerkUserId: "clerk_admin_1" };

describe("SuppressionService manual admin workflows", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: SuppressionService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new SuppressionService(prisma.client);
  });

  describe("artifact recipient", () => {
    it("uses the persisted recipient, upgrades legacy reply-stop, and CASes an unsent artifact", async () => {
      prisma.outreachArtifact.findFirst
        .mockResolvedValueOnce({
          id: "artifact_1",
          channel: OutreachChannel.EMAIL,
          recipientRef: " Prospect@Example.com ",
        })
        .mockResolvedValueOnce({
          id: "artifact_1",
          status: OutreachArtifactStatus.SUPPRESSED,
        });
      prisma.outreachArtifact.updateMany.mockResolvedValue({ count: 1 });
      prisma.outreachSuppression.findUnique
        .mockResolvedValueOnce({
          id: "suppression_1",
          reason: OutreachSuppressionReason.MANUAL,
          source: "gmail_reply",
        })
        .mockResolvedValueOnce({
          id: "suppression_1",
          recipientRef: "prospect@example.com",
          reason: OutreachSuppressionReason.MANUAL,
          source: "admin_manual",
        });
      prisma.outreachSuppression.update.mockResolvedValue({
        id: "suppression_1",
      });

      const result = await service.suppressArtifactRecipient({
        orgId: "org_1",
        artifactId: "artifact_1",
        actor,
      });

      expect(prisma.outreachSuppression.update).toHaveBeenCalledWith({
        where: { id: "suppression_1" },
        data: {
          reason: OutreachSuppressionReason.MANUAL,
          source: "admin_manual",
          metadata: {
            actorUserId: "user_1",
            actorClerkId: "clerk_admin_1",
            action: "artifact_recipient_suppressed",
            artifactId: "artifact_1",
          },
        },
      });
      expect(prisma.outreachArtifact.updateMany).toHaveBeenCalledWith({
        where: {
          id: "artifact_1",
          orgId: "org_1",
          status: {
            in: [
              OutreachArtifactStatus.DRAFT,
              OutreachArtifactStatus.PENDING_REVIEW,
              OutreachArtifactStatus.APPROVED,
            ],
          },
        },
        data: { status: OutreachArtifactStatus.SUPPRESSED },
      });
      expect(result).toEqual({
        artifact: {
          id: "artifact_1",
          status: OutreachArtifactStatus.SUPPRESSED,
          statusChanged: true,
        },
        suppression: {
          id: "suppression_1",
          recipientRef: "prospect@example.com",
          reason: OutreachSuppressionReason.MANUAL,
          source: "admin_manual",
          created: false,
          upgraded: true,
        },
      });
    });

    it.each([
      OutreachArtifactStatus.REJECTED,
      OutreachArtifactStatus.SENDING,
      OutreachArtifactStatus.SENT,
      OutreachArtifactStatus.SIMULATED,
      OutreachArtifactStatus.DELIVERY_UNKNOWN,
      OutreachArtifactStatus.FAILED,
    ])("never rewrites an artifact currently in %s", async (status) => {
      prisma.outreachArtifact.findFirst
        .mockResolvedValueOnce({
          id: "artifact_1",
          channel: OutreachChannel.EMAIL,
          recipientRef: "prospect@example.com",
        })
        .mockResolvedValueOnce({ id: "artifact_1", status });
      prisma.outreachArtifact.updateMany.mockResolvedValue({ count: 0 });
      vi.spyOn(service, "suppress").mockResolvedValue({ created: true });
      prisma.outreachSuppression.findUnique.mockResolvedValue({
        id: "suppression_1",
        recipientRef: "prospect@example.com",
        reason: OutreachSuppressionReason.MANUAL,
        source: "admin_manual",
      });

      const result = await service.suppressArtifactRecipient({
        orgId: "org_1",
        artifactId: "artifact_1",
        actor,
      });

      expect(result.artifact).toEqual({
        id: "artifact_1",
        status,
        statusChanged: false,
      });
      const write = prisma.outreachArtifact.updateMany.mock.calls[0][0];
      expect(write.where.status.in).not.toContain(status);
    });

    it("is idempotent when the artifact and recipient are already suppressed", async () => {
      prisma.outreachArtifact.findFirst
        .mockResolvedValueOnce({
          id: "artifact_1",
          channel: OutreachChannel.EMAIL,
          recipientRef: "prospect@example.com",
        })
        .mockResolvedValueOnce({
          id: "artifact_1",
          status: OutreachArtifactStatus.SUPPRESSED,
        });
      prisma.outreachArtifact.updateMany.mockResolvedValue({ count: 0 });
      vi.spyOn(service, "suppress").mockResolvedValue({ created: false });
      prisma.outreachSuppression.findUnique.mockResolvedValue({
        id: "suppression_1",
        recipientRef: "prospect@example.com",
        reason: OutreachSuppressionReason.MANUAL,
        source: "admin_manual",
      });

      const result = await service.suppressArtifactRecipient({
        orgId: "org_1",
        artifactId: "artifact_1",
        actor,
      });

      expect(result).toMatchObject({
        artifact: {
          status: OutreachArtifactStatus.SUPPRESSED,
          statusChanged: false,
        },
        suppression: { created: false, upgraded: false },
      });
    });

    it("fails closed for missing or cross-org artifact ids", async () => {
      prisma.outreachArtifact.findFirst.mockResolvedValue(null);

      await expect(
        service.suppressArtifactRecipient({
          orgId: "org_1",
          artifactId: "artifact_other_org",
          actor,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.outreachArtifact.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "artifact_other_org", orgId: "org_1" },
        }),
      );
      expect(prisma.outreachSuppression.create).not.toHaveBeenCalled();
      expect(prisma.outreachArtifact.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      [OutreachChannel.LINKEDIN, "person_linkedin"],
      [OutreachChannel.EMAIL, null],
      [OutreachChannel.EMAIL, "not-an-email"],
    ])("rejects channel=%s recipient=%s", async (channel, recipientRef) => {
      prisma.outreachArtifact.findFirst.mockResolvedValue({
        id: "artifact_1",
        channel,
        recipientRef,
      });

      await expect(
        service.suppressArtifactRecipient({
          orgId: "org_1",
          artifactId: "artifact_1",
          actor,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.outreachSuppression.create).not.toHaveBeenCalled();
    });
  });

  describe("bulk people", () => {
    it("resolves org-owned EmailCandidates deterministically and reports skips", async () => {
      prisma.person.findMany.mockResolvedValue([
        {
          id: "person_strong",
          emails: [
            {
              id: "email_weak",
              email: "guess@example.com",
              verified: false,
              verificationResult: VerificationResult.UNKNOWN,
            },
            {
              id: "email_strong",
              email: " Verified@Example.com ",
              verified: true,
              verificationResult: VerificationResult.VALID,
            },
          ],
        },
        {
          id: "person_ambiguous",
          emails: [
            {
              id: "email_a",
              email: "a@example.com",
              verified: true,
              verificationResult: VerificationResult.VALID,
            },
            {
              id: "email_b",
              email: "b@example.com",
              verified: true,
              verificationResult: VerificationResult.VALID,
            },
          ],
        },
        {
          id: "person_missing",
          emails: [
            {
              id: "email_invalid",
              email: "invalid@example.com",
              verified: false,
              verificationResult: VerificationResult.INVALID,
            },
          ],
        },
        {
          id: "person_existing",
          emails: [
            {
              id: "email_existing",
              email: "existing@example.com",
              verified: false,
              verificationResult: VerificationResult.CATCH_ALL,
            },
          ],
        },
      ]);
      vi.spyOn(service, "suppress")
        .mockResolvedValueOnce({ created: true })
        .mockResolvedValueOnce({ created: false });
      prisma.outreachSuppression.findUnique
        .mockResolvedValueOnce({
          id: "suppression_new",
          recipientRef: "verified@example.com",
          reason: OutreachSuppressionReason.MANUAL,
          source: "admin_manual",
        })
        .mockResolvedValueOnce({
          id: "suppression_existing",
          recipientRef: "existing@example.com",
          reason: OutreachSuppressionReason.BOUNCED,
          source: "gmail_dsn",
        });

      const result = await service.suppressPeople({
        orgId: "org_1",
        personIds: [
          "person_strong",
          "person_strong",
          "person_ambiguous",
          "person_missing",
          "person_existing",
          "person_other_org",
        ],
        actor,
      });

      expect(prisma.person.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: {
              in: [
                "person_strong",
                "person_ambiguous",
                "person_missing",
                "person_existing",
                "person_other_org",
              ],
            },
            company: { orgId: "org_1" },
          },
        }),
      );
      expect(service.suppress).toHaveBeenNthCalledWith(1, {
        orgId: "org_1",
        recipientRef: "verified@example.com",
        reason: OutreachSuppressionReason.MANUAL,
        source: "admin_manual",
        metadata: {
          actorUserId: "user_1",
          actorClerkId: "clerk_admin_1",
          action: "person_suppressed",
          personId: "person_strong",
        },
      });
      expect(service.suppress).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          recipientRef: "existing@example.com",
          metadata: expect.objectContaining({ personId: "person_existing" }),
        }),
      );
      expect(result).toMatchObject({
        requestedCount: 6,
        uniqueCount: 5,
        affectedCount: 1,
        alreadySuppressedCount: 1,
        skippedCount: 3,
      });
      expect(result.results).toEqual(
        expect.arrayContaining([
          {
            personId: "person_ambiguous",
            status: "SKIPPED",
            reason: "AMBIGUOUS_EMAIL",
          },
          {
            personId: "person_missing",
            status: "SKIPPED",
            reason: "MISSING_EMAIL",
          },
          {
            personId: "person_other_org",
            status: "SKIPPED",
            reason: "NOT_FOUND_OR_CROSS_ORG",
          },
        ]),
      );
    });

    it("counts a legacy marker upgrade as affected, not already suppressed", async () => {
      prisma.person.findMany.mockResolvedValue([
        {
          id: "person_1",
          emails: [
            {
              id: "email_1",
              email: "person@example.com",
              verified: true,
              verificationResult: VerificationResult.VALID,
            },
          ],
        },
      ]);
      vi.spyOn(service, "suppress").mockResolvedValue({
        created: false,
        upgraded: true,
      });
      prisma.outreachSuppression.findUnique.mockResolvedValue({
        id: "suppression_1",
        recipientRef: "person@example.com",
        reason: OutreachSuppressionReason.MANUAL,
        source: "admin_manual",
      });

      const result = await service.suppressPeople({
        orgId: "org_1",
        personIds: ["person_1"],
        actor,
      });

      expect(result).toMatchObject({
        affectedCount: 1,
        alreadySuppressedCount: 0,
        skippedCount: 0,
      });
      expect(result.results[0]).toMatchObject({
        status: "SUPPRESSED",
        suppression: { created: false, upgraded: true },
      });
    });
  });
});
