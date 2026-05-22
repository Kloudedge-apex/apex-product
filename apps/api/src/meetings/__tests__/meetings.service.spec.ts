import { describe, it, expect, beforeEach, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  MeetingSource,
  MeetingStatus,
  type MeetingLedger,
} from "@prisma/client";
import { MeetingsService } from "../meetings.service";
import { PrismaService } from "../../prisma/prisma.service";

function meetingRow(overrides: Partial<MeetingLedger> = {}): MeetingLedger {
  return {
    id: "mtg_1",
    orgId: "org_1",
    outreachArtifactId: null,
    personId: null,
    title: "Intro chat",
    description: null,
    scheduledFor: new Date("2026-06-01T15:00:00Z"),
    durationMinutes: 30,
    attendeeEmails: ["alice@example.com"],
    notes: null,
    status: MeetingStatus.PROPOSED,
    source: MeetingSource.AGENT_PROPOSED,
    createdBy: null,
    confirmedBy: null,
    confirmedAt: null,
    cancelledReason: null,
    cancelledAt: null,
    createdAt: new Date("2026-05-22T00:00:00Z"),
    updatedAt: new Date("2026-05-22T00:00:00Z"),
    ...overrides,
  };
}

function mockPrisma() {
  return {
    meetingLedger: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    outreachArtifact: {
      findUnique: vi.fn(),
    },
    person: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaService;
}

describe("MeetingsService", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: MeetingsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new MeetingsService(prisma as unknown as PrismaService);
  });

  describe("create", () => {
    const baseInput = {
      orgId: "org_1",
      title: "Intro chat",
      scheduledFor: new Date("2026-06-01T15:00:00Z"),
      attendeeEmails: ["Alice@Example.com"],
    };

    it("persists a meeting with lowercased, deduped attendees", async () => {
      (prisma.meetingLedger.create as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow(),
      );

      await service.create({
        ...baseInput,
        attendeeEmails: ["Alice@Example.com", "alice@example.com", "Bob@x.io"],
      });

      const createArg = (prisma.meetingLedger.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(createArg.data.attendeeEmails).toEqual(["alice@example.com", "bob@x.io"]);
    });

    it("rejects invalid email addresses", async () => {
      await expect(
        service.create({ ...baseInput, attendeeEmails: ["not-an-email"] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects empty title", async () => {
      await expect(
        service.create({ ...baseInput, title: "   " }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects nonsensical durationMinutes", async () => {
      await expect(
        service.create({ ...baseInput, durationMinutes: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create({ ...baseInput, durationMinutes: 2000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an outreachArtifactId from a different org", async () => {
      (prisma.outreachArtifact.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        orgId: "org_other",
      });
      await expect(
        service.create({ ...baseInput, outreachArtifactId: "art_other" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a personId from a different org", async () => {
      (prisma.person.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        company: { orgId: "org_other" },
      });
      await expect(
        service.create({ ...baseInput, personId: "p_other" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("accepts valid same-org FKs", async () => {
      (prisma.outreachArtifact.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        orgId: "org_1",
      });
      (prisma.person.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        company: { orgId: "org_1" },
      });
      (prisma.meetingLedger.create as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow(),
      );
      await service.create({
        ...baseInput,
        outreachArtifactId: "art_ok",
        personId: "p_ok",
      });
      expect(prisma.meetingLedger.create).toHaveBeenCalled();
    });

    it("defaults source to AGENT_PROPOSED and durationMinutes to 30", async () => {
      (prisma.meetingLedger.create as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow(),
      );
      await service.create(baseInput);
      const createArg = (prisma.meetingLedger.create as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(createArg.data.source).toBe(MeetingSource.AGENT_PROPOSED);
      expect(createArg.data.durationMinutes).toBe(30);
    });
  });

  describe("get", () => {
    it("returns the row when found and owned by org", async () => {
      const row = meetingRow();
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);
      await expect(service.get("org_1", row.id)).resolves.toEqual(row);
    });

    it("throws NotFound when row missing", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.get("org_1", "missing")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws NotFound when row owned by another org", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ orgId: "org_other" }),
      );
      await expect(service.get("org_1", "mtg_1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("forbids updating a CANCELLED meeting", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.CANCELLED }),
      );
      await expect(
        service.update("org_1", "mtg_1", { title: "New" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("forbids updating a COMPLETED meeting", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.COMPLETED }),
      );
      await expect(
        service.update("org_1", "mtg_1", { title: "New" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("only sends provided fields to prisma", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow(),
      );
      (prisma.meetingLedger.update as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow(),
      );
      await service.update("org_1", "mtg_1", { title: "Updated" });
      const updateArg = (prisma.meetingLedger.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateArg.data).toEqual({ title: "Updated" });
    });
  });

  describe("confirm", () => {
    it("transitions PROPOSED → CONFIRMED with confirmedBy", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow(),
      );
      (prisma.meetingLedger.update as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.CONFIRMED, confirmedBy: "user_1" }),
      );
      const result = await service.confirm("org_1", "mtg_1", "user_1");
      expect(result.status).toBe(MeetingStatus.CONFIRMED);
      const updateArg = (prisma.meetingLedger.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateArg.data.confirmedBy).toBe("user_1");
      expect(updateArg.data.confirmedAt).toBeInstanceOf(Date);
    });

    it("refuses to confirm a non-PROPOSED meeting", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.CONFIRMED }),
      );
      await expect(service.confirm("org_1", "mtg_1", "user_1")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("cancel", () => {
    it("transitions PROPOSED → CANCELLED with reason", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow(),
      );
      (prisma.meetingLedger.update as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.CANCELLED, cancelledReason: "rescheduled" }),
      );
      await service.cancel("org_1", "mtg_1", "rescheduled");
      const updateArg = (prisma.meetingLedger.update as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(updateArg.data.status).toBe(MeetingStatus.CANCELLED);
      expect(updateArg.data.cancelledReason).toBe("rescheduled");
    });

    it("refuses to cancel an already CANCELLED meeting", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.CANCELLED }),
      );
      await expect(service.cancel("org_1", "mtg_1")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("markCompleted", () => {
    it("only allows CONFIRMED → COMPLETED", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.PROPOSED }),
      );
      await expect(service.markCompleted("org_1", "mtg_1")).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("transitions CONFIRMED → COMPLETED", async () => {
      (prisma.meetingLedger.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.CONFIRMED }),
      );
      (prisma.meetingLedger.update as ReturnType<typeof vi.fn>).mockResolvedValue(
        meetingRow({ status: MeetingStatus.COMPLETED }),
      );
      const result = await service.markCompleted("org_1", "mtg_1");
      expect(result.status).toBe(MeetingStatus.COMPLETED);
    });
  });

  describe("list", () => {
    it("applies status and time-range filters", async () => {
      (prisma.meetingLedger.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const from = new Date("2026-06-01T00:00:00Z");
      const to = new Date("2026-06-30T23:59:59Z");
      await service.list("org_1", { status: MeetingStatus.PROPOSED, from, to, limit: 10 });
      const findArg = (prisma.meetingLedger.findMany as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(findArg.where).toEqual({
        orgId: "org_1",
        status: MeetingStatus.PROPOSED,
        scheduledFor: { gte: from, lte: to },
      });
      expect(findArg.take).toBe(10);
      expect(findArg.orderBy).toEqual({ scheduledFor: "asc" });
    });

    it("clamps limit to 200 max", async () => {
      (prisma.meetingLedger.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await service.list("org_1", { limit: 5000 });
      const findArg = (prisma.meetingLedger.findMany as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(findArg.take).toBe(200);
    });
  });
});
