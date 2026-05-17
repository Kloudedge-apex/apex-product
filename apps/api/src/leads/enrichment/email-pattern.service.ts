import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { promises as dns } from "dns";
import type { EmailSource } from "@prisma/client";

interface EmailCandidate {
  email: string;
  pattern: string;
  source: EmailSource;
  confidence: number;
}

interface StoredPattern {
  pattern: string;
  frequency: number;
  confidence: number;
}

const EMAIL_PATTERNS: Array<{ name: string; generate: (first: string, last: string, domain: string) => string }> = [
  { name: "first.last", generate: (f, l, d) => `${f}.${l}@${d}` },
  { name: "first", generate: (f, _l, d) => `${f}@${d}` },
  { name: "flast", generate: (f, l, d) => `${f[0]}${l}@${d}` },
  { name: "firstl", generate: (f, l, d) => `${f}${l[0]}@${d}` },
  { name: "f.last", generate: (f, l, d) => `${f[0]}.${l}@${d}` },
  { name: "first_last", generate: (f, l, d) => `${f}_${l}@${d}` },
  { name: "last.first", generate: (f, l, d) => `${l}.${f}@${d}` },
  { name: "last", generate: (_f, l, d) => `${l}@${d}` },
];

@Injectable()
export class EmailPatternService {
  private readonly logger = new Logger(EmailPatternService.name);
  private readonly hunterKey: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.hunterKey = this.config.get<string>("HUNTER_API_KEY");
  }

  async generateCandidates(
    firstName: string,
    lastName: string,
    domain: string,
  ): Promise<EmailCandidate[]> {
    const first = this.normalize(firstName);
    const last = this.normalize(lastName);
    if (!first || !last) return [];

    const candidates: EmailCandidate[] = [];

    // Check if we have a known pattern for this domain
    const stored = await this.getStoredPattern(domain);

    if (stored) {
      // Use the known pattern with high confidence
      const patternDef = EMAIL_PATTERNS.find((p) => p.name === stored.pattern);
      if (patternDef) {
        candidates.push({
          email: patternDef.generate(first, last, domain),
          pattern: stored.pattern,
          source: "PATTERN_GUESS",
          confidence: stored.confidence,
        });
      }
    }

    // Generate all permutations with decreasing confidence
    for (let i = 0; i < EMAIL_PATTERNS.length; i++) {
      const p = EMAIL_PATTERNS[i]!;
      const email = p.generate(first, last, domain);

      // Skip if already added from stored pattern
      if (candidates.some((c) => c.email === email)) continue;

      candidates.push({
        email,
        pattern: p.name,
        source: "PATTERN_GUESS",
        confidence: Math.max(0.1, 0.6 - i * 0.07),
      });
    }

    // Try Hunter.io if configured
    if (this.hunterKey) {
      try {
        const hunterResult = await this.queryHunter(firstName, lastName, domain);
        if (hunterResult) {
          // Add Hunter result at top or boost existing
          const existing = candidates.find((c) => c.email === hunterResult.email);
          if (existing) {
            existing.confidence = Math.max(existing.confidence, hunterResult.confidence);
            existing.source = "HUNTER";
          } else {
            candidates.unshift(hunterResult);
          }
        }
      } catch (err) {
        this.logger.warn(`Hunter.io query failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return candidates.slice(0, 6); // Return top 6 candidates
  }

  /** Learn a pattern from a known-good email on a domain */
  async learnPattern(email: string, domain: string): Promise<void> {
    const localPart = email.split("@")[0];
    if (!localPart) return;

    // Detect which pattern was used
    const detectedPattern = this.detectPattern(localPart);
    if (!detectedPattern) return;

    const existing = await this.prisma.patternStore.findUnique({
      where: { domain },
    });

    if (existing) {
      const patterns = (existing.patterns as unknown as StoredPattern[]) || [];
      const match = patterns.find((p) => p.pattern === detectedPattern);
      if (match) {
        match.frequency++;
        match.confidence = Math.min(0.95, match.confidence + 0.05);
      } else {
        patterns.push({ pattern: detectedPattern, frequency: 1, confidence: 0.5 });
      }

      await this.prisma.patternStore.update({
        where: { domain },
        data: {
          patterns: JSON.parse(JSON.stringify(patterns)),
          sampleSize: existing.sampleSize + 1,
          lastUpdated: new Date(),
        },
      });
    } else {
      await this.prisma.patternStore.create({
        data: {
          domain,
          patterns: JSON.parse(JSON.stringify([{ pattern: detectedPattern, frequency: 1, confidence: 0.5 }])),
          sampleSize: 1,
        },
      });
    }
  }

  /** Classify a domain's MX records */
  async classifyMx(domain: string): Promise<"google" | "microsoft" | "self-hosted" | "unknown"> {
    try {
      const records = await dns.resolveMx(domain);
      const exchanges = records.map((r) => r.exchange.toLowerCase());

      if (exchanges.some((e) => e.includes("google") || e.includes("gmail"))) {
        return "google";
      }
      if (exchanges.some((e) => e.includes("outlook") || e.includes("microsoft"))) {
        return "microsoft";
      }
      if (exchanges.length > 0) {
        return "self-hosted";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  private async getStoredPattern(domain: string): Promise<StoredPattern | null> {
    const store = await this.prisma.patternStore.findUnique({
      where: { domain },
    });

    if (!store) return null;

    const patterns = (store.patterns as unknown as StoredPattern[]) || [];
    // Return the highest-confidence pattern
    return patterns.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  }

  private async queryHunter(
    firstName: string,
    lastName: string,
    domain: string,
  ): Promise<EmailCandidate | null> {
    if (!this.hunterKey) return null;

    await new Promise((r) => setTimeout(r, 500)); // Rate limit

    const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${this.hunterKey}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const data = await res.json() as {
      data?: { email?: string; score?: number; position?: string };
    };

    if (!data.data?.email) return null;

    return {
      email: data.data.email,
      pattern: "hunter",
      source: "HUNTER",
      confidence: (data.data.score ?? 50) / 100,
    };
  }

  private normalize(name: string): string {
    return name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // strip diacritics
      .replace(/[^a-z]/g, "");
  }

  private detectPattern(localPart: string): string | null {
    // Simple heuristic pattern detection
    if (localPart.includes(".")) {
      const parts = localPart.split(".");
      if (parts.length === 2 && parts[0]!.length > 1 && parts[1]!.length > 1) {
        return "first.last";
      }
      if (parts.length === 2 && parts[0]!.length === 1) {
        return "f.last";
      }
    }
    if (localPart.includes("_")) return "first_last";
    // Single word patterns are ambiguous
    return null;
  }
}
