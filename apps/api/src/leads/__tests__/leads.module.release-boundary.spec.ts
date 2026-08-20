import { RequestMethod } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { RuntimeModule } from "../../runtime/runtime.module";
import { LeadsController } from "../leads.controller";
import { LeadsModule } from "../leads.module";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

function exposedRoutes() {
  return Object.getOwnPropertyNames(LeadsController.prototype)
    .filter((name) => name !== "constructor")
    .flatMap((name) => {
      const handler = (
        LeadsController.prototype as unknown as Record<string, unknown>
      )[name];
      if (typeof handler !== "function") return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
      return path === undefined || method === undefined
        ? []
        : [{ name, path, method }];
    });
}

describe("LeadsModule release boundary", () => {
  it("mounts the lead surface without a dormant scheduler", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, LeadsModule)).toEqual([
      RuntimeModule,
    ]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, LeadsModule),
    ).toEqual([LeadsController]);
  });

  it("does not publish duplicate discovery or inactive schedule operations", () => {
    expect(exposedRoutes()).toEqual([
      { name: "listLeads", path: "/", method: RequestMethod.GET },
      { name: "createIcp", path: "icp", method: RequestMethod.POST },
      {
        name: "upsertCurrentIcp",
        path: "icp/current",
        method: RequestMethod.PATCH,
      },
      { name: "listIcpProfiles", path: "icp", method: RequestMethod.GET },
      { name: "listCompanies", path: "companies", method: RequestMethod.GET },
      {
        name: "listCompanyPeople",
        path: "companies/:companyId/people",
        method: RequestMethod.GET,
      },
      { name: "listPeople", path: "people", method: RequestMethod.GET },
      { name: "exportCsv", path: "export/csv", method: RequestMethod.GET },
      { name: "getPersonDetail", path: "people/:id", method: RequestMethod.GET },
      { name: "listJobs", path: "jobs", method: RequestMethod.GET },
      { name: "getJob", path: "jobs/:id", method: RequestMethod.GET },
      { name: "getStats", path: "stats", method: RequestMethod.GET },
    ]);
  });
});
