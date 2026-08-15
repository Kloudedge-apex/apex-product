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
import { Webhook } from "svix";
import { AuthService } from "./auth.service";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { verifyClerkToken } from "../common/jwt.util";
import { isWorkerEnabled } from "../runtime/worker.service";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// Defense-in-depth: even when svix.Webhook accepts the signature, we still
// reject payloads whose svix-timestamp is more than this many seconds away
// from wall clock. svix's own tolerance is 5 minutes; we mirror it explicitly
// so a config change upstream can't silently widen the replay window.
const SVIX_TIMESTAMP_TOLERANCE_SEC = 5 * 60;

/**
 * Resolves the Clerk webhook secret. In production we fail fast at module
 * load IF this process is going to serve HTTP (i.e. it's the api container,
 * not the worker). The worker loads AuthController via AppModule but never
 * routes /auth/webhook traffic, so demanding the secret there would crash
 * the worker for no security benefit. The runtime check inside handleWebhook
 * is the actual gate that prevents forgery on the api.
 */
function resolveWebhookSecret(
  config: ConfigService,
  logger: Logger,
): string | undefined {
  const secret = config.get<string>("CLERK_WEBHOOK_SECRET");
  const isProd = process.env.NODE_ENV === "production";
  if (!secret) {
    if (isProd && !isWorkerEnabled()) {
      throw new Error(
        "CLERK_WEBHOOK_SECRET is required in production. " +
          "Without it the /auth/webhook endpoint is forge-able.",
      );
    }
    logger.warn(
      "CLERK_WEBHOOK_SECRET is unset; /auth/webhook will reject all requests at runtime.",
    );
    return undefined;
  }
  return secret;
}

@Controller("auth")
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly webhookSecret: string | undefined;

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {
    this.webhookSecret = resolveWebhookSecret(this.config, this.logger);
  }

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
    let payload: Awaited<ReturnType<typeof verifyClerkToken>>;
    try {
      payload = await verifyClerkToken(authHeader.slice(7).trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid token";
      throw new UnauthorizedException(msg);
    }
    return this.authService.getUserByClerkId(payload.sub, {
      clerkOrgId: payload.org_id,
      clerkOrgRole: payload.org_role,
    });
  }

  /**
   * Clerk webhook endpoint. Verifies the Svix signature before processing —
   * an unsigned payload could let any attacker grant themselves ADMIN of any
   * org. We use svix's official `Webhook.verify` (HMAC-SHA256 with the bytes
   * of the `whsec_*` secret) and additionally enforce a 5-minute timestamp
   * window as defense-in-depth.
   */
  @Post("webhook")
  @SkipOrgGuard()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(@Req() req: RawBodyRequest) {
    if (!this.webhookSecret) {
      this.logger.error("CLERK_WEBHOOK_SECRET is not configured; rejecting webhook");
      throw new UnauthorizedException("Webhook secret not configured");
    }
    if (!req.rawBody) {
      throw new UnauthorizedException("Raw body unavailable; cannot verify signature");
    }

    const svixId = headerValue(req.headers, "svix-id");
    const svixTimestamp = headerValue(req.headers, "svix-timestamp");
    const svixSignature = headerValue(req.headers, "svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new UnauthorizedException("Missing svix signature headers");
    }

    // Defense-in-depth recency check: enforced BEFORE svix.verify so a stolen
    // signed payload can't be replayed weeks later.
    const ts = Number(svixTimestamp);
    if (!Number.isSafeInteger(ts) || ts <= 0) {
      throw new UnauthorizedException("Invalid svix-timestamp");
    }
    const ageSec = Math.abs(Date.now() / 1000 - ts);
    if (ageSec > SVIX_TIMESTAMP_TOLERANCE_SEC) {
      throw new UnauthorizedException("Webhook timestamp outside tolerance window");
    }

    try {
      const wh = new Webhook(this.webhookSecret);
      wh.verify(req.rawBody, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      });
    } catch (err) {
      this.logger.warn(
        `Clerk webhook signature verification failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      throw new UnauthorizedException("Invalid webhook signature");
    }

    const body = JSON.parse(req.rawBody.toString("utf8")) as unknown;
    return this.authService.handleWebhook(body, {
      id: svixId,
      timestampSeconds: ts,
    });
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}
