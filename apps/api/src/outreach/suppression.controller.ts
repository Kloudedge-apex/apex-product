import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";
import { OrgId } from "../common/org-context.decorator";
import { SuppressionService } from "./suppression.service";

/**
 * Admin surface for the outreach suppression list. Org-scoped — the
 * @OrgId() decorator pulls the caller's orgId off the request (set by
 * OrgScopeGuard) so every row read/deleted is implicitly scoped.
 *
 * The public unsubscribe path (POST /u/:token in unsubscribe.controller.ts)
 * is the only WRITE entry point. This controller offers READ + ADMIN
 * UNSUPPRESS (operator deletes a row after a manual recheck).
 *
 * Audit P0 #3 follow-up.
 */
@Controller("outreach/suppression")
export class SuppressionController {
  constructor(private readonly suppression: SuppressionService) {}

  @Get()
  async list(
    @OrgId() orgId: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<{ rows: Array<unknown>; nextCursor: string | null }> {
    const parsedLimit = limit ? Math.max(1, Math.min(200, Number.parseInt(limit, 10))) : 50;
    const { rows, nextCursor } = await this.suppression.listForOrg(orgId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
      cursor: typeof cursor === "string" && cursor.length > 0 ? cursor : undefined,
    });
    return { rows, nextCursor };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsuppress(
    @OrgId() orgId: string,
    @Param("id") id: string,
  ): Promise<void> {
    const ok = await this.suppression.unsuppress(orgId, id);
    if (!ok) {
      throw new NotFoundException(`Suppression ${id} not found`);
    }
  }
}
