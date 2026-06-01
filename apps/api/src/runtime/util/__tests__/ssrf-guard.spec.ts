import { describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";

function lookupFor(map: Record<string, readonly LookupAddress[]>) {
  return async (hostname: string): Promise<readonly LookupAddress[]> => {
    const hit = map[hostname];
    if (!hit) {
      throw new Error(`Unexpected lookup for hostname=${hostname}`);
    }
    return hit;
  };
}

describe("ssrf-guard", () => {
  it.each([
    ["10/8", "10.0.0.1", 4],
    ["172.16/12-low", "172.16.0.1", 4],
    ["172.16/12-high", "172.31.255.255", 4],
    ["192.168/16", "192.168.1.1", 4],
    ["127/8", "127.0.0.1", 4],
    ["169.254/16", "169.254.10.2", 4],
    ["::1", "::1", 6],
    ["fc00::/7", "fd00::1", 6],
    ["fe80::/10", "fe80::1", 6],
  ] satisfies Array<[string, string, 4 | 6]>)("blocks %s (%s)", async (_label, ip, family) => {
    const { assertUrlIsPublicHttp } = await import("../ssrf-guard");
    await expect(
      assertUrlIsPublicHttp("https://blocked.test/", {
        lookupAll: lookupFor({
          "blocked.test": [{ address: ip, family }],
        }),
      }),
    ).rejects.toThrow(/Blocked IP/);
  });

  it("allows public IPs", async () => {
    const { assertUrlIsPublicHttp } = await import("../ssrf-guard");
    await expect(
      assertUrlIsPublicHttp("https://example.test/", {
        lookupAll: lookupFor({
          "example.test": [{ address: "93.184.216.34", family: 4 }],
        }),
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("re-validates every redirect hop and blocks redirect-to-internal", async () => {
    const { ssrfGuardedFetch } = await import("../ssrf-guard");

    const fetcher = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: { location: "http://internal.test/" },
      });
    });

    await expect(
      ssrfGuardedFetch(
        "https://public.test/",
        {},
        {
          fetcher,
          lookupAll: lookupFor({
            "public.test": [{ address: "93.184.216.34", family: 4 }],
            "internal.test": [{ address: "127.0.0.1", family: 4 }],
          }),
        },
      ),
    ).rejects.toThrow(/Blocked IP/);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

