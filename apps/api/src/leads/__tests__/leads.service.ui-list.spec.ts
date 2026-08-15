import { describe, expect, it, vi } from "vitest";
import { LeadsService } from "../leads.service";
import type { PrismaService } from "../../prisma/prisma.service";

function buildService(prisma: PrismaService): LeadsService {
  const stub = {} as never;
  return new LeadsService(
    prisma,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
}

describe("LeadsService.listLeadsForUi", () => {
  it("returns null when a person has never been scored", async () => {
    const prisma = {
      person: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "person_unscored",
            firstName: "Ari",
            lastName: "Rivera",
            title: "VP Sales",
            createdAt: new Date("2026-08-12T00:00:00.000Z"),
            company: {
              name: "Example",
              domain: "example.com",
              industry: "Software",
              employeeRange: "51-200",
              techStack: [],
            },
            scores: [],
            emails: [],
          },
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
      outreachArtifact: { findMany: vi.fn().mockResolvedValue([]) },
      meetingLedger: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const result = await buildService(prisma).listLeadsForUi("org_1", {
      page: 1,
      perPage: 20,
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.score).toBeNull();
  });
});
