import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class IdentityResolver {
  private readonly logger = new Logger(IdentityResolver.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve duplicate Person records within an org's companies.
   * Returns count of merged records.
   */
  async resolveAll(orgId: string): Promise<number> {
    const people = await this.prisma.person.findMany({
      where: { company: { orgId } },
      include: {
        company: { select: { domain: true } },
        emails: true,
      },
      orderBy: { createdAt: "asc" },
    });

    let mergeCount = 0;
    const merged = new Set<string>();

    for (let i = 0; i < people.length; i++) {
      const a = people[i]!;
      if (merged.has(a.id)) continue;

      for (let j = i + 1; j < people.length; j++) {
        const b = people[j]!;
        if (merged.has(b.id)) continue;

        if (this.shouldMerge(a, b)) {
          await this.mergePeople(a.id, b.id);
          merged.add(b.id);
          mergeCount++;
        }
      }
    }

    this.logger.log(`Identity resolution merged ${mergeCount} duplicate records for org ${orgId}`);
    return mergeCount;
  }

  private shouldMerge(
    a: { linkedinSlug: string | null; firstName: string; lastName: string; company: { domain: string }; emails: Array<{ email: string; verified: boolean }> },
    b: { linkedinSlug: string | null; firstName: string; lastName: string; company: { domain: string }; emails: Array<{ email: string; verified: boolean }> },
  ): boolean {
    // Strong key: matching LinkedIn slug
    if (a.linkedinSlug && b.linkedinSlug && a.linkedinSlug === b.linkedinSlug) {
      return true;
    }

    // Strong key: matching verified email
    const aEmails = new Set(a.emails.filter((e) => e.verified).map((e) => e.email.toLowerCase()));
    if (b.emails.some((e) => e.verified && aEmails.has(e.email.toLowerCase()))) {
      return true;
    }

    // Domain-bounded name match
    if (a.company.domain === b.company.domain) {
      const similarity = this.jaroWinkler(
        `${a.firstName} ${a.lastName}`.toLowerCase(),
        `${b.firstName} ${b.lastName}`.toLowerCase(),
      );
      if (similarity >= 0.92) return true;
    }

    return false;
  }

  private async mergePeople(keepId: string, removeId: string): Promise<void> {
    const keep = await this.prisma.person.findUnique({ where: { id: keepId } });
    const remove = await this.prisma.person.findUnique({ where: { id: removeId } });

    if (!keep || !remove) return;

    // Update keep with any missing fields from remove
    await this.prisma.person.update({
      where: { id: keepId },
      data: {
        title: keep.title ?? remove.title,
        seniority: keep.seniority === "UNKNOWN" ? remove.seniority : keep.seniority,
        department: keep.department === "UNKNOWN" ? remove.department : keep.department,
        linkedinSlug: keep.linkedinSlug ?? remove.linkedinSlug,
        linkedinUrl: keep.linkedinUrl ?? remove.linkedinUrl,
        githubHandle: keep.githubHandle ?? remove.githubHandle,
        twitterHandle: keep.twitterHandle ?? remove.twitterHandle,
        location: keep.location ?? remove.location,
        bio: keep.bio ?? remove.bio,
      },
    });

    // Move emails from remove to keep
    const existingEmails = await this.prisma.emailCandidate.findMany({
      where: { personId: removeId },
    });

    for (const ec of existingEmails) {
      try {
        await this.prisma.emailCandidate.upsert({
          where: { personId_email: { personId: keepId, email: ec.email } },
          create: {
            personId: keepId,
            email: ec.email,
            pattern: ec.pattern,
            source: ec.source,
            verified: ec.verified,
            verificationResult: ec.verificationResult,
            confidence: ec.confidence,
            verifiedAt: ec.verifiedAt,
          },
          update: {},
        });
      } catch {
        // Duplicate, skip
      }
    }

    // Move lead scores
    await this.prisma.leadScore.updateMany({
      where: { personId: removeId },
      data: { personId: keepId },
    });

    // Delete the duplicate
    await this.prisma.person.delete({ where: { id: removeId } });
  }

  /** Jaro-Winkler string similarity (0-1) */
  private jaroWinkler(s1: string, s2: string): number {
    if (s1 === s2) return 1;
    if (s1.length === 0 || s2.length === 0) return 0;

    const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
    const s1Matches = new Array<boolean>(s1.length).fill(false);
    const s2Matches = new Array<boolean>(s2.length).fill(false);

    let matches = 0;
    let transpositions = 0;

    for (let i = 0; i < s1.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, s2.length);

      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0;

    let k = 0;
    for (let i = 0; i < s1.length; i++) {
      if (!s1Matches[i]) continue;
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }

    const jaro =
      (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

    // Winkler boost for common prefix
    let prefix = 0;
    for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
      if (s1[i] === s2[i]) prefix++;
      else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }
}
