import { Controller, Get, Post, Body, Req, Headers, UnauthorizedException, BadRequestException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { Request } from "express";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  @Get("me")
  @SkipOrgGuard()
  getMe(@Req() req: Request) {
    // clerkUserId is set by OrgScopeGuard after JWT verification
    const clerkUserId = (req as unknown as Record<string, unknown>).clerkUserId as string | undefined;
    if (!clerkUserId) {
      throw new UnauthorizedException("Not authenticated");
    }
    return this.authService.getUserByClerkId(clerkUserId);
  }

  @Post("webhook")
  @SkipOrgGuard()
  handleWebhook(
    @Req() req: Request,
    @Headers("svix-id") svixId: string,
    @Headers("svix-timestamp") svixTimestamp: string,
    @Headers("svix-signature") svixSignature: string,
    @Body() body: unknown,
  ) {
    // Verify svix webhook signature from Clerk
    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      // TODO: Install svix package and use Webhook class for proper verification:
      //   import { Webhook } from "svix";
      //   const wh = new Webhook(webhookSecret);
      //   wh.verify(JSON.stringify(body), { "svix-id": svixId, "svix-timestamp": svixTimestamp, "svix-signature": svixSignature });
      throw new BadRequestException("Webhook verification not configured (CLERK_WEBHOOK_SECRET missing)");
    }

    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new BadRequestException("Missing svix signature headers");
    }

    // TODO: Replace with proper svix verification once the svix package is added:
    //   import { Webhook } from "svix";
    //   const wh = new Webhook(webhookSecret);
    //   const verified = wh.verify(JSON.stringify(body), {
    //     "svix-id": svixId,
    //     "svix-timestamp": svixTimestamp,
    //     "svix-signature": svixSignature,
    //   });
    // For now, verify timestamp is recent (within 5 minutes) as a basic check
    const ts = parseInt(svixTimestamp);
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(ts) || Math.abs(now - ts) > 300) {
      throw new BadRequestException("Webhook timestamp too old or invalid");
    }

    return this.authService.handleWebhook(body);
  }
}
