import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import { OrgsController } from "../orgs.controller";
import { OrgsService } from "../orgs.service";
import { PrismaService } from "../../prisma/prisma.service";
import { UpdateOrgDto } from "../../common/dto/orgs.dto";

/**
 * Regression tests for the IDOR vulnerability on org-scoped routes
 * (`GET /orgs/:id`, `PATCH /orgs/:id`, `GET /orgs/:id/stats`).
 *
 * The `:id` route param is client-controlled. The handler MUST compare it
 * against the orgId derived from the verified Clerk JWT (injected via
 * `@OrgId()`) and reject mismatches with 403, otherwise any authenticated
 * user could read/update/inspect arbitrary orgs.
 */
describe("OrgsController IDOR protection", () => {
  const ORG_ID = "org_authenticated_caller";
  const OTHER_ORG_ID = "org_someone_else";

  let service: {
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
    getOnboardingStatus: ReturnType<typeof vi.fn>;
  };
  let prisma: { user: { findUnique: ReturnType<typeof vi.fn> } };
  let controller: OrgsController;

  beforeEach(() => {
    service = {
      findOne: vi.fn().mockResolvedValue({ id: ORG_ID, name: "Acme" }),
      update: vi
        .fn()
        .mockResolvedValue({ id: ORG_ID, name: "Acme", plan: "TRIAL" }),
      getStats: vi.fn().mockResolvedValue({ users: 3, runs: 10 }),
      getOnboardingStatus: vi.fn().mockResolvedValue({
        currentStep: "organization",
        complete: false,
        readyForLiveSend: false,
      }),
    };
    prisma = { user: { findUnique: vi.fn() } };
    controller = new OrgsController(
      service as unknown as OrgsService,
      prisma as unknown as PrismaService,
    );
  });

  describe("GET /orgs/onboarding/status", () => {
    it("derives status for the guard-provided org without a client org id", async () => {
      const result = await controller.getOnboardingStatus(ORG_ID);

      expect(service.getOnboardingStatus).toHaveBeenCalledWith(ORG_ID);
      expect(result).toEqual({
        currentStep: "organization",
        complete: false,
        readyForLiveSend: false,
      });
    });
  });

  describe("GET /orgs/:id (findOne)", () => {
    it("returns the org when :id matches the JWT orgId", async () => {
      const result = await controller.findOne(ORG_ID, ORG_ID);
      expect(service.findOne).toHaveBeenCalledTimes(1);
      expect(service.findOne).toHaveBeenCalledWith(ORG_ID);
      expect(result).toEqual({ id: ORG_ID, name: "Acme" });
    });

    it("throws Forbidden when :id targets a different org", () => {
      expect(() => controller.findOne(ORG_ID, OTHER_ORG_ID)).toThrow(
        ForbiddenException,
      );
      expect(service.findOne).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /orgs/:id (update)", () => {
    const body: UpdateOrgDto = { name: "Renamed" };

    // The update route additionally requires OWNER/ADMIN (see
    // orgs.controller.update-guard.spec.ts for the full role matrix); here we
    // satisfy the role gate so the IDOR check stays the behaviour under test.
    function makeOwnerReq(): Request {
      prisma.user.findUnique.mockResolvedValue({
        id: "user_internal",
        role: "OWNER",
        orgId: ORG_ID,
      });
      return { headers: {}, clerkUserId: "user_clerk_owner" } as unknown as Request;
    }

    it("updates when :id matches the JWT orgId", async () => {
      const result = await controller.update(ORG_ID, ORG_ID, body, makeOwnerReq());
      expect(service.update).toHaveBeenCalledTimes(1);
      expect(service.update).toHaveBeenCalledWith(ORG_ID, body);
      expect(result).toEqual({ id: ORG_ID, name: "Acme", plan: "TRIAL" });
    });

    it("throws Forbidden when :id targets a different org", async () => {
      await expect(
        controller.update(ORG_ID, OTHER_ORG_ID, body, makeOwnerReq()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.update).not.toHaveBeenCalled();
    });
  });

  describe("GET /orgs/:id/stats (getStats)", () => {
    it("returns stats when :id matches the JWT orgId", async () => {
      const result = await controller.getStats(ORG_ID, ORG_ID);
      expect(service.getStats).toHaveBeenCalledTimes(1);
      expect(service.getStats).toHaveBeenCalledWith(ORG_ID);
      expect(result).toEqual({ users: 3, runs: 10 });
    });

    it("throws Forbidden when :id targets a different org", () => {
      expect(() => controller.getStats(ORG_ID, OTHER_ORG_ID)).toThrow(
        ForbiddenException,
      );
      expect(service.getStats).not.toHaveBeenCalled();
    });
  });
});
