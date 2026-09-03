import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { promises as dns } from "dns";
import * as net from "net";
import type { EmailSource } from "@prisma/client";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";

interface SmtpVerifyResult {
  valid: boolean;
  catchAll: boolean;
  result: "VALID" | "INVALID" | "CATCH_ALL" | "UNKNOWN";
}

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
    orgId: string,
    firstName: string,
    lastName: string,
    domain: string,
  ): Promise<EmailCandidate[]> {
    const first = this.normalize(firstName);
    const last = this.normalize(lastName);
    if (!first || !last) return [];

    const candidates: EmailCandidate[] = [];

    // Check if we have a known pattern for this domain
    const stored = await this.getStoredPattern(orgId, domain);

    if (stored) {
      // Use the known pattern with high confidence
      const patternDef = EMAIL_PATTERNS.find((p) => p.name === stored.pattern);
      if (patternDef) {
        candidates.push({
          email: patternDef.generate(first, last, domain),
          pattern: stored.pattern,
          source: "VERIFIED_PATTERN",
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
  async learnPattern(orgId: string, email: string, domain: string): Promise<void> {
    const localPart = email.split("@")[0];
    if (!localPart) return;

    // Detect which pattern was used
    const detectedPattern = this.detectPattern(localPart);
    if (!detectedPattern) return;

    const existing = await this.prisma.patternStore.findUnique({
      where: { orgId_domain: { orgId, domain } },
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
        where: { orgId_domain: { orgId, domain } },
        data: {
          patterns: JSON.parse(JSON.stringify(patterns)),
          sampleSize: existing.sampleSize + 1,
          lastUpdated: new Date(),
        },
      });
    } else {
      await this.prisma.patternStore.create({
        data: {
          orgId,
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

  private async getStoredPattern(orgId: string, domain: string): Promise<StoredPattern | null> {
    const store = await this.prisma.patternStore.findUnique({
      where: { orgId_domain: { orgId, domain } },
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

    const res = await withCircuitBreaker("hunter", () =>
      fetchWithRetry(url, { signal: AbortSignal.timeout(10000) }, { provider: "hunter" }),
    );
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

  /** Verify an email via SMTP RCPT TO */
  async verifyEmail(email: string): Promise<SmtpVerifyResult> {
    const domain = email.split("@")[1];
    if (!domain) return { valid: false, catchAll: false, result: "UNKNOWN" };

    try {
      const mxRecords = await dns.resolveMx(domain);
      if (mxRecords.length === 0) return { valid: false, catchAll: false, result: "UNKNOWN" };

      const mx = mxRecords.sort((a, b) => a.priority - b.priority)[0]!.exchange;

      // First check catch-all with random address
      const randomAddr = `verify-${Math.random().toString(36).slice(2, 10)}@${domain}`;
      const catchAllResult = await this.smtpRcptTo(mx, randomAddr);
      if (catchAllResult === 250) {
        return { valid: true, catchAll: true, result: "CATCH_ALL" };
      }

      // Now check the actual email
      const result = await this.smtpRcptTo(mx, email);
      if (result === 250) return { valid: true, catchAll: false, result: "VALID" };
      if (result === 550) return { valid: false, catchAll: false, result: "INVALID" };
      return { valid: false, catchAll: false, result: "UNKNOWN" };
    } catch (err) {
      this.logger.debug(`SMTP verify failed for ${email}: ${err instanceof Error ? err.message : String(err)}`);
      return { valid: false, catchAll: false, result: "UNKNOWN" };
    }
  }

  /** Verify a batch of emails with concurrency limit */
  async verifyBatch(emails: string[]): Promise<Map<string, SmtpVerifyResult>> {
    const results = new Map<string, SmtpVerifyResult>();
    const concurrency = 10;

    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map((e) => this.verifyEmail(e).then((r) => [e, r] as const)));
      for (const [email, result] of batchResults) {
        results.set(email, result);
      }
    }

    return results;
  }

  private smtpRcptTo(mx: string, email: string): Promise<number> {
    return new Promise((resolve) => {
      const socket = net.createConnection(25, mx);
      let step = 0;
      let buffer = "";

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(0);
      }, 10000);

      socket.setEncoding("utf8");
      socket.on("data", (data: string) => {
        buffer += data;
        if (!buffer.includes("\r\n")) return;

        const lines = buffer.split("\r\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const code = parseInt(line.slice(0, 3), 10);
          if (isNaN(code)) continue;

          if (step === 0 && code === 220) {
            step = 1;
            socket.write("EHLO workforceos.com\r\n");
          } else if (step === 1 && code === 250) {
            step = 2;
            socket.write("MAIL FROM:<verify@workforceos.com>\r\n");
          } else if (step === 2 && code === 250) {
            step = 3;
            socket.write(`RCPT TO:<${email}>\r\n`);
          } else if (step === 3) {
            socket.write("QUIT\r\n");
            clearTimeout(timeout);
            socket.destroy();
            resolve(code);
            return;
          }
        }
      });

      socket.on("error", () => {
        clearTimeout(timeout);
        resolve(0);
      });
    });
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
