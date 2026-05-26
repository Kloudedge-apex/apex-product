import { describe, it, expect, beforeEach, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { OrgsController } from "../orgs.controller";
import { OrgsService } from "../orgs.service";
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
  };
  let controller: OrgsController;

  beforeEach(() => {
    service = {
      findOne: vi.fn().mockResolvedValue({ id: ORG_ID, name: "Acme" }),
      update: vi
        .fn()
        .mockResolvedValue({ id: ORG_ID, name: "Acme", plan: "TRIAL" }),
      getStats: vi.fn().mockResolvedValue({ users: 3, runs: 10 }),
    };
    controller = new OrgsController(service as unknown as OrgsService);
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

    it("updates when :id matches the JWT orgId", async () => {
      const result = await controller.update(ORG_ID, ORG_ID, body);
      expect(service.update).toHaveBeenCalledTimes(1);
      expect(service.update).toHaveBeenCalledWith(ORG_ID, body);
      expect(result).toEqual({ id: ORG_ID, name: "Acme", plan: "TRIAL" });
    });

    it("throws Forbidden when :id targets a different org", () => {
      expect(() => controller.update(ORG_ID, OTHER_ORG_ID, body)).toThrow(
        ForbiddenException,
      );
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
