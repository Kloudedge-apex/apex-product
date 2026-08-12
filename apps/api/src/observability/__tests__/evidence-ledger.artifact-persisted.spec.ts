import { describe, it, expect } from "vitest";
import { OutreachArtifactStatus } from "@prisma/client";
import { EvidenceLedgerService } from "../evidence-ledger.service";

// Minimal fake Prisma: artifactPersisted is append-only (no idempotency
// lookup), so only `create` needs to record what landed.
function fakePrisma() {
  const created: any[] = [];
  return {
    created,
    evidenceEvent: {
      create: async ({ data }: any) => {
        created.push(data);
        return data;
      },
      findFirst: async () => null,
    },
  } as any;
}

describe("artifactPersisted", () => {
  it("appends an artifact_persisted EvidenceEvent with the artifact ref + status payload", async () => {
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    await svc.artifactPersisted({
      orgId: "o1",
      runId: "r1",
      artifactId: "art_1",
      status: "PENDING_REVIEW",
      channel: "EMAIL",
    });
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0]).toMatchObject({
      orgId: "o1",
      runId: "r1",
      kind: "artifact.persisted",
      refType: "outreach_artifact",
      refId: "art_1",
    });
    expect(prisma.created[0].payload).toMatchObject({
      kind: "artifact.persisted",
      status: "PENDING_REVIEW",
      channel: "EMAIL",
    });
  });

  it("accepts every OutreachArtifactStatus, including DELIVERY_UNKNOWN", async () => {
    // Compile-time lock: `status` is typed as the full Prisma enum here, so
    // when a new enum value lands (as SENDING/SIMULATED did in the week-1
    // send-path work) without widening the ledger's status union, tsc fails
    // in THIS spec instead of at the OutreachArtifactsService call site that
    // passes `artifact.status` straight off the row.
    const prisma = fakePrisma();
    const svc = new EvidenceLedgerService(prisma);
    const statuses: OutreachArtifactStatus[] = Object.values(OutreachArtifactStatus);
    for (const status of statuses) {
      await svc.artifactPersisted({
        orgId: "o1",
        runId: "r1",
        artifactId: `art_${status}`,
        status,
        channel: "EMAIL",
      });
    }
    expect(prisma.created.map((r: any) => r.payload.status)).toEqual(statuses);
    expect(statuses).toContain("SENDING");
    expect(statuses).toContain("SIMULATED");
    expect(statuses).toContain("DELIVERY_UNKNOWN");
  });
});
