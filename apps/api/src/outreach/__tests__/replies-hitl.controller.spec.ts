import { describe, it, expect, vi } from "vitest";
import { ReplyIntent10 } from "@prisma/client";
import { RepliesService } from "../replies.service";
import { RepliesController } from "../replies.controller";

describe("Replies HITL surface", () => {
  it("GET /replies?requiresHitl=true lists replies", async () => {
    const svc = {
      listRequiresHitl: vi.fn().mockResolvedValue({ replies: [] }),
    } as unknown as RepliesService;
    const controller = new RepliesController(svc);

    await controller.list("org_1", "true", "25");

    expect(svc.listRequiresHitl).toHaveBeenCalledWith("org_1", 25);
  });

  it("POST /replies/:id/resolve-hitl creates human classification", async () => {
    const svc = {
      resolveHitl: vi.fn().mockResolvedValue({ classificationId: "cls_human" }),
    } as unknown as RepliesService;
    const controller = new RepliesController(svc);

    const res = await controller.resolveHitl("org_1", "reply_1", {
      intentOverride: ReplyIntent10.not_now,
      note: "follow up next quarter",
    });

    expect(svc.resolveHitl).toHaveBeenCalledWith("org_1", "reply_1", {
      intentOverride: ReplyIntent10.not_now,
      note: "follow up next quarter",
    });
    expect(res).toEqual({ classificationId: "cls_human" });
  });
});

