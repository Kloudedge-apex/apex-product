import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { GmailService } from "../gmail.service";
import { AdminOrManagerGuard } from "../../../common/admin-or-manager.guard";
import type { PrismaService } from "../../../prisma/prisma.service";
import type { ConfigService } from "@nestjs/config";
import type { RuntimeService } from "../../../runtime/runtime.service";

function createMockPrisma() {
  return {
    outreachArtifact: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaService;
}

function createMockConfig() {
  return {
    get: vi.fn().mockImplementation((_key: string, defaultValue?: string) => {
      return defaultValue ?? "";
    }),
  } as unknown as ConfigService;
}

function createMockRuntime() {
  return {} as unknown as RuntimeService;
}

function createExecutionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe("Gmail send outreach gating", () => {
  const originalEnv = process.env.OUTREACH_LIVE_FOR_ORGS;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OUTREACH_LIVE_FOR_ORGS = originalEnv;
  });

  afterEach(() => {
    process.env.OUTREACH_LIVE_FOR_ORGS = originalEnv;
  });

  it("returns 403 when org is not allowlisted", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_allowed";

    const prisma = createMockPrisma();
    const service = new GmailService(prisma, createMockConfig(), createMockRuntime());

    await expect(
      service.sendApprovedOutreachEmail("org_denied", {
        outreachArtifactId: "art_1",
        to: "to@example.com",
        subject: "Hello",
        body: "Body",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.outreachArtifact.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 when approved artifact is missing", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";

    const prisma = createMockPrisma();
    prisma.outreachArtifact.findUnique.mockResolvedValue(null);

    const service = new GmailService(prisma, createMockConfig(), createMockRuntime());

    await expect(
      service.sendApprovedOutreachEmail("org_1", {
        outreachArtifactId: "missing",
        to: "to@example.com",
        subject: "Hello",
        body: "Body",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("returns 403 when payload does not match approved artifact", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";

    const prisma = createMockPrisma();
    prisma.outreachArtifact.findUnique.mockResolvedValue({
      id: "art_1",
      orgId: "org_1",
      status: "APPROVED",
      toolName: "send_email",
      payload: {
        to: "someone-else@example.com",
        subject: "Hello",
        body: "Body",
      },
    });

    const service = new GmailService(prisma, createMockConfig(), createMockRuntime());

    await expect(
      service.sendApprovedOutreachEmail("org_1", {
        outreachArtifactId: "art_1",
        to: "to@example.com",
        subject: "Hello",
        body: "Body",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("returns 403 when caller role is denied (member)", async () => {
    const prisma = createMockPrisma();
    const guard = new AdminOrManagerGuard(prisma);
    const ctx = createExecutionContext({ clerkOrgRole: "org:member" });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("returns 200 and sends when allowlisted + admin/manager + approved payload match", async () => {
    process.env.OUTREACH_LIVE_FOR_ORGS = "org_1";

    const prisma = createMockPrisma();
    prisma.outreachArtifact.findUnique.mockResolvedValue({
      id: "art_1",
      orgId: "org_1",
      status: "APPROVED",
      toolName: "send_email",
      payload: {
        to: "to@example.com",
        subject: "Hello",
        body: "Body",
      },
    });
    prisma.outreachArtifact.update.mockResolvedValue({
      id: "art_1",
      status: "SENT",
    });

    const service = new GmailService(prisma, createMockConfig(), createMockRuntime());
    const sendSpy = vi
      .spyOn(service, "sendEmail")
      .mockResolvedValue({ id: "msg_1", threadId: "thr_1" });

    const result = await service.sendApprovedOutreachEmail("org_1", {
      outreachArtifactId: "art_1",
      to: "to@example.com",
      subject: "Hello",
      body: "Body",
    });

    expect(result).toEqual({ id: "msg_1", threadId: "thr_1" });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(prisma.outreachArtifact.update).toHaveBeenCalledTimes(1);
  });
});

