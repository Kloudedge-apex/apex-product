import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  BadRequestException,
  RequestMethod,
  UnauthorizedException,
} from "@nestjs/common";
import { OutreachArtifactStatus } from "@prisma/client";
import type { Request } from "express";
import { OutreachArtifactsController } from "../outreach-artifacts.controller";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";
import { OutreachArtifactsService } from "../outreach-artifacts.service";

/** Nest stores @UseGuards() refs under this key (GUARDS_METADATA). */
const GUARDS_METADATA = "__guards__";
const PATH_METADATA = "path";
const METHOD_METADATA = "method";

type ServiceMock = Pick<
  OutreachArtifactsService,
  "approve" | "reject" | "listForOrg" | "listPageForOrg"
> & {
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  listForOrg: ReturnType<typeof vi.fn>;
  listPageForOrg: ReturnType<typeof vi.fn>;
};

function mockService(): ServiceMock {
  return {
    approve: vi.fn().mockResolvedValue({ id: "art_1" }),
    reject: vi.fn().mockResolvedValue({ id: "art_1" }),
    listForOrg: vi.fn().mockResolvedValue([]),
    listPageForOrg: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
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

  it("attaches AdminOrManagerGuard to the review-capability probe", () => {
    expect(guardsOn("reviewCapability")).toContain(AdminOrManagerGuard);
  });

  it("leaves the read-only routes un-gated so members can still review queues", () => {
    expect(guardsOn("list")).toHaveLength(0);
    expect(guardsOn("get")).toHaveLength(0);
    expect(guardsOn("listForGraphRun")).toHaveLength(0);
  });

  it("registers the static review-capability GET before the dynamic artifact route", () => {
    const prototype = OutreachArtifactsController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, prototype.reviewCapability)).toBe(
      "outreach-artifacts/review-capability",
    );
    expect(
      Reflect.getMetadata(METHOD_METADATA, prototype.reviewCapability),
    ).toBe(RequestMethod.GET);

    const methods = Object.getOwnPropertyNames(prototype);
    expect(methods.indexOf("reviewCapability")).toBeGreaterThan(-1);
    expect(methods.indexOf("reviewCapability")).toBeLessThan(
      methods.indexOf("get"),
    );
  });
});

describe("OutreachArtifactsController — review capability", () => {
  it("returns the explicit positive capability after the guard succeeds", () => {
    const controller = new OutreachArtifactsController(
      mockService() as unknown as OutreachArtifactsService,
    );

    expect(controller.reviewCapability()).toEqual({
      canReviewArtifacts: true,
    });
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
    expect(service.approve).toHaveBeenCalledWith(
      "org_1",
      "art_1",
      "clerk_user_real",
    );
  });

  it("approve tolerates an empty body (deprecated reviewedBy no longer required)", async () => {
    await controller.approve(
      "org_1",
      "art_1",
      {},
      reqWithClerkUser("clerk_user_real"),
    );
    expect(service.approve).toHaveBeenCalledWith(
      "org_1",
      "art_1",
      "clerk_user_real",
    );
  });

  it("approve throws Unauthorized when no authenticated principal is on the request", () => {
    expect(() =>
      controller.approve("org_1", "art_1", {}, reqWithClerkUser(undefined)),
    ).toThrow(UnauthorizedException);
    expect(service.approve).not.toHaveBeenCalled();
  });

  it("approve still requires orgId", () => {
    expect(() =>
      controller.approve(
        undefined,
        "art_1",
        {},
        reqWithClerkUser("clerk_user_real"),
      ),
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

  it("accepts DELIVERY_UNKNOWN as an artifact status filter", async () => {
    await controller.list("org_1", "delivery_unknown");

    expect(service.listForOrg).toHaveBeenCalledWith("org_1", {
      status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
    });
  });

  it("accepts FAILED as an artifact status filter", async () => {
    await controller.list("org_1", "failed");

    expect(service.listForOrg).toHaveBeenCalledWith("org_1", {
      status: OutreachArtifactStatus.FAILED,
    });
  });

  it("uses the paginated service when page controls are supplied", async () => {
    await controller.list("org_1", "pending_review", "2", "25");

    expect(service.listPageForOrg).toHaveBeenCalledWith("org_1", {
      status: OutreachArtifactStatus.PENDING_REVIEW,
      page: 2,
      limit: 25,
    });
  });
});
