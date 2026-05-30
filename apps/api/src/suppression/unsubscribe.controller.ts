import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { SkipOrgGuard } from "../common/org-scope.guard";
import { SuppressionScope, SuppressionKind } from "@prisma/client";
import { SuppressionService } from "./suppression.service";
import { verifyToken } from "./unsubscribe-token.util";

@Controller()
export class UnsubscribeController {
  constructor(private readonly suppression: SuppressionService) {}

  @SkipOrgGuard()
  @Get("unsubscribe/:token")
  @Header("Content-Type", "text/html; charset=utf-8")
  getLanding(@Param("token") token: string) {
    const ok = !!verifyToken(token);
    return ok
      ? "<!doctype html><html><body><h1>You're unsubscribed.</h1></body></html>"
      : "<!doctype html><html><body><h1>Invalid unsubscribe link.</h1></body></html>";
  }

  @SkipOrgGuard()
  @Post("unsubscribe/:token")
  async oneClick(
    @Param("token") token: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: Record<string, unknown>,
  ) {
    const raw =
      Buffer.isBuffer(req.rawBody)
        ? req.rawBody.toString("utf8")
        : typeof (req as unknown as Record<string, unknown>).rawBody === "string"
          ? String((req as unknown as Record<string, unknown>).rawBody)
          : null;
    const rawOk = raw ? raw.includes("List-Unsubscribe=One-Click") : false;

    const parsed =
      typeof body?.["List-Unsubscribe"] === "string"
        ? (body["List-Unsubscribe"] as string)
        : typeof body?.["list-unsubscribe"] === "string"
          ? (body["list-unsubscribe"] as string)
          : undefined;
    const parsedOk = parsed === "One-Click";

    if (!rawOk && !parsedOk) {
      throw new BadRequestException('Body must contain "List-Unsubscribe=One-Click"');
    }

    const claims = verifyToken(token);
    if (!claims) {
      throw new BadRequestException("Invalid unsubscribe token");
    }

    await this.suppression.add({
      orgId: claims.orgId,
      scope: SuppressionScope.ORG,
      kind: SuppressionKind.UNSUBSCRIBE,
      subjectEmail: claims.recipientEmail,
      source: "one-click",
      reason: "one-click-unsubscribe",
    });

    return { ok: true };
  }
}
