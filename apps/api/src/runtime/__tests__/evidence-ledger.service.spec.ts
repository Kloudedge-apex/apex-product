import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type EvidenceEventCreateArgs = { readonly data: Record<string, unknown> };

const createSpy = vi
  .fn<(args: EvidenceEventCreateArgs) => Promise<unknown>>()
  .mockResolvedValue(undefined);

vi.mock("../../prisma/prisma.service", () => {
  class PrismaService {
    readonly evidenceEvent = { create: createSpy };
  }

  return { PrismaService };
});

import { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import { PrismaService } from "../../prisma/prisma.service";

describe("EvidenceLedgerService", () => {
  beforeEach(() => {
    createSpy.mockClear();
    delete process.env.EVIDENCE_LEDGER_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is gated on EVIDENCE_LEDGER_ENABLED !== \"false\"", async () => {
    process.env.EVIDENCE_LEDGER_ENABLED = "false";

    const prisma = new PrismaService();
    const svc = new EvidenceLedgerService(prisma);

    await svc.leadSourced({
      orgId: "org_1",
      runId: "run_1",
      companies: 1,
      people: 1,
    });

    expect(createSpy).toHaveBeenCalledTimes(0);
  });

  it("writes when EVIDENCE_LEDGER_ENABLED is unset", async () => {
    const prisma = new PrismaService();
    const svc = new EvidenceLedgerService(prisma);

    await svc.leadSourced({
      orgId: "org_1",
      runId: "run_1",
      companies: 1,
      people: 1,
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [args] = createSpy.mock.calls[0] ?? [];
    expect(args).toBeDefined();
    expect(args?.data.orgId).toBe("org_1");
  });
});

