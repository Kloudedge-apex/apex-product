import {
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request } from "express";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { verifyClerkWebhookSignature } from "../common/webhook-signature.util";
import { verifyClerkToken } from "../common/jwt.util";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the current Clerk user. We re-verify the JWT here because this
   * endpoint is `@SkipOrgGuard()` so the global guard didn't run.
   */
  @Get("me")
  @SkipOrgGuard()
  async getMe(@Req() req: Request) {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing Authorization header");
    }
    try {
      const payload = await verifyClerkToken(authHeader.slice(7).trim());
      return this.authService.getUserByClerkId(payload.sub);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid token";
      throw new UnauthorizedException(msg);
    }
  }

  /**
   * Clerk webhook endpoint. Verifies the Svix-style signature before
   * processing — an unsigned payload could let any attacker grant themselves
   * ADMIN of any org.
   */
  @Post("webhook")
  @SkipOrgGuard()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: RawBodyRequest) {
    const secret = this.config.get<string>("CLERK_WEBHOOK_SECRET");
    if (!secret) {
      this.logger.error("CLERK_WEBHOOK_SECRET is not configured; rejecting webhook");
      throw new UnauthorizedException("Webhook secret not configured");
    }
    if (!req.rawBody) {
      throw new UnauthorizedException("Raw body unavailable; cannot verify signature");
    }

    try {
      verifyClerkWebhookSignature(req.rawBody, req.headers, secret);
    } catch (err) {
      this.logger.warn(
        `Clerk webhook signature verification failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      throw new UnauthorizedException("Invalid webhook signature");
    }

    const body = JSON.parse(req.rawBody.toString("utf8")) as unknown;
    return this.authService.handleWebhook(body);
  }
}
