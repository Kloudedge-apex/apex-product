import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { MOCK_DISCLAIMER_SUFFIX, markMocked } from "./mock-metadata";
import { fetchWithRetry } from "../../common/http-retry.util";
import { EnrichmentLicenseScope, type Prisma } from "@prisma/client";
import type { EvidenceLedgerService } from "../../observability/evidence-ledger.service";
import type { EnrichmentFactService } from "../../enrichment/enrichment-fact.service";
import { withEnrichmentCache } from "../../enrichment/enrichment-cache.guard";

export class WebScrapeTool implements Tool {
  name = "web_scrape";
  description =
    "Extract readable content from a URL. Returns the page title, main content text, and links found on the page." +
    MOCK_DISCLAIMER_SUFFIX;
  parameters = {
    url: { type: "string", description: "The URL to scrape", required: true },
  };

  constructor(
    private readonly enrichmentFacts?: EnrichmentFactService,
    private readonly evidenceLedger?: EvidenceLedgerService,
  ) {}

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const url = params.url as string;

    if (!url) {
      return { success: false, data: null, error: "URL is required" };
    }

    try {
      if (this.enrichmentFacts) {
        const fact = await withEnrichmentCache(
          {
            enrichmentFacts: this.enrichmentFacts,
            evidenceLedger: this.evidenceLedger,
            orgId: context.orgId,
            runId: context.runId,
            provider: "web-scrape",
            lookupKey: `url:${url}`,
            field: "page",
            ttlMs: 7 * 24 * 60 * 60 * 1000,
            costCredits: 1,
            licenseScope: EnrichmentLicenseScope.RESEARCH_OK,
          },
          async () => this.scrapeUrlData(url),
        );

        return { success: true, data: fact.value };
      }

      const data = await this.scrapeUrlData(url);
      return { success: true, data };
    } catch (error) {
      // Return mock data on failure, but tag it so the LLM does not cite it as fact.
      const reason = `Scrape fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      return { success: true, data: markMocked(this.mockScrape(url), reason) };
    }
  }

  private async scrapeUrlData(url: string): Promise<Prisma.InputJsonValue> {
    // No circuit breaker: arbitrary user-supplied URLs — one slow host
    // must not poison the breaker pool for unrelated scrapes.
    const response = await fetchWithRetry(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ApexBot/1.0)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(10000),
      },
      { provider: "web-scrape", maxAttempts: 3 },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    return this.extractContent(html, url);
  }

  private extractContent(html: string, url: string): { title: string; content: string; links: string[] } {
    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : "Untitled";

    // Remove script, style, nav, header, footer tags
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "");

    // Extract text from body or article
    const articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i);
    const mainMatch = cleaned.match(/<main[\s\S]*?<\/main>/i);
    const bodyMatch = cleaned.match(/<body[\s\S]*?<\/body>/i);
    const contentHtml = articleMatch?.[0] || mainMatch?.[0] || bodyMatch?.[0] || cleaned;

    // Strip HTML tags and clean whitespace
    const content = contentHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 5000);

    // Extract links
    const linkRegex = /href="(https?:\/\/[^"]+)"/gi;
    const links: string[] = [];
    let linkMatch;
    while ((linkMatch = linkRegex.exec(html)) !== null && links.length < 20) {
      links.push(linkMatch[1]);
    }

    return { title, content, links };
  }

  private mockScrape(url: string): { title: string; content: string; links: string[] } {
    const domain = new URL(url).hostname;
    return {
      title: `${domain} - Company Page`,
      content: `${domain} is a technology company focused on delivering innovative solutions. The company offers a range of products and services designed to help businesses scale efficiently. With a team of experienced professionals, ${domain} serves clients across multiple industries including SaaS, fintech, and enterprise software. Recent initiatives include AI-powered automation, cloud infrastructure optimization, and enhanced data analytics capabilities.`,
      links: [
        `${url}/about`,
        `${url}/products`,
        `${url}/blog`,
        `${url}/careers`,
        `${url}/contact`,
      ],
    };
  }
}
