import { describe, expect, it, vi } from "vitest";
import { SerpDiscoveryService } from "../serp-discovery.service";

describe("SerpDiscoveryService company classification", () => {
  it("classifies a validated Serper description without copying ICP values", async () => {
    const chat = vi.fn().mockResolvedValue({
      content: '{"industry":"Logistics software","country":"India"}',
      tokensUsed: 20,
      model: "test",
      cost: 0,
    });
    const service = new SerpDiscoveryService(
      { get: vi.fn().mockReturnValue("serper-key") } as never,
      { chat } as never,
    );
    vi.spyOn(service as never, "executeSearch").mockResolvedValue([
      {
        title: "Acme | Warehouse scheduling",
        link: "https://acme.example/platform",
        snippet:
          "Acme builds warehouse scheduling software for logistics teams across India.",
      },
    ]);
    vi.spyOn(service as never, "validateDomain").mockResolvedValue(
      "acme.example",
    );

    const result = await service.discoverCompanies("org_1", {
      targetTitles: ["VP Operations"],
      targetIndustries: ["Unrelated ICP industry"],
      targetGeos: ["Unrelated ICP country"],
    });

    expect(result[0]).toMatchObject({
      domain: "acme.example",
      industry: "Logistics software",
      country: "India",
      description: expect.stringContaining("warehouse scheduling"),
    });
    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ orgId: "org_1", temperature: 0, topP: 0.9 }),
    );
  });
});
