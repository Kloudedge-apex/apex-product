import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { ActivityController } from "../activity.controller";
import { DashboardController } from "../dashboard.controller";
import { DashboardModule } from "../dashboard.module";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

function exposedRoutes(controller: { readonly prototype: object }) {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .flatMap((name) => {
      const handler = prototype[name];
      if (typeof handler !== "function") return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
      return path === undefined || method === undefined
        ? []
        : [{ name, path, method }];
    });
}

describe("DashboardModule guarded release boundary", () => {
  it("mounts only the measured dashboard and activity read controllers", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, DashboardModule),
    ).toEqual([DashboardController, ActivityController]);
    expect(exposedRoutes(DashboardController)).toEqual([
      { name: "stats", path: "stats", method: RequestMethod.GET },
    ]);
    expect(exposedRoutes(ActivityController)).toEqual([
      { name: "list", path: "/", method: RequestMethod.GET },
    ]);
  });

  it("does not publish the retired no-op KPI selection mutation", () => {
    expect(Object.getOwnPropertyNames(DashboardController.prototype)).not.toContain(
      "kpis",
    );
  });
});
