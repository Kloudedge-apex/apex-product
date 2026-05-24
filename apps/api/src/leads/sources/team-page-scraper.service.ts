import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LLMService } from "../../runtime/llm.service";
import { fetchWithRetry, withCircuitBreaker } from "../../common/http-retry.util";
import { chatJsonWithRetry } from "../../common/json-output.util";

interface DiscoveredPerson {
  firstName: string;
  lastName: string;
  title?: string;
  linkedinUrl?: string;
  linkedinSlug?: string;
}

interface JsonLdPerson {
  "@type"?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  jobTitle?: string;
  sameAs?: string | string[];
}

const TEAM_PATHS = [
  "/about",
  "/team",
  "/leadership",
  "/about-us",
  "/our-team",
  "/people",
  "/company/team",
  "/executives",
  "/management",
  "/founders",
];

@Injectable()
export class TeamPageScraper {
  private readonly logger = new Logger(TeamPageScraper.name);
  private readonly openaiKey: string | undefined;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly llm?: LLMService,
  ) {
    this.openaiKey = this.config.get<string>("OPENAI_API_KEY");
  }

  async scrapeTeamPage(
    domain: string,
    knownTeamPageUrl?: string | null,
  ): Promise<DiscoveredPerson[]> {
    const urls = knownTeamPageUrl
      ? [knownTeamPageUrl]
      : TEAM_PATHS.map((p) => `https://${domain}${p}`);

    for (const url of urls) {
      try {
        // Hitting arbitrary tenant team-pages — keep retries modest. No
        // circuit breaker: a single bad customer site must not poison the
        // pool for every other scrape.
        const res = await fetchWithRetry(
          url,
          {
            headers: { "User-Agent": "WorkforceOS/1.0 (lead-engine)" },
            signal: AbortSignal.timeout(10000),
            redirect: "follow",
          },
          { provider: "team-page", maxAttempts: 3 },
        );

        if (!res.ok) continue;

        const html = await res.text();
        if (html.length < 500) continue; // too short to be a team page

        // Try JSON-LD first
        const jsonLdPeople = this.extractJsonLd(html);
        if (jsonLdPeople.length > 0) {
          this.logger.log(`Found ${jsonLdPeople.length} people via JSON-LD on ${url}`);
          return jsonLdPeople;
        }

        // Try DOM pattern extraction
        const domPeople = this.extractFromDom(html);
        if (domPeople.length > 0) {
          this.logger.log(`Found ${domPeople.length} people via DOM patterns on ${url}`);
          return domPeople;
        }

        // LLM fallback for unstructured HTML
        if (this.openaiKey && html.length < 50000) {
          const llmPeople = await this.extractWithLlm(html, url);
          if (llmPeople.length > 0) {
            this.logger.log(`Found ${llmPeople.length} people via LLM on ${url}`);
            return llmPeople;
          }
        }
      } catch {
        // Try next URL
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    return [];
  }

  private extractJsonLd(html: string): DiscoveredPerson[] {
    const people: DiscoveredPerson[] = [];
    const scriptRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(html)) !== null) {
      try {
        const raw = JSON.parse(match[1]!) as JsonLdPerson | JsonLdPerson[] | { "@graph"?: JsonLdPerson[] };
        const items = Array.isArray(raw) ? raw : ("@graph" in raw && Array.isArray(raw["@graph"])) ? raw["@graph"] : [raw as JsonLdPerson];

        for (const item of items) {
          if (item["@type"] !== "Person") continue;

          const first = item.givenName ?? item.name?.split(" ")[0];
          const last = item.familyName ?? item.name?.split(" ").slice(1).join(" ");
          if (!first || !last) continue;

          const linkedinUrl = this.findLinkedin(item.sameAs);

          people.push({
            firstName: first,
            lastName: last,
            title: item.jobTitle,
            linkedinUrl,
            linkedinSlug: linkedinUrl ? this.extractLinkedinSlug(linkedinUrl) : undefined,
          });
        }
      } catch {
        // Invalid JSON-LD, skip
      }
    }

    return people;
  }

  private extractFromDom(html: string): DiscoveredPerson[] {
    const people: DiscoveredPerson[] = [];

    // Common pattern: name in h3/h4 followed by title in p/span
    const patterns = [
      /<h[2-4][^>]*>\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*<\/h[2-4]>\s*(?:<[^>]+>\s*)*<(?:p|span|div)[^>]*>\s*([^<]{3,60})\s*<\//gi,
      /class="[^"]*(?:name|person)[^"]*"[^>]*>\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*</gi,
    ];

    const seen = new Set<string>();

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(html)) !== null) {
        const name = match[1]?.trim();
        if (!name) continue;

        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const parts = name.split(/\s+/);
        if (parts.length < 2) continue;

        const title = match[2]?.trim();

        people.push({
          firstName: parts[0]!,
          lastName: parts.slice(1).join(" "),
          title: title && title.length < 60 ? title : undefined,
        });
      }
    }

    // Extract LinkedIn URLs near names
    const linkedinRegex = /href="(https?:\/\/(?:www\.)?linkedin\.com\/in\/[^"/?]+)/gi;
    let liMatch: RegExpExecArray | null;
    const linkedinUrls: string[] = [];
    while ((liMatch = linkedinRegex.exec(html)) !== null) {
      if (liMatch[1]) linkedinUrls.push(liMatch[1]);
    }

    // Match LinkedIn URLs to people by name similarity in slug
    for (const url of linkedinUrls) {
      const slug = this.extractLinkedinSlug(url) ?? '';
      const slugNorm = slug.toLowerCase().replace(/[^a-z]/g, '');
      let bestMatch = -1;
      let bestScore = 0;
      for (let i = 0; i < people.length; i++) {
        if (people[i]!.linkedinUrl) continue; // already matched
        const nameNorm = `${people[i]!.firstName}${people[i]!.lastName}`.toLowerCase().replace(/[^a-z]/g, '');
        // Check if slug contains the full name or name contains slug
        if (slugNorm.includes(nameNorm) || nameNorm.includes(slugNorm)) {
          const score = nameNorm.length;
          if (score > bestScore) { bestScore = score; bestMatch = i; }
        }
      }
      if (bestMatch >= 0) {
        people[bestMatch]!.linkedinUrl = url;
        people[bestMatch]!.linkedinSlug = this.extractLinkedinSlug(url);
      }
    }

    return people;
  }

  private async extractWithLlm(html: string, url: string): Promise<DiscoveredPerson[]> {
    if (!this.llm || !this.openaiKey) return [];

    // Truncate HTML to save tokens
    const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 8000);

    try {
      // Single retry on parse/shape failure: re-prompts the model with the
      // validation error appended. Returns null after two failed attempts —
      // we treat that as "no people found" and the caller falls through to
      // the next URL in the team-page list.
      const parsed = await chatJsonWithRetry<TeamPagePayload>(this.llm, {
        messages: [
          {
            role: "system",
            content:
              "Extract people (team members, leadership) from this web page text. Return a JSON object {\"people\": [{firstName, lastName, title, linkedinUrl}]}. Only include people who clearly work at this company. Return {\"people\":[]} if none found.",
          },
          {
            role: "user",
            content: `URL: ${url}\n\nPage text:\n${stripped}`,
          },
        ],
        chatOptions: {
          // System pipeline (no agent template): resolve model from env so
          // ops can swap without code changes. SYSTEM_MODEL_MINI is the cheap
          // tier shared with icp-auto. Falls back to the historical default.
          model: process.env.SYSTEM_MODEL_MINI ?? "gpt-4o-mini",
          maxTokens: 1500,
          agent: "team_page_extractor.extract",
          tags: ["pipeline", "team_page_extractor"],
          metadata: { source_url: url },
        },
        guard: isTeamPagePayload,
        schemaDescription:
          '{"people": [{"firstName": string, "lastName": string, "title"?: string, "linkedinUrl"?: string}]}',
        onRetry: (err) =>
          this.logger.warn(
            `Team-page LLM extract: retrying after parse failure for ${url}: ${err}`,
          ),
        onFailure: (err) =>
          this.logger.warn(
            `Team-page LLM extract: both attempts failed for ${url}: ${err}`,
          ),
      });

      if (!parsed) return [];

      const arr: DiscoveredPerson[] = Array.isArray(parsed) ? parsed : parsed.people;

      return arr
        .filter((p): p is DiscoveredPerson => Boolean(p.firstName && p.lastName))
        .map((p) => ({
          ...p,
          linkedinSlug: p.linkedinUrl ? this.extractLinkedinSlug(p.linkedinUrl) : undefined,
        }));
    } catch (err) {
      this.logger.warn(`LLM extraction failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private findLinkedin(sameAs: string | string[] | undefined): string | undefined {
    if (!sameAs) return undefined;
    const urls = Array.isArray(sameAs) ? sameAs : [sameAs];
    return urls.find((u) => u.includes("linkedin.com/in/"));
  }

  private extractLinkedinSlug(url: string): string | undefined {
    const match = /linkedin\.com\/in\/([^/?]+)/.exec(url);
    return match?.[1];
  }
}

/**
 * Accepted LLM payload shapes for the team-page extractor:
 *   1. `{ people: [...] }` (preferred — matches the prompt).
 *   2. Bare array `[...]` (some models drop the wrapper; we accept it).
 */
type TeamPagePayload = { people: DiscoveredPerson[] } | DiscoveredPerson[];

function isDiscoveredPerson(value: unknown): value is DiscoveredPerson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.firstName !== "string" || typeof obj.lastName !== "string") {
    return false;
  }
  // Optional fields must be string when present (or undefined).
  if (obj.title !== undefined && typeof obj.title !== "string") return false;
  if (obj.linkedinUrl !== undefined && typeof obj.linkedinUrl !== "string") return false;
  return true;
}

function isTeamPagePayload(value: unknown): value is TeamPagePayload {
  if (Array.isArray(value)) {
    // Tolerate the bare-array variant — every entry must look like a person.
    return value.every(isDiscoveredPerson);
  }
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.people)) return false;
  return obj.people.every(isDiscoveredPerson);
}
