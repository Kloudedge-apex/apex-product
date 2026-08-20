import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { MeetingSource, MeetingStatus } from "@prisma/client";
import { MeetingsController } from "../meetings.controller";
import { MeetingsService } from "../meetings.service";

function mockMeetings() {
  return {
    create: vi.fn().mockResolvedValue({ id: "mtg_1" }),
    confirm: vi
      .fn()
      .mockResolvedValue({ id: "mtg_1", status: MeetingStatus.CONFIRMED }),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
    markCompleted: vi.fn(),
    markNoShow: vi.fn(),
  };
}

describe("MeetingsController human provenance", () => {
  let meetings: ReturnType<typeof mockMeetings>;
  let controller: MeetingsController;

  beforeEach(() => {
    meetings = mockMeetings();
    controller = new MeetingsController(meetings as unknown as MeetingsService);
  });

  it("forces public creates to HUMAN_LOGGED and derives createdBy from Clerk", async () => {
    const bodyWithSpoofedSource = {
      title: "Discovery call",
      scheduledFor: "2026-08-14T09:30:00.000Z",
      attendeeEmails: ["prospect@example.com"],
      source: MeetingSource.AGENT_PROPOSED,
    };

    await controller.create(
      "org_1",
      "clerk_user_1",
      bodyWithSpoofedSource,
    );

    expect(meetings.create).toHaveBeenCalledWith({
      orgId: "org_1",
      title: "Discovery call",
      scheduledFor: new Date("2026-08-14T09:30:00.000Z"),
      attendeeEmails: ["prospect@example.com"],
      durationMinutes: undefined,
      description: undefined,
      notes: undefined,
      outreachArtifactId: undefined,
      personId: undefined,
      source: MeetingSource.HUMAN_LOGGED,
      createdBy: "clerk_user_1",
    });
  });

  it("ignores a body-supplied confirmer and uses the authenticated Clerk user", async () => {
    await controller.confirm("org_1", "clerk_real", "mtg_1", {
      confirmedBy: "spoofed_actor",
    });

    expect(meetings.confirm).toHaveBeenCalledWith(
      "org_1",
      "mtg_1",
      "clerk_real",
    );
  });

  it("refuses confirmation without an authenticated Clerk identity", () => {
    expect(() =>
      controller.confirm("org_1", undefined, "mtg_1", {
        confirmedBy: "spoofed_actor",
      }),
    ).toThrow(UnauthorizedException);
    expect(meetings.confirm).not.toHaveBeenCalled();
  });

  it("records a no-show through the tenant-scoped service", async () => {
    await controller.noShow("org_1", "mtg_1");
    expect(meetings.markNoShow).toHaveBeenCalledWith("org_1", "mtg_1");
  });

  it("rejects empty or mistyped meeting updates before calling the service", () => {
    expect(() => controller.update("org_1", "mtg_1", {})).toThrow(
      BadRequestException,
    );
    expect(() =>
      controller.update("org_1", "mtg_1", {
        title: 42 as unknown as string,
      }),
    ).toThrow(BadRequestException);
    expect(meetings.update).not.toHaveBeenCalled();
  });
});
