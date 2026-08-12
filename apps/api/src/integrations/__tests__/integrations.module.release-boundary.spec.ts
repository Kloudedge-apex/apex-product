import { MODULE_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { GmailModule } from "../gmail/gmail.module";
import { IntegrationsController } from "../integrations.controller";
import { IntegrationsModule } from "../integrations.module";

describe("IntegrationsModule guarded release boundary", () => {
  it("mounts only the canonical integration controller and Gmail module", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, IntegrationsModule),
    ).toEqual([IntegrationsController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, IntegrationsModule),
    ).toEqual([GmailModule]);
  });
});
