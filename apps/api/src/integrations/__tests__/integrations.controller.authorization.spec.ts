import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";
import { SKIP_ORG_GUARD } from "../../common/org-scope.guard";
import { IntegrationsController } from "../integrations.controller";

function guardsOn(method: keyof IntegrationsController): unknown[] {
  const handler = IntegrationsController.prototype[method];
  return Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
}

describe("IntegrationsController management authorization", () => {
  it.each([
    "gmailAuthUrl",
    "finalizeGmail",
    "disconnectGmail",
  ] as const)("attaches AdminOrManagerGuard to %s", (method) => {
    expect(guardsOn(method)).toContain(AdminOrManagerGuard);
  });

  it("keeps Gmail finalization behind the global identity lifecycle guard", () => {
    expect(
      Reflect.getMetadata(
        SKIP_ORG_GUARD,
        IntegrationsController.prototype.finalizeGmail,
      ),
    ).not.toBe(true);
  });

  it.each(["findAll", "getCatalog"] as const)(
    "keeps read-only status method %s available to authenticated org members",
    (method) => {
      expect(guardsOn(method)).not.toContain(AdminOrManagerGuard);
    },
  );
});
