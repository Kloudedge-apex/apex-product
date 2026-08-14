import { describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
    ["unspecified IPv4", "0.0.0.0", 4],
    ["IPv4 current network", "0.1.2.3", 4],
    ["carrier-grade NAT", "100.64.0.1", 4],
    ["benchmark IPv4", "198.18.0.1", 4],
    ["IPv4 multicast", "224.0.0.1", 4],
    ["IPv4 reserved", "240.0.0.1", 4],
    ["unspecified IPv6", "::", 6],
    ["::1", "::1", 6],
    ["fc00::/7", "fd00::1", 6],
    ["fe80::/10", "fe80::1", 6],
    ["IPv6 multicast", "ff02::1", 6],
    ["IPv6 documentation", "2001:db8::1", 6],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1", 6],
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

    await expect(
      assertUrlIsPublicHttp("https://ipv6.example.test/", {
        lookupAll: lookupFor({
          "ipv6.example.test": [
            { address: "2001:4860::a00:1", family: 6 },
          ],
        }),
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it.each(["http://0.0.0.0/", "http://[::]/"])(
    "rejects a blocked literal without a second resolver path (%s)",
    async (url) => {
      const { assertUrlIsPublicHttp } = await import("../ssrf-guard");
      await expect(assertUrlIsPublicHttp(url)).rejects.toThrow(/Blocked IP/);
    },
  );

  it("pins the exact validated DNS snapshot and rejects another hostname", async () => {
    const { selectPinnedAddress } = await import("../ssrf-guard");
    const snapshot = [{ address: "93.184.216.34", family: 4 as const }];
    expect(selectPinnedAddress("public.test", "public.test", snapshot)).toEqual(
      snapshot[0],
    );
    expect(() =>
      selectPinnedAddress("rebound.internal", "public.test", snapshot),
    ).toThrow(/hostname did not match/);
  });

  it("uses the pinned lookup through Undici's all-address connector mode", async () => {
    let receivedHost: string | undefined;
    const server = createServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const { createPinnedFetch } = await import("../ssrf-guard");
      // This lower-level connector test deliberately supplies loopback as the
      // already-validated snapshot; public-range rejection is covered above.
      const pinnedFetch = createPinnedFetch(
        new URL(`http://pinned.test:${port}/`),
        [{ address: "127.0.0.1", family: 4 }],
      );
      const response = await pinnedFetch(`http://pinned.test:${port}/`);

      expect(await response.text()).toBe("pinned-ok");
      expect(receivedHost).toBe(`pinned.test:${port}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("hands custom retry logic only the DNS-pinned transport", async () => {
    const { ssrfGuardedFetch } = await import("../ssrf-guard");
    const fetcher = vi.fn(
      async (
        _url: URL,
        _init: RequestInit,
        pinnedFetch: unknown,
      ) => {
        expect(pinnedFetch).toBeTypeOf("function");
        return new Response("ok", { status: 200 });
      },
    );

    const response = await ssrfGuardedFetch(
      "https://public.test/",
      {},
      {
        fetcher,
        lookupAll: lookupFor({
          "public.test": [{ address: "93.184.216.34", family: 4 }],
        }),
      },
    );

    expect(await response.text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("bounded-drains a discarded non-success response", async () => {
    const { ssrfGuardedFetch } = await import("../ssrf-guard");
    const response = await ssrfGuardedFetch(
      "https://public.test/",
      {},
      {
        fetcher: async () => new Response("untrusted error body", { status: 404 }),
        lookupAll: lookupFor({
          "public.test": [{ address: "93.184.216.34", family: 4 }],
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.bodyUsed).toBe(true);
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
