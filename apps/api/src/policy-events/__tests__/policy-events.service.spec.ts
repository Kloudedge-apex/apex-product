import { OutreachArtifactStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PolicyEventsService } from "../policy-events.service";

describe("PolicyEventsService", () => {
  it("reports DELIVERY_UNKNOWN as its own decision at the incident updatedAt", async () => {
    const createdAt = new Date("2026-08-12T07:00:00.000Z");
    const reviewedAt = new Date("2026-08-12T07:01:00.000Z");
    const updatedAt = new Date("2026-08-12T07:10:00.000Z");
    const prisma = {
      outreachArtifact: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "artifact_unknown",
            graphRunId: "graph_1",
            toolName: "send_email",
            status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
            reviewerNote: "Provider outcome could not be reconciled",
            sentAt: null,
            reviewedAt,
            createdAt,
            updatedAt,
          },
        ]),
      },
    };
    const service = new PolicyEventsService(prisma as never);

    const result = await service.list("org_1", {
      decision: "delivery_unknown",
      limit: 25,
    });

    expect(result).toEqual({
      events: [
        {
          id: "artifact_unknown",
          graphRunId: "graph_1",
          toolName: "send_email",
          sideEffectLevel: "external_write",
          decision: "delivery_unknown",
          reason: "Provider outcome could not be reconciled",
          createdAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(result.events[0]?.createdAt).not.toBe(reviewedAt.toISOString());
    expect(result.events[0]?.createdAt).not.toBe(createdAt.toISOString());
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        graphRunId: true,
        toolName: true,
        status: true,
        reviewerNote: true,
        sentAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });
});
