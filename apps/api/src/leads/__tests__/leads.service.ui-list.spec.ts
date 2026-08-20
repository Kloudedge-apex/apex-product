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

describe("LeadsService.getPersonDetail", () => {
  it("returns tenant-scoped research, score categories and attributable evidence", async () => {
    const now = new Date();
    const prisma = {
      person: {
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: "person_1",
          companyId: "company_1",
          firstName: "Ari",
          lastName: "Rivera",
          title: "VP Sales",
          seniority: "VP",
          department: "SALES",
          linkedinUrl: "https://linkedin.com/in/ari-rivera",
          location: "Austin, TX",
          bio: null,
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          company: {
            id: "company_1",
            name: "Example",
            domain: "example.com",
            industry: "Software",
            employeeRange: "51-200",
            country: "US",
            city: "Austin",
            fundingStage: "Series A",
            techStack: ["HubSpot"],
          },
          emails: [{
            email: "ari@example.com",
            pattern: "first",
            source: "TEAM_PAGE",
            confidence: 0.95,
            verified: true,
            verificationResult: "VALID",
          }],
          scores: [{
            score: 91,
            qualifiedAt: now,
            breakdown: { fit: 100, intent: 80, engagement: 90, timing: 80 },
          }],
        }),
      },
      evidenceEvent: {
        findMany: vi.fn().mockResolvedValue([{
          id: "evidence_1",
          kind: "recent_hire",
          payload: {
            source: "https://jobs.example.com/account-executive",
            date: now.toISOString().slice(0, 10),
            confidence: 0.9,
            jobTitle: "Account Executive",
          },
          createdAt: now,
        }]),
      },
    } as unknown as PrismaService;

    const result = await buildService(prisma).getPersonDetail("org_1", "person_1");

    expect(prisma.person.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "person_1", company: { orgId: "org_1" } } }),
    );
    expect(prisma.evidenceEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: "org_1",
          OR: [
            { refType: "person", refId: "person_1" },
            { refType: "company", refId: "company_1" },
          ],
        },
      }),
    );
    expect(result.scoreBreakdown).toEqual({ fit: 100, intent: 80, engagement: 90, timing: 80 });
    expect(result.intentSignals).toEqual([
      { label: "Hiring for Account Executive", confidence: 0.9 },
    ]);
    expect(result.researchBrief).toContain("Recent attributable evidence");
    expect(result.recentEvidenceEvents).toHaveLength(1);
  });
});
