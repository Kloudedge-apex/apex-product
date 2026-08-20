import type { Prisma, OutreachArtifactStatus } from "@prisma/client";

function requireOrgId(orgId: string): string {
  const trimmed = orgId.trim();
  if (!trimmed) {
    throw new Error("orgId is required to build KPI queries");
  }
  return trimmed;
}

export function whereEvidenceEventsInWindow(
  orgId: string,
  since: Date,
  kinds?: readonly string[],
): Prisma.EvidenceEventWhereInput {
  const safeOrgId = requireOrgId(orgId);
  return {
    orgId: safeOrgId,
    createdAt: { gte: since },
    ...(kinds && kinds.length > 0 ? { kind: { in: [...kinds] } } : {}),
  };
}

export function whereGraphRunsInWindow(
  orgId: string,
  since: Date,
): Prisma.GraphRunWhereInput {
  const safeOrgId = requireOrgId(orgId);
  return { orgId: safeOrgId, startedAt: { gte: since } };
}

export function whereOutreachArtifactsInWindow(
  orgId: string,
  since: Date,
  status: OutreachArtifactStatus | undefined,
  lifecycleTimestamp: "createdAt" | "reviewedAt" | "failedAt" | "sentAt",
): Prisma.OutreachArtifactWhereInput {
  const safeOrgId = requireOrgId(orgId);
  return {
    orgId: safeOrgId,
    [lifecycleTimestamp]: { gte: since },
    ...(status ? { status } : {}),
  };
}

export function whereLeadScores(
  orgId: string,
): Prisma.LeadScoreWhereInput {
  const safeOrgId = requireOrgId(orgId);
  return { orgId: safeOrgId };
}
