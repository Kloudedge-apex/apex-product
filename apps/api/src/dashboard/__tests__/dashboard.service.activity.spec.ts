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
      OutreachArtifactStatus.FAILED,
    ];
    const prisma = activityPrisma(
      statuses.map((status, index) => ({
        id: `artifact_${index}`,
        toolName: "send_email",
        status,
        createdAt: new Date(`2026-08-12T08:00:0${index}.000Z`),
        reviewedAt,
        reviewerNote: null,
        failureReason:
          status === OutreachArtifactStatus.FAILED ? "provider rejected" : null,
        failedAt:
          status === OutreachArtifactStatus.FAILED
            ? new Date("2026-08-12T08:03:00.000Z")
            : null,
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

  it("emits FAILED as approved then failed, never as a human rejection", async () => {
    const reviewedAt = new Date("2026-08-12T10:01:00.000Z");
    const failedAt = new Date("2026-08-12T10:05:00.000Z");
    const prisma = activityPrisma([
      {
        id: "artifact_failed",
        toolName: "send_email",
        status: OutreachArtifactStatus.FAILED,
        createdAt: new Date("2026-08-12T10:00:00.000Z"),
        reviewedAt,
        updatedAt: failedAt,
        reviewerNote: null,
        failureReason: "provider rejected after retries",
        failedAt,
      },
    ]);
    const service = new DashboardService(prisma as never);

    const events = await service.activity("org_1", 30);

    expect(events).toContainEqual(
      expect.objectContaining({
        id: "artifact:artifact_failed:approved",
        kind: "draft_approved",
        at: reviewedAt.toISOString(),
      }),
    );
    expect(events).toContainEqual({
      id: "artifact:artifact_failed:failed",
      kind: "draft_failed",
      text: "Outreach dispatch failed without provider acceptance",
      at: failedAt.toISOString(),
      leadId: "",
    });
    expect(events.some((event) => event.kind === "draft_rejected")).toBe(false);
  });

  it("does not classify an unattested legacy auto-failed marker", async () => {
    const overwrittenReviewTime = new Date("2026-08-12T10:05:00.000Z");
    const prisma = activityPrisma([
      {
        id: "artifact_legacy_failed",
        toolName: "send_email",
        status: OutreachArtifactStatus.REJECTED,
        createdAt: new Date("2026-08-12T10:00:00.000Z"),
        reviewedAt: overwrittenReviewTime,
        updatedAt: overwrittenReviewTime,
        reviewerNote: "auto-failed: legacy provider rejection",
        failureReason: null,
        failedAt: null,
      },
    ]);
    const service = new DashboardService(prisma as never);

    const events = await service.activity("org_1", 30);

    expect(
      events.some(
        (event) => event.id === "artifact:artifact_legacy_failed:approved",
      ),
    ).toBe(false);
    expect(events.some((event) => event.kind === "draft_failed")).toBe(false);
    expect(events.some((event) => event.kind === "draft_rejected")).toBe(false);
  });

  it("retains approval timing for a gated compatibility failure with failedAt evidence", async () => {
    const reviewedAt = new Date("2026-08-12T10:01:00.000Z");
    const failedAt = new Date("2026-08-12T10:05:00.000Z");
    const prisma = activityPrisma([
      {
        id: "artifact_gated_failed",
        toolName: "send_email",
        status: OutreachArtifactStatus.REJECTED,
        createdAt: new Date("2026-08-12T10:00:00.000Z"),
        reviewedAt,
        updatedAt: failedAt,
        reviewerNote: "auto-failed: gated provider rejection",
        failureReason: "gated provider rejection",
        failedAt,
      },
    ]);
    const service = new DashboardService(prisma as never);

    const events = await service.activity("org_1", 30);

    expect(events).toContainEqual(
      expect.objectContaining({
        id: "artifact:artifact_gated_failed:approved",
        kind: "draft_approved",
        at: reviewedAt.toISOString(),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        id: "artifact:artifact_gated_failed:failed",
        kind: "draft_failed",
        at: failedAt.toISOString(),
      }),
    );
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
        reviewerNote: null,
        failureReason: null,
        failedAt: null,
        updatedAt: sentUpdatedAt,
      },
      {
        id: "artifact_unknown",
        toolName: "send_email",
        status: OutreachArtifactStatus.REJECTED,
        createdAt: new Date("2026-08-12T09:00:30.000Z"),
        reviewedAt: new Date("2026-08-12T09:01:30.000Z"),
        reviewerNote: "delivery-unknown: provider outcome was ambiguous",
        failureReason: null,
        failedAt: null,
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
    reviewerNote?: string | null;
    failureReason?: string | null;
    failedAt?: Date | null;
  }>,
) {
  return {
    graphRun: { findMany: vi.fn().mockResolvedValue([]) },
    outreachArtifact: { findMany: vi.fn().mockResolvedValue(artifacts) },
    meetingLedger: { findMany: vi.fn().mockResolvedValue([]) },
  };
}
