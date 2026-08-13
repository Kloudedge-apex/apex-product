import { HttpStatus, NotImplementedException } from "@nestjs/common";
import { BetaStubsController } from "../beta-stubs.controller";

describe("BetaStubsController guarded release boundary", () => {
  const controller = new BetaStubsController();

  it.each([
    ["inbox", () => controller.inbox("org_1")],
    ["accounts", () => controller.accounts("org_1")],
    ["campaigns", () => controller.campaigns("org_1")],
    ["playbooks", () => controller.playbooks("org_1")],
    ["deliverability", () => controller.deliverability("org_1")],
  ])("returns explicit unavailability for %s", (capability, invoke) => {
    let thrown: unknown;

    try {
      invoke();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotImplementedException);
    const exception = thrown as NotImplementedException;
    expect(exception.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
    expect(exception.getResponse()).toEqual({
      error: "capability_unavailable",
      capability,
      message: `${capability} is not available in the guarded SDR release`,
    });
  });
});
