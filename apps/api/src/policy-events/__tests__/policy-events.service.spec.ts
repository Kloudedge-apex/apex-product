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
            failureReason: null,
            failedAt: null,
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
      where: {
        orgId: "org_1",
        status: OutreachArtifactStatus.DELIVERY_UNKNOWN,
      },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        graphRunId: true,
        toolName: true,
        status: true,
        reviewerNote: true,
        failureReason: true,
        failedAt: true,
        sentAt: true,
        reviewedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });

  it("reports FAILED separately with first-class failure evidence", async () => {
    const failedAt = new Date("2026-08-12T08:10:00.000Z");
    const prisma = {
      outreachArtifact: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "artifact_failed",
            graphRunId: "graph_1",
            toolName: "send_email",
            status: OutreachArtifactStatus.FAILED,
            reviewerNote: null,
            failureReason: "provider rejected after retry exhaustion",
            failedAt,
            sentAt: null,
            reviewedAt: new Date("2026-08-12T08:01:00.000Z"),
            createdAt: new Date("2026-08-12T08:00:00.000Z"),
            updatedAt: failedAt,
          },
        ]),
      },
    };
    const service = new PolicyEventsService(prisma as never);

    const result = await service.list("org_1", {
      decision: "failed",
      limit: 25,
    });

    expect(result.events).toEqual([
      {
        id: "artifact_failed",
        graphRunId: "graph_1",
        toolName: "send_email",
        sideEffectLevel: "external_write",
        decision: "failed",
        reason: "provider rejected after retry exhaustion",
        createdAt: failedAt.toISOString(),
      },
    ]);
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: "org_1",
          OR: [
            { status: OutreachArtifactStatus.FAILED },
            {
              status: OutreachArtifactStatus.REJECTED,
              reviewerNote: { startsWith: "auto-failed:" },
              failedAt: { not: null },
            },
          ],
        },
        take: 25,
      }),
    );
  });

  it("keeps an unattested historical failure marker unclassified in an unfiltered list", async () => {
    const createdAt = new Date("2026-08-01T08:00:00.000Z");
    const reviewedAt = new Date("2026-08-01T08:01:00.000Z");
    const updatedAt = new Date("2026-08-01T08:10:00.000Z");
    const prisma = {
      outreachArtifact: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "artifact_historical_marker",
            graphRunId: "graph_legacy",
            toolName: "send_email",
            status: OutreachArtifactStatus.REJECTED,
            reviewerNote: "auto-failed: legacy provider rejection",
            failureReason: null,
            failedAt: null,
            sentAt: null,
            reviewedAt,
            createdAt,
            updatedAt,
          },
        ]),
      },
    };
    const service = new PolicyEventsService(prisma as never);

    const result = await service.list("org_1", { limit: 25 });

    expect(result.events).toEqual([
      {
        id: "artifact_historical_marker",
        graphRunId: "graph_legacy",
        toolName: "send_email",
        sideEffectLevel: "external_write",
        decision: "reconciliation_required",
        reason:
          "Historical system marker lacks trusted failure evidence; reconcile before classifying this artifact as a reviewer rejection or send failure",
        createdAt: updatedAt.toISOString(),
      },
    ]);
    expect(result.events[0]?.decision).not.toBe("blocked");
    expect(result.events[0]?.createdAt).not.toBe(reviewedAt.toISOString());
    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org_1" }, take: 25 }),
    );
  });

  it("supports an exact reconciliation-required policy filter", async () => {
    const prisma = {
      outreachArtifact: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new PolicyEventsService(prisma as never);

    await service.list("org_1", {
      decision: "reconciliation_required",
      limit: 10,
    });

    expect(prisma.outreachArtifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: "org_1",
          status: OutreachArtifactStatus.REJECTED,
          reviewerNote: { startsWith: "auto-failed:" },
          failedAt: null,
        },
      }),
    );
  });
});
