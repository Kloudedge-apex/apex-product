import { Tool, ToolContext, ToolResult } from "./tool.interface";
import { fetchWithRetry } from "../../common/http-retry.util";
import { ssrfGuardedFetch } from "../util/ssrf-guard";
import {
  drainResponseBodyWithLimit,
  readResponseTextWithLimit,
} from "../../common/http-body.util";

const MAX_SCRAPE_BYTES = 500_000;

export class WebScrapeTool implements Tool {
  name = "web_scrape";
  description =
    "Extract readable content from a live public URL. Returns the page title, main content text, and links found on the page. Returns an explicit failure when the page cannot be retrieved.";
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
          fetcher: (nextUrl, init, pinnedFetch) =>
            fetchWithRetry(nextUrl, init, {
              provider: "web-scrape",
              maxAttempts: 3,
              fetchImpl: pinnedFetch,
            }),
        },
      );

      if (!response.ok) {
        await drainResponseBodyWithLimit(response);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await readResponseTextWithLimit(response, MAX_SCRAPE_BYTES);
      return { success: true, data: this.extractContent(html) };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Web page retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private extractContent(html: string): { title: string; content: string; links: string[] } {
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
}
