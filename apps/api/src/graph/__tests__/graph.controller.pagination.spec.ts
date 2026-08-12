import "reflect-metadata";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphController } from "../graph.controller";
import type { GraphService } from "../graph.service";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";
import type { Request } from "express";

describe("GraphController run pagination", () => {
  let listGraphRuns: ReturnType<typeof vi.fn>;
  let controller: GraphController;

  beforeEach(() => {
    listGraphRuns = vi.fn().mockResolvedValue([]);
    controller = new GraphController({ listGraphRuns } as unknown as GraphService);
  });

  it("keeps the legacy list call when no page controls are supplied", async () => {
    await controller.list("org_1");
    expect(listGraphRuns).toHaveBeenCalledWith("org_1");
  });

  it("opts into the paginated envelope when either page control is supplied", async () => {
    await controller.list("org_1", "2", "25");
    expect(listGraphRuns).toHaveBeenCalledWith("org_1", {
      page: 2,
      limit: 25,
    });

    listGraphRuns.mockClear();
    await controller.list("org_1", undefined, "10");
    expect(listGraphRuns).toHaveBeenCalledWith("org_1", {
      page: 1,
      limit: 10,
    });
  });

  it("passes a validated status into the paginated query", async () => {
    await controller.list("org_1", "1", "20", "FAILED");
    expect(listGraphRuns).toHaveBeenCalledWith("org_1", {
      page: 1,
      limit: 20,
      status: "FAILED",
    });
  });

  it("rejects an unknown run status", () => {
    expect(() => controller.list("org_1", "1", "20", "MADE_UP")).toThrow(
      BadRequestException,
    );
    expect(listGraphRuns).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "2x", "1.5", "10001"])(
    "rejects invalid page %s",
    (page) => {
      expect(() => controller.list("org_1", page, "20")).toThrow(
        BadRequestException,
      );
      expect(listGraphRuns).not.toHaveBeenCalled();
    },
  );

  it("rejects a limit above the public cap", () => {
    expect(() => controller.list("org_1", "1", "101")).toThrow(
      BadRequestException,
    );
    expect(listGraphRuns).not.toHaveBeenCalled();
  });

  it.each(["approve", "reject"] as const)(
    "attaches the admin-or-manager guard to %s",
    (method) => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        GraphController.prototype[method],
      ) as unknown[] | undefined;
      expect(guards).toContain(AdminOrManagerGuard);
    },
  );

  it("ignores body attribution and records the verified Clerk principal", async () => {
    const resumePipelineGraph = vi.fn().mockResolvedValue({ status: "resuming" });
    controller = new GraphController({ resumePipelineGraph } as unknown as GraphService);
    const req = { clerkUserId: "clerk_verified" } as unknown as Request;

    await controller.approve(
      "org_1",
      "run_1",
      { approvedBy: "forged" },
      req,
    );

    expect(resumePipelineGraph).toHaveBeenCalledWith("run_1", "org_1", {
      approved: true,
      approvedBy: "clerk_verified",
    });
  });

  it("fails closed when verified principal context is absent", () => {
    expect(() =>
      controller.reject(
        "org_1",
        "run_1",
        { approvedBy: "forged" },
        {} as Request,
      ),
    ).toThrow(UnauthorizedException);
  });
});
