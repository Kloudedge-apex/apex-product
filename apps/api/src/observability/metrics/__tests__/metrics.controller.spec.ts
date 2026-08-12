import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsController } from "../metrics.controller";
import { MetricsService } from "../metrics.service";

describe("MetricsController", () => {
  const originalEnv = { ...process.env };
  const exposition = "# TYPE test_metric gauge\ntest_metric 1\n";
  let toPrometheus: ReturnType<typeof vi.fn>;
  let controller: MetricsController;

  beforeEach(() => {
    process.env = { ...originalEnv };
    toPrometheus = vi.fn(() => exposition);
    controller = new MetricsController({
      toPrometheus,
    } as unknown as MetricsService);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each([undefined, "", "   "])(
    "fails closed in production when METRICS_AUTH_TOKEN is %s",
    (token) => {
      process.env.NODE_ENV = "production";
      if (token === undefined) {
        delete process.env.METRICS_AUTH_TOKEN;
      } else {
        process.env.METRICS_AUTH_TOKEN = token;
      }

      expect(() => controller.scrape(undefined)).toThrow(
        ServiceUnavailableException,
      );
      expect(toPrometheus).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "Bearer wrong-token", "Basic metrics-token"])(
    "rejects missing or wrong production credentials (%s)",
    (authorization) => {
      process.env.NODE_ENV = "production";
      process.env.METRICS_AUTH_TOKEN = "metrics-token";

      expect(() => controller.scrape(authorization)).toThrow(
        UnauthorizedException,
      );
      expect(toPrometheus).not.toHaveBeenCalled();
    },
  );

  it("returns metrics for the correct production bearer token", () => {
    process.env.NODE_ENV = "production";
    process.env.METRICS_AUTH_TOKEN = "metrics-token";

    expect(controller.scrape("Bearer metrics-token")).toBe(exposition);
    expect(toPrometheus).toHaveBeenCalledOnce();
  });

  it("remains open outside production when no token is configured", () => {
    process.env.NODE_ENV = "development";
    delete process.env.METRICS_AUTH_TOKEN;

    expect(controller.scrape(undefined)).toBe(exposition);
    expect(toPrometheus).toHaveBeenCalledOnce();
  });
});
