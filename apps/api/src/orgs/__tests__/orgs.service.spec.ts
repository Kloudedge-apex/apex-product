import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { OrgsService } from "../orgs.service";

describe("OrgsService website validation", () => {
  function buildService() {
    const prisma = {
      org: {
        update: vi.fn().mockResolvedValue({ id: "org_test" }),
      },
    };
    const service = new OrgsService(prisma as never);
    return { service, prisma };
  }

  it("rejects non-https URLs", async () => {
    const { service, prisma } = buildService();
    await expect(
      service.update("org_test", { website: "http://example.com" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.org.update).not.toHaveBeenCalled();
  });

  it("rejects IP literal hostnames", async () => {
    const { service, prisma } = buildService();
    await expect(
      service.update("org_test", { website: "https://127.0.0.1" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.org.update).not.toHaveBeenCalled();
  });

  it("rejects non-public domains (missing TLD)", async () => {
    const { service, prisma } = buildService();
    await expect(
      service.update("org_test", { website: "https://localhost" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.org.update).not.toHaveBeenCalled();
  });

  it("accepts https public domains", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", { website: "https://acme.com" });
    expect(prisma.org.update).toHaveBeenCalledTimes(1);
    expect(prisma.org.update.mock.calls[0]?.[0]?.data?.website).toBe("https://acme.com/");
  });

  it("clears website when empty string provided", async () => {
    const { service, prisma } = buildService();
    await service.update("org_test", { website: "   " });
    expect(prisma.org.update).toHaveBeenCalledTimes(1);
    expect(prisma.org.update.mock.calls[0]?.[0]?.data?.website).toBeNull();
  });
});

