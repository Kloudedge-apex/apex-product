import { Controller, Get, Logger, Param, Req, Res } from "@nestjs/common";
import { OutreachSuppressionReason } from "@prisma/client";
import type { Request, Response } from "express";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { SuppressionService } from "./suppression.service";
import { verifyUnsubscribeToken } from "./unsubscribe-token.util";

/**
 * Public RFC 8058 / CAN-SPAM one-click unsubscribe endpoint.
 *
 * Audit P0 #3. The List-Unsubscribe / List-Unsubscribe-Post headers stamped
 * on every outbound point at this controller. The token is HMAC-signed
 * (see unsubscribe-token.util.ts) so the request is unforgeable; verifying
 * + writing the suppression row + returning a 200 confirmation page is the
 * full responsibility of this handler.
 *
 * The endpoint MUST be unauthenticated (mail readers click the link without
 * a session) and MUST be exempt from the per-org guard. SkipOrgGuard covers
 * the latter; the global JwtAuthGuard is matched by-controller-path so
 * /u/* is not gated by it (configured in main.ts via the standard
 * @Public()-style decorator pattern used by the Razorpay webhook).
 */
@Controller("u")
@SkipOrgGuard()
export class UnsubscribeController {
  private readonly logger = new Logger(UnsubscribeController.name);

  constructor(private readonly suppression: SuppressionService) {}

  @Get(":token")
  async unsubscribe(
    @Param("token") token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const verified = verifyUnsubscribeToken(token);
    if (!verified) {
      this.logger.warn(`Rejected unsubscribe with invalid token from ${req.ip ?? "unknown"}`);
      res.status(400).send(this.html("This unsubscribe link is invalid or has been tampered with.", false));
      return;
    }

    try {
      await this.suppression.suppress({
        orgId: verified.orgId,
        recipientRef: verified.recipientRef,
        reason: OutreachSuppressionReason.USER_UNSUBSCRIBED,
        source: "unsubscribe_token",
        metadata: {
          user_agent: req.headers["user-agent"] ?? null,
          ip: req.ip ?? null,
          issued_at: verified.issuedAt.toISOString(),
        },
      });
    } catch (err) {
      this.logger.error(
        `Suppression write failed for org=${verified.orgId} recipient=${verified.recipientRef}: ${err instanceof Error ? err.message : "unknown"}`,
      );
      res.status(500).send(this.html("We hit an internal error recording your unsubscribe. Please email support so we can suppress your address manually.", false));
      return;
    }

    res.status(200).send(this.html(`You have been unsubscribed. We will not send you further marketing email.`, true));
  }

  /**
   * POST handler matching RFC 8058 List-Unsubscribe-Post=One-Click. Most
   * mail providers (Gmail bulk-sender, Apple Mail, Yahoo) POST to the same
   * URL with body `List-Unsubscribe=One-Click`; the handler is identical to
   * the GET path so we just delegate.
   */
  @Get(":token/post")
  async unsubscribePost(
    @Param("token") token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.unsubscribe(token, req, res);
  }

  private html(message: string, ok: boolean): string {
    const status = ok ? "Unsubscribed" : "Unsubscribe error";
    const color = ok ? "#0a7a23" : "#a8261b";
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${status} — Nikxius</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 540px; margin: 5rem auto; padding: 0 1.25rem; color: #222; }
    h1 { color: ${color}; margin-bottom: 0.5rem; font-size: 1.4rem; }
    p { line-height: 1.5; }
    .note { color: #555; font-size: 0.9rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>${status}</h1>
  <p>${message}</p>
  <p class="note">If you continue to receive email after this, reply with the word UNSUBSCRIBE and a human will action it.</p>
</body>
</html>`;
  }
}
