import { Controller, Get, Header, Headers, UnauthorizedException } from "@nestjs/common";
import { SkipOrgGuard } from "../../common/org-scope.guard";
import { MetricsService } from "./metrics.service";

/**
 * GET /metrics — Prometheus scrape endpoint. Audit P0 #15.
 *
 * Unauthenticated by default for the typical in-cluster scraper pattern.
 * Optionally guarded by METRICS_AUTH_TOKEN env: when set, the request
 * must carry an `Authorization: Bearer <token>` matching it. Use this in
 * environments where the /metrics endpoint is exposed publicly (e.g. via
 * the same ingress as the API).
 */
@Controller("metrics")
@SkipOrgGuard()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  scrape(@Headers("authorization") authorization: string | undefined): string {
    const expected = process.env.METRICS_AUTH_TOKEN;
    if (expected) {
      const provided = authorization?.replace(/^Bearer\s+/i, "");
      if (provided !== expected) {
        throw new UnauthorizedException("Invalid metrics auth token");
      }
    }
    return this.metrics.toPrometheus();
  }
}
