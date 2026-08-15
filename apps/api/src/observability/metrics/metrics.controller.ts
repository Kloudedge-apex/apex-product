import {
  Controller,
  Get,
  Header,
  Headers,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { SkipOrgGuard } from "../../common/org-scope.guard";
import { MetricsService } from "./metrics.service";

/**
 * GET /metrics — Prometheus scrape endpoint. Audit P0 #15.
 *
 * Production requires METRICS_AUTH_TOKEN and fails closed if startup
 * validation is ever bypassed. Non-production remains unauthenticated when
 * the token is omitted for local scraping. Whenever a token is configured,
 * the request must carry an exact `Authorization: Bearer <token>` match.
 */
@Controller("metrics")
@SkipOrgGuard()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  scrape(@Headers("authorization") authorization: string | undefined): string {
    const expected = process.env.METRICS_AUTH_TOKEN;
    const hasConfiguredToken = Boolean(expected?.trim());

    if (process.env.NODE_ENV === "production" && !hasConfiguredToken) {
      throw new ServiceUnavailableException(
        "Metrics endpoint authentication is not configured",
      );
    }

    if (expected && hasConfiguredToken) {
      const provided = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (provided !== expected) {
        throw new UnauthorizedException("Invalid metrics auth token");
      }
    }
    return this.metrics.toPrometheus();
  }
}
