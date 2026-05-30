import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import { SuppressionEntry, SuppressionKind, SuppressionScope } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EvidenceLedgerService } from "../observability/evidence-ledger.service";

function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

function extractDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

type SuppressionAddInput = {
  readonly orgId: string | null;
  readonly scope: SuppressionScope;
  readonly kind: SuppressionKind;
  readonly subjectEmail?: string;
  readonly subjectDomain?: string;
  readonly subjectThreadId?: string;
  readonly senderMailboxId?: string;
  readonly expiresAt?: Date | null;
  readonly source: string;
  readonly reason?: string;
  /** Ops-only escape hatch for GLOBAL rows (must be true when scope=GLOBAL). */
  readonly internalCli?: boolean;
};

@Injectable()
export class SuppressionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly evidenceLedger?: EvidenceLedgerService,
  ) {}

  async add(input: SuppressionAddInput): Promise<SuppressionEntry> {
    const orgId = input.orgId;
    const scope = input.scope;

    if (scope === SuppressionScope.GLOBAL) {
      if (orgId !== null) {
        throw new BadRequestException("GLOBAL suppression requires orgId=null");
      }
      if (input.internalCli !== true) {
        throw new BadRequestException("GLOBAL suppression writes are ops-only");
      }
    } else {
      if (orgId === null) {
        throw new BadRequestException("orgId is required for non-GLOBAL suppression");
      }
    }

    const subjectEmail =
      typeof input.subjectEmail === "string" && input.subjectEmail.trim().length > 0
        ? normalizeEmail(input.subjectEmail)
        : undefined;
    const subjectDomain =
      typeof input.subjectDomain === "string" && input.subjectDomain.trim().length > 0
        ? input.subjectDomain.trim().toLowerCase()
        : undefined;
    const subjectThreadId =
      typeof input.subjectThreadId === "string" && input.subjectThreadId.trim().length > 0
        ? input.subjectThreadId.trim()
        : undefined;

    const setCount = [subjectEmail, subjectDomain, subjectThreadId].filter(Boolean).length;
    if (setCount !== 1) {
      throw new BadRequestException(
        "Exactly one of subjectEmail, subjectDomain, or subjectThreadId is required",
      );
    }

    if (scope === SuppressionScope.THREAD && !subjectThreadId) {
      throw new BadRequestException("THREAD suppression requires subjectThreadId");
    }
    if (scope === SuppressionScope.SENDER) {
      if (!input.senderMailboxId || input.senderMailboxId.trim().length === 0) {
        throw new BadRequestException("SENDER suppression requires senderMailboxId");
      }
      if (!subjectEmail && !subjectDomain) {
        throw new BadRequestException(
          "SENDER suppression requires subjectEmail or subjectDomain",
        );
      }
    }

    const source = input.source?.trim();
    if (!source) {
      throw new BadRequestException("source is required");
    }

    const data = {
      orgId,
      scope,
      kind: input.kind,
      subjectEmail: subjectEmail ?? null,
      subjectDomain: subjectDomain ?? null,
      subjectThreadId: subjectThreadId ?? null,
      senderMailboxId:
        typeof input.senderMailboxId === "string" && input.senderMailboxId.trim().length > 0
          ? input.senderMailboxId.trim()
          : null,
      expiresAt: input.expiresAt ?? null,
      source,
      reason:
        typeof input.reason === "string" && input.reason.trim().length > 0
          ? input.reason.trim()
          : null,
    } as const;

    let entry: SuppressionEntry;
    let created = false;
    try {
      entry = await this.prisma.suppressionEntry.create({ data });
      created = true;
    } catch (err) {
      // Partial unique indexes enforce dedupe per shape; Prisma surfaces those
      // as P2002 without a stable constraint name. Fall back to find-first.
      if (isPrismaUniqueViolation(err)) {
        const existing = await this.prisma.suppressionEntry.findFirst({
          where: {
            orgId: data.orgId,
            scope: data.scope,
            kind: data.kind,
            subjectEmail: data.subjectEmail ?? undefined,
            subjectDomain: data.subjectDomain ?? undefined,
            subjectThreadId: data.subjectThreadId ?? undefined,
            senderMailboxId: data.senderMailboxId ?? undefined,
          },
        });
        if (existing) {
          entry = existing;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    if (created && entry.orgId) {
      void this.evidenceLedger?.suppressionCreated({
        orgId: entry.orgId,
        suppressionEntryId: entry.id,
        scope: entry.scope,
        kind: entry.kind,
        source: entry.source,
      });
    }

    return entry;
  }

  async isSuppressed(input: {
    readonly orgId: string;
    readonly recipientEmail: string;
    readonly threadId?: string | null;
    readonly senderMailboxId?: string | null;
  }): Promise<{ suppressed: boolean; matchedEntries: SuppressionEntry[] }> {
    const recipientEmail = normalizeEmail(input.recipientEmail);
    const domain = extractDomain(recipientEmail);
    const now = new Date();

    const candidates = await this.prisma.suppressionEntry.findMany({
      where: {
        OR: [{ orgId: input.orgId }, { orgId: null }],
        AND: [
          {
            OR: [
              { expiresAt: null },
              { expiresAt: { gt: now } },
            ],
          },
          {
            OR: [
              { subjectEmail: recipientEmail },
              ...(domain ? [{ subjectDomain: domain }] : []),
              ...(input.threadId
                ? [{ subjectThreadId: input.threadId }]
                : []),
            ],
          },
        ],
      },
      orderBy: { createdAt: "desc" },
    });

    const matched: SuppressionEntry[] = [];

    for (const entry of candidates) {
      if (entry.expiresAt && entry.expiresAt.getTime() < now.getTime()) continue;

      switch (entry.scope) {
        case SuppressionScope.GLOBAL: {
          if (entry.orgId !== null) break;
          if (
            (entry.subjectEmail && normalizeEmail(entry.subjectEmail) === recipientEmail) ||
            (domain && entry.subjectDomain && entry.subjectDomain.toLowerCase() === domain)
          ) {
            matched.push(entry);
          }
          break;
        }
        case SuppressionScope.ORG: {
          if (entry.orgId !== input.orgId) break;
          if (
            (entry.subjectEmail && normalizeEmail(entry.subjectEmail) === recipientEmail) ||
            (domain && entry.subjectDomain && entry.subjectDomain.toLowerCase() === domain)
          ) {
            matched.push(entry);
          }
          break;
        }
        case SuppressionScope.SENDER: {
          if (entry.orgId !== input.orgId) break;
          if (!input.senderMailboxId) break;
          if (!entry.senderMailboxId) break;
          if (entry.senderMailboxId !== input.senderMailboxId) break;
          if (
            (entry.subjectEmail && normalizeEmail(entry.subjectEmail) === recipientEmail) ||
            (domain && entry.subjectDomain && entry.subjectDomain.toLowerCase() === domain)
          ) {
            matched.push(entry);
          }
          break;
        }
        case SuppressionScope.THREAD: {
          if (entry.orgId !== input.orgId) break;
          if (!input.threadId) break;
          if (!entry.subjectThreadId) break;
          if (entry.subjectThreadId !== input.threadId) break;
          matched.push(entry);
          break;
        }
        default:
          break;
      }
    }

    const scopeRank: Record<SuppressionScope, number> = {
      [SuppressionScope.THREAD]: 0,
      [SuppressionScope.SENDER]: 1,
      [SuppressionScope.ORG]: 2,
      [SuppressionScope.GLOBAL]: 3,
    };

    matched.sort((a, b) => scopeRank[a.scope] - scopeRank[b.scope]);
    return { suppressed: matched.length > 0, matchedEntries: matched };
  }
}

function isPrismaUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2002";
}
