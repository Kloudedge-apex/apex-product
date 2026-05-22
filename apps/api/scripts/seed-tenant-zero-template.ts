#!/usr/bin/env tsx
/**
 * Seed the canonical tenant-zero workflow template:
 *   tenant_zero_sdr_outreach_artifact_v1
 *
 * Phase 2.5: targets the pipeline-supervisor graph, requires human approval,
 * and produces reviewable OutreachArtifacts only — no external sends.
 *
 *   pnpm tsx apps/api/scripts/seed-tenant-zero-template.ts
 *
 * Idempotent — re-running upserts the same row by slug.
 */
import { PrismaClient } from "@prisma/client";
import type { WorkflowTemplateConfig } from "../src/workflows/workflow-templates.service";

const SLUG = "tenant_zero_sdr_outreach_artifact_v1";

const config: WorkflowTemplateConfig = {
  inputs: [
    { name: "icpProfileIds", type: "string[]", required: true },
  ],
  notes:
    "Phase 2.5 dry-run-only template. Drives pipeline-supervisor: sourcing → enrichment → scoring → HITL → SDR outreach subgraph (artifacts).",
};

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const row = await prisma.workflowTemplate.upsert({
      where: { slug: SLUG },
      create: {
        slug: SLUG,
        name: "Tenant-Zero SDR Outreach (Artifact Mode)",
        description:
          "End-to-end SDR pipeline that drafts reviewable outreach artifacts. No external sends — every send_email/hubspot tool call is captured as an OutreachArtifact in PENDING_REVIEW.",
        version: 1,
        graphName: "pipeline-supervisor",
        config,
        requiresApproval: true,
        isActive: true,
      },
      update: {
        name: "Tenant-Zero SDR Outreach (Artifact Mode)",
        description:
          "End-to-end SDR pipeline that drafts reviewable outreach artifacts. No external sends — every send_email/hubspot tool call is captured as an OutreachArtifact in PENDING_REVIEW.",
        version: 1,
        graphName: "pipeline-supervisor",
        config,
        requiresApproval: true,
        isActive: true,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded WorkflowTemplate ${row.slug} (id=${row.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Seed failed:", err);
  process.exit(1);
});
