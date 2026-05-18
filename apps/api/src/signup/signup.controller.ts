import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
} from "@nestjs/common";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { SignupService } from "./signup.service";

@Controller("signup")
export class SignupController {
  constructor(private signupService: SignupService) {}

  @Post()
  @SkipOrgGuard()
  async signup(
    @Body()
    body: {
      email: string;
      password: string;
      companyName: string;
      companyDomain: string;
    },
  ) {
    return this.signupService.signup(body);
  }

  @Post("login")
  @SkipOrgGuard()
  async login(@Body() body: { email: string; password: string }) {
    return this.signupService.login(body);
  }

  @Post("onboarding/complete")
  @SkipOrgGuard()
  async completeOnboarding(
    @Headers("x-api-key") apiKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!apiKey) throw new UnauthorizedException("Missing X-API-Key header");
    return this.signupService.completeOnboarding(apiKey, body as any);
  }
}
