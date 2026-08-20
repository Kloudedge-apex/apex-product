import "reflect-metadata";
import { BadRequestException, RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { WindowDto } from "../dto/window.dto";
import { KpiCalculatorService } from "../kpi-calculator.service";
import { KpisController } from "../kpis.controller";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

function exposedGetPaths(): unknown[] {
  const prototype = KpisController.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((name) => {
    const handler = prototype[name];
    if (name === "constructor" || typeof handler !== "function") return [];
    return Reflect.getMetadata(METHOD_METADATA, handler) === RequestMethod.GET
      ? [Reflect.getMetadata(PATH_METADATA, handler)]
      : [];
  });
}

function controllerWithMeasuredKpis() {
  const kpis = {
    operational: vi.fn().mockResolvedValue({ metric: "operational" }),
    quality: vi.fn().mockResolvedValue({ metric: "quality" }),
    commercial: vi.fn().mockResolvedValue({ metric: "commercial" }),
    guaranteeDefense: vi.fn().mockResolvedValue({ metric: "guarantee" }),
  };
  return {
    controller: new KpisController(
      kpis as unknown as KpiCalculatorService,
    ),
    kpis,
  };
}

describe("KpisController release boundary", () => {
  it("mounts only measured KPI reads", () => {
    expect(exposedGetPaths()).toEqual([
      "/",
      "operational",
      "quality",
      "commercial",
      "guarantee-defense",
    ]);
    expect(exposedGetPaths()).not.toContain("experimentation");
    expect(Object.getOwnPropertyNames(KpisController.prototype)).not.toContain(
      "experimentation",
    );
  });

  it("aggregates only measured KPI families", async () => {
    const { controller, kpis } = controllerWithMeasuredKpis();
    const window = { windowDays: 7 } as WindowDto;

    await expect(controller.all("org_1", window)).resolves.toEqual({
      operational: { metric: "operational" },
      quality: { metric: "quality" },
      commercial: { metric: "commercial" },
      guaranteeDefense: { metric: "guarantee" },
    });
    for (const calculate of Object.values(kpis)) {
      expect(calculate).toHaveBeenCalledWith("org_1", window);
    }
  });

  it("rejects aggregate reads without tenant scope", async () => {
    const { controller, kpis } = controllerWithMeasuredKpis();

    await expect(
      controller.all(undefined, { windowDays: 7 } as WindowDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    for (const calculate of Object.values(kpis)) {
      expect(calculate).not.toHaveBeenCalled();
    }
  });
});
