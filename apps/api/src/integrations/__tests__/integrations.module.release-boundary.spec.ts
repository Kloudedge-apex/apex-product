import { RequestMethod } from "@nestjs/common";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { GmailModule } from "../gmail/gmail.module";
import { IntegrationsController } from "../integrations.controller";
import { IntegrationsModule } from "../integrations.module";
import { IntegrationsService } from "../integrations.service";
import { OAuthAttemptService } from "../oauth-attempt.service";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";

const PATH_METADATA = "path";
const METHOD_METADATA = "method";

function exposedRoutes() {
  return Object.getOwnPropertyNames(IntegrationsController.prototype)
    .filter((name) => name !== "constructor")
    .flatMap((name) => {
      const handler = (
        IntegrationsController.prototype as unknown as Record<string, unknown>
      )[name];
      if (typeof handler !== "function") return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
      return path === undefined || method === undefined
        ? []
        : [{ name, path, method }];
    });
}

describe("IntegrationsModule guarded release boundary", () => {
  it("mounts only the canonical integration controller and Gmail providers", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, IntegrationsModule),
    ).toEqual([IntegrationsController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, IntegrationsModule),
    ).toEqual([GmailModule]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IntegrationsModule),
    ).toEqual([
      IntegrationsService,
      AdminOrManagerGuard,
      OAuthAttemptService,
    ]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, IntegrationsModule),
    ).toEqual([IntegrationsService, GmailModule]);
  });

  it("publishes only the exact Gmail release operations", () => {
    expect(exposedRoutes()).toEqual([
      { name: "findAll", path: "/", method: RequestMethod.GET },
      { name: "getCatalog", path: "catalog", method: RequestMethod.GET },
      {
        name: "gmailAuthUrl",
        path: "gmail/auth-url",
        method: RequestMethod.GET,
      },
      {
        name: "gmailCallback",
        path: "gmail/callback",
        method: RequestMethod.GET,
      },
      {
        name: "finalizeGmail",
        path: "gmail/finalize",
        method: RequestMethod.POST,
      },
      {
        name: "disconnectGmail",
        path: "gmail/disconnect",
        method: RequestMethod.POST,
      },
    ]);
  });
});
