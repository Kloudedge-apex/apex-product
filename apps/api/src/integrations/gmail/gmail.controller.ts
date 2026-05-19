import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { GmailService } from "./gmail.service";
import { OrgId } from "../../common/org-context.decorator";

class SendEmailDto {
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
 * OAuth init (`auth`) and callback (`callback`) for Gmail live in
 * `IntegrationsController` so the signed-state flow is shared across
 * providers. This controller only exposes Gmail operations.
 */
@Controller("integrations/gmail")
export class GmailController {
  constructor(private readonly gmailService: GmailService) {}

  @Post("send")
  @HttpCode(HttpStatus.OK)
  sendEmail(@OrgId() orgId: string, @Body() body: SendEmailDto) {
    return this.gmailService.sendEmail(orgId, body);
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
