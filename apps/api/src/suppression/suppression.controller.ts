import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  NotFoundException,
} from "@nestjs/common";
import { SuppressionKind, SuppressionScope } from "@prisma/client";
import { OrgId } from "../common/org-context.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";
import { SuppressionService } from "./suppression.service";

interface CreateSuppressionBody {
  scope: SuppressionScope;
  kind: SuppressionKind;
  subjectEmail?: string;
  subjectDomain?: string;
  subjectThreadId?: string;
  senderMailboxId?: string;
  expiresAt?: string;
  reason?: string;
}

@Controller()
export class SuppressionController {
  constructor(
    private readonly suppression: SuppressionService,
    private readonly prisma: PrismaService,
    private readonly evidenceLedger: EvidenceLedgerService,
  ) {}

  @Post("suppressions")
  async create(
    @OrgId() orgId: string,
    @Body() body: CreateSuppressionBody,
  ) {
    if (!orgId) {
      // Defensive: OrgScopeGuard should always populate this.
      throw new BadRequestException("orgId required");
    }

    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt.trim().length > 0
        ? new Date(body.expiresAt)
        : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException("expiresAt must be an ISO date string");
    }

    return this.suppression.add({
      orgId,
      scope: body.scope,
      kind: body.kind,
      subjectEmail: body.subjectEmail,
      subjectDomain: body.subjectDomain,
      subjectThreadId: body.subjectThreadId,
      senderMailboxId: body.senderMailboxId,
      expiresAt: expiresAt ?? undefined,
      source: "manual",
      reason: body.reason,
    });
  }

  @Get("suppressions")
  async list(
    @OrgId() orgId: string,
    @Query("scope") scope?: string,
    @Query("kind") kind?: string,
  ) {
    const where: Record<string, unknown> = { orgId };

    if (scope) {
      const parsed = parseEnum(scope, SuppressionScope, "scope");
      // Do not expose GLOBAL by default.
      if (parsed === SuppressionScope.GLOBAL) {
        throw new BadRequestException("GLOBAL suppressions are not listable via this endpoint");
      }
      where.scope = parsed;
    }
    if (kind) {
      where.kind = parseEnum(kind, SuppressionKind, "kind");
    }

    return this.prisma.suppressionEntry.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  @Delete("suppressions/:id")
  async revoke(
    @OrgId() orgId: string,
    @Param("id") id: string,
  ) {
    const row = await this.prisma.suppressionEntry.findFirst({
      where: { id, orgId },
    });
    if (!row) {
      throw new NotFoundException("SuppressionEntry not found");
    }

    const updated = await this.prisma.suppressionEntry.update({
      where: { id },
      data: { expiresAt: new Date() },
    });

    await this.evidenceLedger.suppressionRevoked({
      orgId,
      suppressionEntryId: updated.id,
      scope: updated.scope,
      kind: updated.kind,
    });

    return updated;
  }
}

function parseEnum<T extends Record<string, string>>(
  raw: string,
  enumObj: T,
  label: string,
): T[keyof T] {
  const normalized = raw.toUpperCase();
  const allowed = Object.values(enumObj) as string[];
  if (!allowed.includes(normalized)) {
    throw new BadRequestException(
      `Invalid ${label} "${raw}". Allowed: ${allowed.join(",")}`,
    );
  }
  return normalized as T[keyof T];
}

