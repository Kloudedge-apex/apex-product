import { describe, expect, it, vi } from "vitest";
import { OrgsService } from "../orgs.service";

/**
 * Sender-identity persistence (audit B1).
 *
 * The Org columns physicalAddress / senderName / country exist in the schema
 * and are read by the CAN-SPAM gate in send-outreach.worker.ts, but
 * OrgsService.update never wrote them — so live email outreach fail-closed
 * forever. These tests pin that update() now persists all three fields and
 * still omits them from the Prisma payload when the caller didn't send them
 * (a PATCH of just `name` must not null out an existing address).
 */
describe("OrgsService sender identity persistence", () => {
  function buildService() {
    const prisma = {
      org: {
        update: vi.fn().mockResolvedValue({ id: "org_test" }),
      },
    };
    const service = new OrgsService(prisma as never);
    return { service, prisma };
  }

  it("persists physicalAddress, senderName and country", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", {
      physicalAddress: "548 Market St, San Francisco, CA 94104, USA",
      senderName: "Jane Doe",
      country: "US",
    });
    expect(prisma.org.update).toHaveBeenCalledTimes(1);
    const data = prisma.org.update.mock.calls[0]?.[0]?.data;
    expect(data?.physicalAddress).toBe(
      "548 Market St, San Francisco, CA 94104, USA",
    );
    expect(data?.senderName).toBe("Jane Doe");
    expect(data?.country).toBe("US");
  });

  it("trims sender-identity strings before persisting (service is also called outside the HTTP pipe)", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", {
      physicalAddress: "  548 Market St, SF  ",
      senderName: "  Jane Doe ",
      country: " US ",
    });
    const data = prisma.org.update.mock.calls[0]?.[0]?.data;
    expect(data?.physicalAddress).toBe("548 Market St, SF");
    expect(data?.senderName).toBe("Jane Doe");
    expect(data?.country).toBe("US");
  });

  it("omits sender-identity fields from the Prisma payload when not provided", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", { name: "Acme Renamed" });
    const data = prisma.org.update.mock.calls[0]?.[0]?.data;
    expect(data?.name).toBe("Acme Renamed");
    expect(data).not.toHaveProperty("physicalAddress");
    expect(data).not.toHaveProperty("senderName");
    expect(data).not.toHaveProperty("country");
  });

  it("can set one identity field without touching the others", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", { senderName: "Jane Doe" });
    const data = prisma.org.update.mock.calls[0]?.[0]?.data;
    expect(data?.senderName).toBe("Jane Doe");
    expect(data).not.toHaveProperty("physicalAddress");
    expect(data).not.toHaveProperty("country");
  });
});
