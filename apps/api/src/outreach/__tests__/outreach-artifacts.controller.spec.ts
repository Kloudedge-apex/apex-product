import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { OutreachArtifactsController } from "../outreach-artifacts.controller";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";
import { OutreachArtifactsService } from "../outreach-artifacts.service";

/** Nest stores @UseGuards() refs under this key (GUARDS_METADATA). */
const GUARDS_METADATA = "__guards__";

type ServiceMock = Pick<OutreachArtifactsService, "approve" | "reject"> & {
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
};

function mockService(): ServiceMock {
  return {
    approve: vi.fn().mockResolvedValue({ id: "art_1" }),
    reject: vi.fn().mockResolvedValue({ id: "art_1" }),
  };
}

/** Minimal request double carrying the principal OrgScopeGuard would stamp. */
function reqWithClerkUser(clerkUserId?: string): Request {
  return { clerkUserId } as unknown as Request;
}

function guardsOn(method: keyof OutreachArtifactsController): unknown[] {
  return (
    (Reflect.getMetadata(
      GUARDS_METADATA,
      OutreachArtifactsController.prototype[method],
    ) as unknown[] | undefined) ?? []
  );
}

describe("OutreachArtifactsController — guard attachment (audit B11)", () => {
  it("attaches AdminOrManagerGuard to approve", () => {
    expect(guardsOn("approve")).toContain(AdminOrManagerGuard);
  });

  it("attaches AdminOrManagerGuard to reject", () => {
    expect(guardsOn("reject")).toContain(AdminOrManagerGuard);
  });

  it("leaves the read-only routes un-gated so members can still review queues", () => {
    expect(guardsOn("list")).toHaveLength(0);
    expect(guardsOn("get")).toHaveLength(0);
    expect(guardsOn("listForGraphRun")).toHaveLength(0);
  });
});

describe("OutreachArtifactsController — server-derived attribution (audit B8)", () => {
  let service: ServiceMock;
  let controller: OutreachArtifactsController;

  beforeEach(() => {
    service = mockService();
    controller = new OutreachArtifactsController(
      service as unknown as OutreachArtifactsService,
    );
  });

  it("approve derives reviewedBy from the authenticated principal, not the body", async () => {
    await controller.approve(
      "org_1",
      "art_1",
      { reviewedBy: "forged@attacker.example" },
      reqWithClerkUser("clerk_user_real"),
    );
    expect(service.approve).toHaveBeenCalledWith("org_1", "art_1", "clerk_user_real");
  });

  it("approve tolerates an empty body (deprecated reviewedBy no longer required)", async () => {
    await controller.approve("org_1", "art_1", {}, reqWithClerkUser("clerk_user_real"));
    expect(service.approve).toHaveBeenCalledWith("org_1", "art_1", "clerk_user_real");
  });

  it("approve throws Unauthorized when no authenticated principal is on the request", () => {
    expect(() =>
      controller.approve("org_1", "art_1", {}, reqWithClerkUser(undefined)),
    ).toThrow(UnauthorizedException);
    expect(service.approve).not.toHaveBeenCalled();
  });

  it("approve still requires orgId", () => {
    expect(() =>
      controller.approve(undefined, "art_1", {}, reqWithClerkUser("clerk_user_real")),
    ).toThrow(BadRequestException);
    expect(service.approve).not.toHaveBeenCalled();
  });

  it("reject derives reviewedBy from the principal and keeps the body reviewerNote", async () => {
    await controller.reject(
      "org_1",
      "art_1",
      { reviewedBy: "forged@attacker.example", reviewerNote: "off-tone" },
      reqWithClerkUser("clerk_user_real"),
    );
    expect(service.reject).toHaveBeenCalledWith(
      "org_1",
      "art_1",
      "clerk_user_real",
      "off-tone",
    );
  });

  it("reject throws Unauthorized when no authenticated principal is on the request", () => {
    expect(() =>
      controller.reject("org_1", "art_1", {}, reqWithClerkUser("")),
    ).toThrow(UnauthorizedException);
    expect(service.reject).not.toHaveBeenCalled();
  });
});
