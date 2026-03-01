import { Controller, Get } from "@nestjs/common";
import { SkipOrgGuard } from "../common/org-scope.guard";

@Controller("health")
@SkipOrgGuard()
export class HealthController {
  @Get()
  check() {
    return {
      status: "ok",
      service: "apex-api",
      timestamp: new Date().toISOString(),
    };
  }
}
