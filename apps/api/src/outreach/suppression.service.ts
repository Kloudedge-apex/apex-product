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
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

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
