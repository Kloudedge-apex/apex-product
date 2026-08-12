import { OutreachArtifactStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DashboardService } from "../dashboard.service";

describe("DashboardService.activity outreach lifecycle", () => {
  it("preserves approval events after artifacts advance beyond APPROVED", async () => {
    const reviewedAt = new Date("2026-08-12T08:01:00.000Z");
    const statuses = [
      OutreachArtifactStatus.SENDING,
      OutreachArtifactStatus.SENT,
      OutreachArtifactStatus.SIMULATED,
      OutreachArtifactStatus.DELIVERY_UNKNOWN,
    ];
    const prisma = activityPrisma(
      statuses.map((status, index) => ({
        id: `artifact_${index}`,
        toolName: "send_email",
        status,
        createdAt: new Date(`2026-08-12T08:00:0${index}.000Z`),
        reviewedAt,
        updatedAt: new Date(`2026-08-12T08:02:0${index}.000Z`),
      })),
    );
    const service = new DashboardService(prisma as never);

    const events = await service.activity("org_1", 30);

    for (let index = 0; index < statuses.length; index += 1) {
      expect(events).toContainEqual({
        id: `artifact:artifact_${index}:approved`,
        kind: "draft_approved",
        text: "Approved outreach draft",
        at: reviewedAt.toISOString(),
        leadId: "",
      });
    }
  });

  it("emits distinct sent and delivery-unknown incidents at updatedAt", async () => {
    const sentUpdatedAt = new Date("2026-08-12T09:05:00.000Z");
    const unknownUpdatedAt = new Date("2026-08-12T09:06:00.000Z");
    const prisma = activityPrisma([
      {
        id: "artifact_sent",
        toolName: "send_email",
        status: OutreachArtifactStatus.SENT,
        createdAt: new Date("2026-08-12T09:00:00.000Z"),
        reviewedAt: new Date("2026-08-12T09:01:00.000Z"),
        updatedAt: sentUpdatedAt,
      },
      {
        id: "artifact_unknown",
        toolName: "send_email",
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
        createdAt: new Date("2026-08-12T09:00:30.000Z"),
        reviewedAt: new Date("2026-08-12T09:01:30.000Z"),
        updatedAt: unknownUpdatedAt,
      },
    ]);
    const service = new DashboardService(prisma as never);

    const events = await service.activity("org_1", 30);

    expect(events).toContainEqual({
      id: "artifact:artifact_sent:sent",
      kind: "draft_sent",
      text: "Sent approved outreach",
      at: sentUpdatedAt.toISOString(),
      leadId: "",
    });
    expect(events).toContainEqual({
      id: "artifact:artifact_unknown:delivery_unknown",
      kind: "delivery_unknown",
      text: "Outreach delivery requires reconciliation",
      at: unknownUpdatedAt.toISOString(),
      leadId: "",
    });
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: "org_1" },
        orderBy: { updatedAt: "desc" },
        take: 30,
      }),
    );
  });
});

function activityPrisma(
  artifacts: Array<{
    id: string;
    toolName: string;
    status: OutreachArtifactStatus;
    createdAt: Date;
    updatedAt: Date;
    reviewedAt: Date | null;
  }>,
) {
  return {
    graphRun: { findMany: vi.fn().mockResolvedValue([]) },
    outreachArtifact: { findMany: vi.fn().mockResolvedValue(artifacts) },
    meetingLedger: { findMany: vi.fn().mockResolvedValue([]) },
  };
}
