import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LLMService } from "../runtime/llm.service";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 500_000;
const MAX_TEXT_CHARS = 8_000;
const COMMON_EMAIL_PROVIDERS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  "yandex.com", "zoho.com", "fastmail.com",
]);

interface ExtractedIcp {
  productSummary: string;
  industry: string;
  targetTitles: string[];
  targetIndustries: string[];
  targetGeos: string[];
  intentKeywords: string[];
  minEmployees?: number;
  maxEmployees?: number;
}

/**
 * Generates an ICP profile from an org's website. Used as a fallback when
 * the user triggers a pipeline run but hasn't defined any ICPs yet.
 *
 * Pipeline:
 *   1. Resolve a website URL (Org.website, or fall back to a non-free
 *      email domain from the org's first user).
 *   2. Fetch the homepage HTML with a tight timeout and byte cap.
 *   3. Strip to plain text and clip to MAX_TEXT_CHARS so we don't blow the
 *      LLM context window.
 *   4. Ask the LLM to extract a structured ICP (titles, industries, geos,
 *      keywords) plus a one-line product summary.
 *   5. Persist as an IcpProfile with scheduleEnabled=true so subsequent
 *      pipeline runs pick it up.
 */
@Injectable()
export class IcpAutoService {
  private readonly logger = new Logger(IcpAutoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LLMService,
  ) {}

  async generateForOrg(orgId: string): Promise<{ id: string; name: string }> {
    const websiteUrl = await this.resolveWebsite(orgId);
    if (!websiteUrl) {
      throw new BadRequestException(
        "No website on file for this org and no business-domain email to fall back to. " +
          "Add your company website in Settings, or create an ICP profile manually.",
      );
    }

    this.logger.log(`Auto-generating ICP for org ${orgId} from ${websiteUrl}`);

    const text = await this.fetchHomepageText(websiteUrl);
    if (!text || text.length < 200) {
      throw new BadRequestException(
        `Could not extract enough text from ${websiteUrl} to infer an ICP. ` +
          "Please define one manually in the Leads section.",
      );
    }

    const extracted = await this.extractIcpWithLlm(websiteUrl, text);

    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    const profile = await this.prisma.icpProfile.create({
      data: {
        orgId,
        name: `${org?.name ?? "Auto"} — generated from ${websiteUrl}`,
        targetTitles: extracted.targetTitles.slice(0, 20),
        targetIndustries: extracted.targetIndustries.slice(0, 10),
        targetGeos: extracted.targetGeos.slice(0, 10),
        techStackSignals: [],
        intentKeywords: extracted.intentKeywords.slice(0, 30),
        seedDomains: [websiteUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "")],
        minEmployees: extracted.minEmployees ?? null,
        maxEmployees: extracted.maxEmployees ?? null,
        scheduleEnabled: true,
        scheduleInterval: 24,
      },
      select: { id: true, name: true },
    });

    this.logger.log(`Created auto-ICP ${profile.id} for org ${orgId}`);
    return profile;
  }

  private async resolveWebsite(orgId: string): Promise<string | null> {
    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { website: true },
    });
    if (org?.website) return normalizeUrl(org.website);

    // Fallback: derive from first user's email domain, ignoring free providers.
    const user = await this.prisma.user.findFirst({
      where: { orgId },
      orderBy: { createdAt: "asc" },
      select: { email: true },
    });
    if (!user?.email || !user.email.includes("@")) return null;
    const domain = user.email.split("@")[1].toLowerCase();
    if (COMMON_EMAIL_PROVIDERS.has(domain)) return null;
    if (domain.endsWith(".local")) return null; // our auto-provision placeholder
    return `https://${domain}`;
  }

  private async fetchHomepageText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; WorkforceOS-ICP-Bot/1.0; +https://workforceos.xyz)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) {
        throw new Error(`Homepage fetch returned ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) return "";
      let total = 0;
      const chunks: Uint8Array[] = [];
      while (total < MAX_HTML_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
      return htmlToText(html).slice(0, MAX_TEXT_CHARS);
    } catch (err) {
      this.logger.warn(
        `Homepage fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException(
        `Could not reach ${url}. Make sure the website is publicly accessible.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async extractIcpWithLlm(
    url: string,
    text: string,
  ): Promise<ExtractedIcp> {
    const system =
      "You are a senior B2B GTM strategist. Given a company's homepage text, " +
      "infer the Ideal Customer Profile (ICP) for their outbound sales motion. " +
      "Respond with ONLY a single JSON object — no prose, no markdown fence. " +
      'Schema: {"productSummary": string, "industry": string, "targetTitles": string[], ' +
      '"targetIndustries": string[], "targetGeos": string[], "intentKeywords": string[], ' +
      '"minEmployees": number|null, "maxEmployees": number|null}. ' +
      "Titles should be specific buyer roles (e.g. 'VP of RevOps', 'Head of Demand Gen'), " +
      "not generic ('Manager'). Geos as country names or 'Global'. " +
      "Intent keywords are phrases that signal a buyer is in-market.";

    const user = `Source URL: ${url}\n\nHomepage text:\n${text}`;

    const resp = await this.llm.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { model: "gpt-4o-mini", maxTokens: 800 },
    );

    const parsed = safeParseJson(resp.content);
    if (!parsed) {
      throw new BadRequestException(
        "Could not parse ICP from website. Please define one manually.",
      );
    }

    return {
      productSummary: String(parsed.productSummary ?? "").slice(0, 300),
      industry: String(parsed.industry ?? "").slice(0, 100),
      targetTitles: stringArray(parsed.targetTitles),
      targetIndustries: stringArray(parsed.targetIndustries),
      targetGeos: stringArray(parsed.targetGeos),
      intentKeywords: stringArray(parsed.intentKeywords),
      minEmployees: numberOrUndefined(parsed.minEmployees),
      maxEmployees: numberOrUndefined(parsed.maxEmployees),
    };
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, "")}`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function safeParseJson(s: string): Record<string, unknown> | null {
  if (!s) return null;
  // Tolerate models that wrap output in ```json … ```
  const stripped = s.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const v = JSON.parse(stripped);
    return typeof v === "object" && v ? (v as Record<string, unknown>) : null;
  } catch {
    // Try to extract the first {...} block
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0 && x.length < 200);
}

function numberOrUndefined(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000) {
    return Math.round(v);
  }
  return undefined;
}
