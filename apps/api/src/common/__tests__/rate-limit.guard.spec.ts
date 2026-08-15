import { describe, expect, it, vi } from "vitest";
import { HttpException, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { RateLimitGuard } from "../rate-limit.guard";
import { isTrustedProxyAddress } from "../trusted-proxy.util";

function contextFor(input: {
  ip?: string;
  orgId?: string;
  forwardedFor?: string;
}): ExecutionContext {
  const req = {
    ip: input.ip,
    orgId: input.orgId,
    headers: input.forwardedFor
      ? { "x-forwarded-for": input.forwardedFor }
      : {},
    socket: { remoteAddress: input.ip },
  } as unknown as Request & { orgId?: string };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("RateLimitGuard", () => {
  it("does not create a shared BFF bucket without an authoritative org", () => {
    const guard = new RateLimitGuard();
    for (let i = 0; i < 1_000; i++) {
      expect(
        guard.canActivate(
          contextFor({
            ip: "203.0.113.10",
            forwardedFor: `198.51.100.${i % 255}`,
          }),
        ),
      ).toBe(true);
    }
    const retained = (guard as unknown as { store: Map<string, unknown> }).store;
    expect(retained.size).toBe(0);
  });

  it("limits authenticated requests by authoritative organization", () => {
    const guard = new RateLimitGuard();
    for (let i = 0; i < 200; i++) {
      expect(
        guard.canActivate(
          contextFor({
            ip: `203.0.113.${i % 255}`,
            orgId: "org-1",
            forwardedFor: `198.51.100.${i % 255}`,
          }),
        ),
      ).toBe(true);
    }
    expect(() =>
      guard.canActivate(contextFor({ ip: "1.1.1.1", orgId: "org-1" })),
    ).toThrow(HttpException);
  });

  it("bounds active rate-limit identities and fails closed at capacity", () => {
    const guard = new RateLimitGuard();
    for (let i = 0; i < 10_000; i++) {
      expect(
        guard.canActivate(
          contextFor({ ip: "203.0.113.10", orgId: `org-${i}` }),
        ),
      ).toBe(true);
    }
    expect(() =>
      guard.canActivate(contextFor({ ip: "203.0.113.10", orgId: "org-overflow" })),
    ).toThrow(HttpException);
    const retained = (guard as unknown as { store: Map<string, unknown> }).store;
    expect(retained.size).toBe(10_000);
  });

  it("does not rescan the full store on every request while at capacity", () => {
    class CountingMap<K, V> extends Map<K, V> {
      iterations = 0;

      override [Symbol.iterator](): MapIterator<[K, V]> {
        this.iterations++;
        return super[Symbol.iterator]();
      }
    }

    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const store = new CountingMap<string, { count: number; resetAt: number }>();
    for (let i = 0; i < 10_000; i++) {
      store.set(`org:org-${i}`, { count: 1, resetAt: 60_000 });
    }
    const guard = new RateLimitGuard() as unknown as {
      canActivate: (context: ExecutionContext) => boolean;
      store: Map<string, { count: number; resetAt: number }>;
      nextSweepAt: number;
    };
    guard.store = store;
    guard.nextSweepAt = 60_000;

    expect(() =>
      guard.canActivate(contextFor({ ip: "203.0.113.250", orgId: "org-overflow" })),
    ).toThrow(HttpException);
    expect(store.iterations).toBe(0);
    now.mockRestore();
  });

  it("sweeps expired identities before admitting a new window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const guard = new RateLimitGuard();
    expect(
      guard.canActivate(contextFor({ ip: "203.0.113.1", orgId: "org-1" })),
    ).toBe(true);

    now.mockReturnValue(61_001);
    expect(
      guard.canActivate(contextFor({ ip: "203.0.113.2", orgId: "org-2" })),
    ).toBe(true);
    const retained = (guard as unknown as { store: Map<string, unknown> }).store;
    expect([...retained.keys()]).toEqual(["org:org-2"]);
    now.mockRestore();
  });
});

describe("isTrustedProxyAddress", () => {
  it.each(["127.0.0.1", "10.0.0.4", "192.168.1.5", "::1", "fd00::1"])(
    "trusts an internal ingress peer %s",
    (address) => expect(isTrustedProxyAddress(address)).toBe(true),
  );

  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860::a00:1",
  ])(
    "does not trust a public peer %s",
    (address) => expect(isTrustedProxyAddress(address)).toBe(false),
  );
});
