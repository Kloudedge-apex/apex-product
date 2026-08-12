import "reflect-metadata";
import {
  BadRequestException,
  ForbiddenException,
  RequestMethod,
  UnauthorizedException,
} from "@nestjs/common";
import { OutreachArtifactStatus, OutreachSuppressionReason } from "@prisma/client";
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../../prisma/prisma.service";
import { SuppressionController } from "../suppression.controller";
import { SuppressionService } from "../suppression.service";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

function mockRequest(clerkUserId: string | null = "clerk_admin_1"): Request {
  return {
    clerkUserId: clerkUserId ?? undefined,
  } as unknown as Request;
}

function mockPrisma(
  user: { id: string; role: string; orgId: string } | null = {
    id: "user_1",
    role: "ADMIN",
    orgId: "org_1",
  },
): PrismaService {
  return {
    user: { findUnique: vi.fn().mockResolvedValue(user) },
  } as unknown as PrismaService;
}

function mockService() {
  return {
    suppressArtifactRecipient: vi.fn().mockResolvedValue({
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
        created: true,
        upgraded: false,
      },
    }),
    suppressPeople: vi.fn().mockResolvedValue({
      requestedCount: 2,
      uniqueCount: 2,
      affectedCount: 2,
      alreadySuppressedCount: 0,
      skippedCount: 0,
      results: [],
    }),
  };
}

describe("SuppressionController server-resolved manual suppression", () => {
  let service: ReturnType<typeof mockService>;
  let controller: SuppressionController;

  beforeEach(() => {
    service = mockService();
    controller = new SuppressionController(
      service as unknown as SuppressionService,
      mockPrisma(),
    );
  });

  it("registers the artifact and bulk POST route shapes", () => {
    const artifactHandler = SuppressionController.prototype
      .suppressArtifactRecipient as object;
    const bulkHandler = SuppressionController.prototype.suppressPeople as object;

    expect(Reflect.getMetadata(METHOD_METADATA, artifactHandler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, artifactHandler)).toBe(
      "artifacts/:artifactId",
    );
    expect(Reflect.getMetadata(METHOD_METADATA, bulkHandler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, bulkHandler)).toBe("people/bulk");
  });

  it("derives org and actor server-side for artifact suppression", async () => {
    const result = await controller.suppressArtifactRecipient(
      "org_1",
      mockRequest(),
      "artifact_1",
    );

    expect(service.suppressArtifactRecipient).toHaveBeenCalledWith({
      orgId: "org_1",
      artifactId: "artifact_1",
      actor: { userId: "user_1", clerkUserId: "clerk_admin_1" },
    });
    expect(result.artifact.status).toBe(OutreachArtifactStatus.SUPPRESSED);
  });

  it("allows OWNER and ADMIN but rejects missing, member, and cross-org principals", async () => {
    await expect(
      controller.suppressArtifactRecipient(
        "org_1",
        mockRequest(null),
        "artifact_1",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    for (const user of [
      { id: "user_2", role: "MEMBER", orgId: "org_1" },
      { id: "user_3", role: "OWNER", orgId: "org_other" },
    ]) {
      controller = new SuppressionController(
        service as unknown as SuppressionService,
        mockPrisma(user),
      );
      await expect(
        controller.suppressArtifactRecipient(
          "org_1",
          mockRequest(),
          "artifact_1",
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(service.suppressArtifactRecipient).not.toHaveBeenCalled();

    controller = new SuppressionController(
      service as unknown as SuppressionService,
      mockPrisma({ id: "owner_1", role: "OWNER", orgId: "org_1" }),
    );
    await controller.suppressArtifactRecipient(
      "org_1",
      mockRequest("clerk_owner_1"),
      "artifact_1",
    );
    expect(service.suppressArtifactRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: "owner_1", clerkUserId: "clerk_owner_1" },
      }),
    );
  });

  it("accepts Person ids only for the bulk route and trims them", async () => {
    await controller.suppressPeople("org_1", mockRequest(), {
      personIds: [" person_1 ", "person_2"],
    });

    expect(service.suppressPeople).toHaveBeenCalledWith({
      orgId: "org_1",
      personIds: ["person_1", "person_2"],
      actor: { userId: "user_1", clerkUserId: "clerk_admin_1" },
    });
  });

  it.each([
    ["null", null],
    ["empty object", {}],
    ["empty ids", { personIds: [] }],
    ["non-string id", { personIds: [42] }],
    ["blank id", { personIds: [" "] }],
    ["client email", { personIds: ["person_1"], email: "x@example.com" }],
    ["client org", { personIds: ["person_1"], orgId: "org_other" }],
    ["too many ids", { personIds: Array.from({ length: 201 }, (_, i) => `p_${i}`) }],
  ])("rejects %s instead of accepting client identity data", async (_label, body) => {
    await expect(
      controller.suppressPeople("org_1", mockRequest(), body),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(service.suppressPeople).not.toHaveBeenCalled();
  });
});
