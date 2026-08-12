import { describe, expect, it, vi } from "vitest";
import { PipelineController } from "../pipeline.controller";
import type { PrismaService } from "../../prisma/prisma.service";
import type { IcpAutoService } from "../icp-auto.service";
import type { GraphService } from "../../graph/graph.service";

describe("PipelineController current ICP contract", () => {
  it("runs only the newest profile when historical rows exist", async () => {
    const prisma = {
      icpProfile: {
        findFirst: vi.fn().mockResolvedValue({
          id: "icp_current",
          name: "Current ICP",
        }),
      },
    };
    const icpAuto = { generateForOrg: vi.fn() };
    const graph = {
      runPipelineGraph: vi.fn().mockResolvedValue({
        runId: "run_1",
        threadId: "run_1",
      }),
    };
    const controller = new PipelineController(
      prisma as unknown as PrismaService,
      icpAuto as unknown as IcpAutoService,
      graph as unknown as GraphService,
    );

    const result = await controller.run("org_1", {});

    expect(prisma.icpProfile.findFirst).toHaveBeenCalledWith({
      where: { orgId: "org_1" },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(graph.runPipelineGraph).toHaveBeenCalledWith("org_1", [
      "icp_current",
    ]);
    expect(result.triggered).toEqual([
      { icpProfileId: "icp_current", name: "Current ICP" },
    ]);
    expect(icpAuto.generateForOrg).not.toHaveBeenCalled();
  });
});
