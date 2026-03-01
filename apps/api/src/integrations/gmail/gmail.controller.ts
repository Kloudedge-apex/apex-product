import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Param,
  Res,
  HttpStatus,
  HttpCode,
} from "@nestjs/common";
import { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { GmailService } from "./gmail.service";

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

@Controller("integrations/gmail")
export class GmailController {
  constructor(
    private readonly gmailService: GmailService,
    private readonly config: ConfigService,
  ) {}

  @Get("auth")
  auth(@Query("orgId") orgId: string, @Res() res: Response) {
    if (!orgId) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: "orgId is required" });
    }
    const url = this.gmailService.getAuthUrl(orgId);
    return res.redirect(HttpStatus.FOUND, url);
  }

  @Get("callback")
  async callback(
    @Query("code") code: string,
    @Query("state") orgId: string,
    @Res() res: Response,
  ) {
    const frontendUrl = this.config.get<string>("FRONTEND_URL", "http://localhost:3000");
    try {
      await this.gmailService.handleCallback(code, orgId);
      return res.redirect(`${frontendUrl}/integrations?connected=gmail`);
    } catch {
      return res.redirect(`${frontendUrl}/integrations?error=gmail`);
    }
  }

  @Post("send")
  @HttpCode(HttpStatus.OK)
  async sendEmail(
    @Query("orgId") orgId: string,
    @Body() body: SendEmailDto,
  ) {
    return this.gmailService.sendEmail(orgId, body);
  }

  @Get("messages")
  async listMessages(
    @Query("orgId") orgId: string,
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

  @Get("messages/:messageId")
  async getMessage(
    @Query("orgId") orgId: string,
    @Param("messageId") messageId: string,
  ) {
    return this.gmailService.getMessage(orgId, messageId);
  }

  @Get("threads/:threadId")
  async getThread(
    @Query("orgId") orgId: string,
    @Param("threadId") threadId: string,
  ) {
    return this.gmailService.getThread(orgId, threadId);
  }

  @Get("search")
  async searchMessages(
    @Query("orgId") orgId: string,
    @Query("q") query: string,
    @Query("maxResults") maxResults?: string,
  ) {
    return this.gmailService.searchMessages(
      orgId,
      query,
      maxResults ? parseInt(maxResults, 10) : undefined,
    );
  }
}
