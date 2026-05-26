import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { AgentsService } from "../agents.service";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * IDOR regression coverage for `AgentsService.findOne`.
 *
 * The service must scope every lookup by `orgId`. Before the fix, `orgId` was
 * optional and the controller didn't pass it, so any authenticated user could
 * read another tenant's agent (including its config + recent run logs).
 */

type FindFirstFn = ReturnType<typeof vi.fn>;

function mockPrisma(): PrismaService & {
  agent: { findFirst: FindFirstFn };
} {
  return {
    agent: {
      findFirst: vi.fn(),
    },
  } as unknown as PrismaService & {
    agent: { findFirst: FindFirstFn };
  };
}

describe("AgentsService.findOne (IDOR scoping)", () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: AgentsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new AgentsService(prisma as unknown as PrismaService);
  });

  it("includes orgId in the Prisma where clause", async () => {
    prisma.agent.findFirst.mockResolvedValue({
      id: "agent_1",
      orgId: "org_a",
      template: null,
      runs: [],
    });

    await service.findOne("agent_1", "org_a");

    expect(prisma.agent.findFirst).toHaveBeenCalledTimes(1);
    const callArg = prisma.agent.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: "agent_1", orgId: "org_a" });
  });

  it("throws NotFoundException when the agent belongs to a different org", async () => {
    // Prisma returns null because (id, orgId) doesn't match — cross-org attempt.
    prisma.agent.findFirst.mockResolvedValue(null);

    await expect(
      service.findOne("agent_owned_by_org_a", "org_b"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const callArg = prisma.agent.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({
      id: "agent_owned_by_org_a",
      orgId: "org_b",
    });
  });
});
