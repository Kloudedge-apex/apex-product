import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
  UnauthorizedException,
} from "@nestjs/common";
import { GmailService } from "./gmail.service";
import { OrgId } from "../../common/org-context.decorator";
import { SkipOrgGuard } from "../../common/org-scope.guard";
import { AdminOrManagerGuard } from "../../common/admin-or-manager.guard";

class SendEmailDto {
  outreachArtifactId!: string;
  to!: string;
  subject!: string;
  body!: string;
  html?: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyTo?: string;
  threadId?: string;
}

/**
 * Google Pub/Sub push delivery envelope. See
 * https://cloud.google.com/pubsub/docs/push#receive_push for the shape.
 */
interface PubSubPushBody {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

/**
 * OAuth init (`auth`) and callback (`callback`) for Gmail live in
 * `IntegrationsController` so the signed-state flow is shared across
 * providers. This controller only exposes Gmail operations.
 */
@Controller("integrations/gmail")
export class GmailController {
  private readonly logger = new Logger(GmailController.name);

  constructor(private readonly gmailService: GmailService) {}

  /**
   * Gmail Pub/Sub push endpoint.
   *
   * Google Cloud Pub/Sub posts new-message notifications here. We verify the
   * OIDC JWT signed by the configured publisher service account (audience must
   * match this URL), decode the base64 `message.data` payload, and dispatch
   * the Reply Handler agent for any new inbound replies.
   *
   * Always returns 200 on a successful dispatch hand-off so Pub/Sub stops
   * retrying. Internal failures are logged but never surfaced as 5xx — we
   * rely on the History API watermark for replay safety.
   */
  @Post("push")
  @SkipOrgGuard()
  @HttpCode(HttpStatus.OK)
  async handlePush(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: PubSubPushBody,
  ): Promise<{ ok: true }> {
    if (!(await this.gmailService.verifyPushAuth(authorization))) {
      throw new UnauthorizedException("Invalid Gmail push verification token");
    }

    const encoded = body?.message?.data;
    if (!encoded) {
      this.logger.warn("gmail.push received empty payload");
      return { ok: true };
    }

    let payload: { emailAddress?: string; historyId?: string | number };
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      payload = JSON.parse(decoded) as typeof payload;
    } catch (err) {
      this.logger.warn("gmail.push could not decode message.data", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: true };
    }

    const emailAddress = payload.emailAddress;
    const historyId =
      payload.historyId !== undefined ? String(payload.historyId) : undefined;
    if (!emailAddress || !historyId) {
      this.logger.warn("gmail.push payload missing emailAddress/historyId");
      return { ok: true };
    }

    try {
      await this.gmailService.handlePushNotification({ emailAddress, historyId });
    } catch (err) {
      // Swallow — see method docstring. Logging captures the failure.
      this.logger.error("gmail.push dispatch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { ok: true };
  }

  @Post("send")
  @UseGuards(AdminOrManagerGuard)
  @HttpCode(HttpStatus.OK)
  sendEmail(@OrgId() orgId: string, @Body() body: SendEmailDto) {
    return this.gmailService.sendApprovedOutreachEmail(orgId, body);
  }

  /**
   * (Re-)register the org's mailbox with Gmail's `users.watch` so inbound
   * messages push to /integrations/gmail/push. Idempotent. Useful for
   * backfilling mailboxes connected before the push wiring existed, or for
   * renewing watches before the 7-day expiration.
   */
  @Post("watch")
  @HttpCode(HttpStatus.OK)
  async registerWatch(@OrgId() orgId: string) {
    const result = await this.gmailService.registerWatch(orgId);
    return { ok: true, ...result };
  }

  @Get("messages")
  listMessages(
    @OrgId() orgId: string,
    @Query("maxResults") maxResults?: string,
    @Query("labelIds") labelIds?: string,
    @Query("pageToken") pageToken?: string,
  ) {
    return this.gmailService.listMessages(orgId, {
      maxResults: maxResults ? parseInt(maxResults, 10) : undefined,
      labelIds: labelIds ? labelIds.split(",") : undefined,
      pageToken,
    });
  }

  @Get("search")
  searchMessages(
    @OrgId() orgId: string,
    @Query("q") query: string,
    @Query("maxResults") maxResults?: string,
  ) {
    return this.gmailService.searchMessages(
      orgId,
      query,
      maxResults ? parseInt(maxResults, 10) : undefined,
    );
  }

  @Get("messages/:messageId")
  getMessage(@OrgId() orgId: string, @Param("messageId") messageId: string) {
    return this.gmailService.getMessage(orgId, messageId);
  }

  @Get("threads/:threadId")
  getThread(@OrgId() orgId: string, @Param("threadId") threadId: string) {
    return this.gmailService.getThread(orgId, threadId);
  }
}
