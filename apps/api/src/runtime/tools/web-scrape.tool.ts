import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { MOCK_DISCLAIMER_SUFFIX, markMocked } from "./mock-metadata";
import { fetchWithRetry } from "../../common/http-retry.util";
import { ssrfGuardedFetch } from "../util/ssrf-guard";

export class WebScrapeTool implements Tool {
  name = "web_scrape";
  description =
    "Extract readable content from a URL. Returns the page title, main content text, and links found on the page." +
    MOCK_DISCLAIMER_SUFFIX;
  parameters = {
    url: { type: "string", description: "The URL to scrape", required: true },
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const url = params.url as string;

    if (!url) {
      return { success: false, data: null, error: "URL is required" };
    }

    try {
      // No circuit breaker: arbitrary user-supplied URLs — one slow host
      // must not poison the breaker pool for unrelated scrapes.
      const response = await ssrfGuardedFetch(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ApexBot/1.0)",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(10000),
        },
        {
          maxRedirects: 5,
          fetcher: (nextUrl, init) =>
            fetchWithRetry(nextUrl, init, { provider: "web-scrape", maxAttempts: 3 }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      return { success: true, data: this.extractContent(html, url) };
    } catch (error) {
      // Return mock data on failure, but tag it so the LLM does not cite it as fact.
      const reason = `Scrape fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      return { success: true, data: markMocked(this.mockScrape(url), reason) };
    }
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
