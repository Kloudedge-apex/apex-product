import { Controller, Get, Post, Body } from "@nestjs/common";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get("me")
  getMe() {
    // TODO: Implement with Clerk JWT verification
    return { message: "Auth endpoint stub" };
  }

  @Post("webhook")
  handleWebhook(@Body() body: unknown) {
    // TODO: Handle Clerk webhook events (user.created, org.created, etc.)
    return this.authService.handleWebhook(body);
  }
}
