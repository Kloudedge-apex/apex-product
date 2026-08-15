import { BadRequestException } from "@nestjs/common";
import {
  ConversationSentiment,
  FollowUpStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationsController } from "../conversations.controller";
import { ConversationsService } from "../conversations.service";

function createServiceMock() {
  return {
    list: vi.fn(),
    get: vi.fn(),
    markRead: vi.fn(),
    archive: vi.fn(),
    generateReplyDraft: vi.fn(),
    createHumanReplyDraft: vi.fn(),
    createFollowUp: vi.fn(),
    updateFollowUp: vi.fn(),
    proposeMeeting: vi.fn(),
  };
}

describe("ConversationsController validation", () => {
  let service: ReturnType<typeof createServiceMock>;
  let controller: ConversationsController;

  beforeEach(() => {
    service = createServiceMock();
    controller = new ConversationsController(
      service as unknown as ConversationsService,
    );
  });

  it("normalizes supported list filters and passes tenant context unchanged", () => {
    controller.list(
      "org_1",
      "positive",
      "true",
      "false",
      "true",
      "person_1",
      "2",
      "50",
      "  Buyer & Pilot  ",
    );

    expect(service.list).toHaveBeenCalledWith("org_1", {
      sentiment: ConversationSentiment.POSITIVE,
      unread: true,
      needsReply: false,
      archived: true,
      leadId: "person_1",
      page: 2,
      limit: 50,
      search: "Buyer & Pilot",
    });
  });

  it.each(["   ", "x".repeat(201)])(
    "rejects an invalid search value before calling the service",
    (search) => {
      expect(() =>
        controller.list(
          "org_1",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          search,
        ),
      ).toThrow(BadRequestException);
      expect(service.list).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["invalid boolean", [undefined, "yes"]],
    ["unknown sentiment", ["happy"]],
    ["zero page", [undefined, undefined, undefined, undefined, undefined, "0"]],
    [
      "fractional limit",
      [undefined, undefined, undefined, undefined, undefined, undefined, "2.5"],
    ],
  ])("rejects %s list input before calling the service", (_label, args) => {
    expect(() =>
      controller.list(
        "org_1",
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
      ),
    ).toThrow(BadRequestException);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("requires a string body for human reply drafts", () => {
    expect(() => controller.createReply("org_1", "conversation_1", {})).toThrow(
      BadRequestException,
    );
    expect(service.createHumanReplyDraft).not.toHaveBeenCalled();

    controller.createReply("org_1", "conversation_1", {
      subject: "Re: Pilot",
      body: "Tuesday works.",
    });
    expect(service.createHumanReplyDraft).toHaveBeenCalledWith(
      "org_1",
      "conversation_1",
      { subject: "Re: Pilot", body: "Tuesday works." },
    );
  });

  it("rejects non-string optional reply and follow-up fields", () => {
    expect(() =>
      controller.createReply(
        "org_1",
        "conversation_1",
        { subject: 42, body: "Hello" } as unknown as {
          readonly subject?: string;
          readonly body?: string;
        },
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.createFollowUp(
        "org_1",
        "user_1",
        "conversation_1",
        { dueAt: "2026-09-01T10:00:00.000Z", note: false } as unknown as {
          readonly dueAt?: string;
          readonly note?: string;
        },
      ),
    ).toThrow(BadRequestException);
    expect(service.createHumanReplyDraft).not.toHaveBeenCalled();
    expect(service.createFollowUp).not.toHaveBeenCalled();
  });

  it("validates follow-up dates and derives the actor from Clerk context", () => {
    expect(() =>
      controller.createFollowUp("org_1", "user_1", "conversation_1", {
        dueAt: "not-a-date",
      }),
    ).toThrow(BadRequestException);
    expect(service.createFollowUp).not.toHaveBeenCalled();

    controller.createFollowUp("org_1", "user_1", "conversation_1", {
      dueAt: "2026-09-01T10:00:00.000Z",
      note: "Share the notes",
    });
    expect(service.createFollowUp).toHaveBeenCalledWith(
      "org_1",
      "conversation_1",
      {
        dueAt: new Date("2026-09-01T10:00:00.000Z"),
        note: "Share the notes",
        createdBy: "user_1",
      },
    );
  });

  it("allows only terminal follow-up transitions", () => {
    expect(() =>
      controller.updateFollowUp(
        "org_1",
        "user_1",
        "conversation_1",
        "follow_up_1",
        { status: "OPEN" },
      ),
    ).toThrow(BadRequestException);
    expect(service.updateFollowUp).not.toHaveBeenCalled();

    controller.updateFollowUp(
      "org_1",
      "user_1",
      "conversation_1",
      "follow_up_1",
      { status: "cancelled" },
    );
    expect(service.updateFollowUp).toHaveBeenCalledWith(
      "org_1",
      "conversation_1",
      "follow_up_1",
      FollowUpStatus.CANCELLED,
      "user_1",
    );
  });

  it("validates the meeting datetime and forwards human ownership", () => {
    expect(() =>
      controller.proposeMeeting("org_1", undefined, "conversation_1", {
        scheduledFor: "invalid",
      }),
    ).toThrow(BadRequestException);
    expect(service.proposeMeeting).not.toHaveBeenCalled();

    controller.proposeMeeting("org_1", "user_1", "conversation_1", {
      title: "Technical review",
      scheduledFor: "2026-09-02T11:00:00.000Z",
      durationMinutes: 45,
      notes: "Discuss security",
    });
    expect(service.proposeMeeting).toHaveBeenCalledWith(
      "org_1",
      "conversation_1",
      {
        title: "Technical review",
        scheduledFor: new Date("2026-09-02T11:00:00.000Z"),
        durationMinutes: 45,
        notes: "Discuss security",
        createdBy: "user_1",
      },
    );
  });

  it("rejects malformed optional meeting fields before calling the service", () => {
    expect(() =>
      controller.proposeMeeting(
        "org_1",
        "user_1",
        "conversation_1",
        {
          scheduledFor: "2026-09-02T11:00:00.000Z",
          title: 12,
        } as unknown as {
          readonly title?: string;
          readonly scheduledFor?: string;
          readonly durationMinutes?: number;
          readonly notes?: string;
        },
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.proposeMeeting("org_1", "user_1", "conversation_1", {
        scheduledFor: "2026-09-02T11:00:00.000Z",
        durationMinutes: 0,
      }),
    ).toThrow(BadRequestException);
    expect(service.proposeMeeting).not.toHaveBeenCalled();
  });
});
