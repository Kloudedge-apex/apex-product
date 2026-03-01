import { Controller, Get, Post, Body, Req, UnauthorizedException } from "@nestjs/common";
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
  handleWebhook(@Body() body: unknown) {
    return this.authService.handleWebhook(body);
  }
}
