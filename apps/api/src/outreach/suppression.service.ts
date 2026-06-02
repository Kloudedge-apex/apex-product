import { Injectable, Logger } from "@nestjs/common";
import { OutreachSuppressionReason } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Suppression list for outbound (CAN-SPAM / GDPR e-Privacy compliance).
 *
 * Audit P0 #3. Two paths:
 *   • `isSuppressed(orgId, recipientRef)` — consulted by the send worker
 *     immediately before any real provider call. Fail-closed on a query
 *     error: treat unknown state as suppressed so a Postgres outage cannot
 *     accidentally let a previously-unsubscribed recipient get re-mailed.
 *   • `suppress(...)` — upserts a row, idempotent on (orgId, recipientRef).
 *     Called by the public /u/:token endpoint when a recipient clicks
 *     unsubscribe, by provider bounce/complaint webhooks, and by operator
 *     tooling.
 */
export interface SuppressionRow {
  readonly id: string;
  readonly recipientRef: string;
  readonly reason: OutreachSuppressionReason;
  readonly source: string | null;
  readonly createdAt: Date;
}

@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Page through suppression rows for an org, newest first. */
  async listForOrg(
    orgId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ rows: SuppressionRow[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.outreachSuppression.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        recipientRef: true,
        reason: true,
        source: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    return {
      rows: slice,
      nextCursor: hasMore ? slice[slice.length - 1].id : null,
    };
  }

  /**
   * Admin unsuppress — removes the row so future sends to this recipient
   * may proceed. Operator-only path; the public /u/:token endpoint never
   * deletes. Returns false when the row does not exist OR belongs to a
   * different org (no enumeration leak).
   */
  async unsuppress(orgId: string, suppressionId: string): Promise<boolean> {
    const row = await this.prisma.outreachSuppression.findUnique({
      where: { id: suppressionId },
      select: { id: true, orgId: true, recipientRef: true },
    });
    if (!row || row.orgId !== orgId) return false;
    await this.prisma.outreachSuppression.delete({ where: { id: suppressionId } });
    this.logger.log(
      `Unsuppressed org=${orgId} recipient=${row.recipientRef} (id=${suppressionId})`,
    );
    return true;
  }

  async isSuppressed(orgId: string, recipientRef: string): Promise<boolean> {
    if (!recipientRef) return false;
    const key = recipientRef.toLowerCase().trim();
    if (!key) return false;
    try {
      const hit = await this.prisma.outreachSuppression.findUnique({
        where: { orgId_recipientRef: { orgId, recipientRef: key } },
        select: { id: true },
      });
      return hit !== null;
    } catch (err) {
      this.logger.error(
        `Suppression query failed for org=${orgId} recipient=${key}: ${err instanceof Error ? err.message : "unknown"} — failing closed (treat as suppressed)`,
      );
      // Fail-closed: do NOT permit an outbound when we cannot verify the
      // recipient is unsuppressed. Compliance > deliverability.
      return true;
    }
  }

  async suppress(input: {
    readonly orgId: string;
    readonly recipientRef: string;
    readonly reason: OutreachSuppressionReason;
    readonly source: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ created: boolean }> {
    const key = input.recipientRef.toLowerCase().trim();
    if (!key) {
      return { created: false };
    }
    try {
      const existing = await this.prisma.outreachSuppression.findUnique({
        where: { orgId_recipientRef: { orgId: input.orgId, recipientRef: key } },
        select: { id: true },
      });
      if (existing) {
        // Idempotent: do not overwrite metadata/reason on a re-click — the
        // first suppression source is the canonical one.
        return { created: false };
      }
      await this.prisma.outreachSuppression.create({
        data: {
          orgId: input.orgId,
          recipientRef: key,
          reason: input.reason,
          source: input.source,
          metadata: input.metadata as never,
        },
      });
      this.logger.log(
        `Suppressed org=${input.orgId} recipient=${key} reason=${input.reason} source=${input.source}`,
      );
      return { created: true };
    } catch (err) {
      this.logger.error(
        `Failed to upsert suppression for org=${input.orgId} recipient=${key}: ${err instanceof Error ? err.message : "unknown"}`,
      );
      throw err;
    }
  }
}
