import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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

  constructor(private readonly config: ConfigService) {
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
        const res = await fetch(url, {
          headers: { "User-Agent": "WorkforceOS/1.0 (lead-engine)" },
          signal: AbortSignal.timeout(10000),
          redirect: "follow",
        });

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
    if (!this.openaiKey) return [];

    // Truncate HTML to save tokens
    const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 8000);

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "Extract people (team members, leadership) from this web page text. Return JSON array of {firstName, lastName, title, linkedinUrl}. Only include people who clearly work at this company. Return [] if none found.",
            },
            {
              role: "user",
              content: `URL: ${url}\n\nPage text:\n${stripped}`,
            },
          ],
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) return [];

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return [];

      const parsed = JSON.parse(content) as { people?: DiscoveredPerson[] } | DiscoveredPerson[];
      const arr = Array.isArray(parsed) ? parsed : (parsed.people ?? []);

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
