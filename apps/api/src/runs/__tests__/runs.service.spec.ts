import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { RunsService } from "../runs.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * IDOR regression coverage for `RunsService.findOne`.
 *
 * The service must scope every lookup by `orgId` so that a run id from one
 * tenant cannot be read by an authenticated user belonging to another tenant.
 * Prior to the fix, `findOne` only filtered by `id`, leaking cross-org runs.
 */

type FindFirstFn = ReturnType<typeof vi.fn>;

function mockPrisma(): PrismaService & {
  agentRun: { findFirst: FindFirstFn };
} {
  return {
    agentRun: {
      findFirst: vi.fn(),
    },
  } as unknown as PrismaService & {
    agentRun: { findFirst: FindFirstFn };
  };
}

describe("RunsService.findOne (IDOR scoping)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: RunsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new RunsService(prisma as unknown as PrismaService);
  });

  it("includes orgId in the Prisma where clause", async () => {
    prisma.agentRun.findFirst.mockResolvedValue({
      id: "run_1",
      orgId: "org_a",
      agent: { id: "agent_1", name: "SDR", domain: "SALES", templateId: null },
      logs: [],
      steps: [],
    });

    await service.findOne("run_1", "org_a");

    expect(prisma.agentRun.findFirst).toHaveBeenCalledTimes(1);
    const callArg = prisma.agentRun.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: "run_1", orgId: "org_a" });
  });

  it("throws NotFoundException when the run belongs to a different org", async () => {
    // Simulates Prisma returning null because the run id exists but the
    // (id, orgId) tuple doesn't match — i.e. cross-org access attempt.
    prisma.agentRun.findFirst.mockResolvedValue(null);

    await expect(service.findOne("run_owned_by_org_a", "org_b")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const callArg = prisma.agentRun.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: "run_owned_by_org_a", orgId: "org_b" });
  });
});
