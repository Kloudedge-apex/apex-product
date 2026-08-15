import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LLMService } from "../runtime/llm.service";
import { chatJsonWithRetry } from "../common/json-output.util";
import { ssrfGuardedFetch } from "../runtime/util/ssrf-guard";
import {
  drainResponseBodyWithLimit,
  readResponseTextWithLimit,
} from "../common/http-body.util";

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

    const extracted = await this.extractIcpWithLlm(orgId, websiteUrl, text);

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
      const res = await ssrfGuardedFetch(
        url,
        {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; WorkforceOS-ICP-Bot/1.0; +https://workforceos.xyz)",
            Accept: "text/html,application/xhtml+xml",
          },
        },
        { maxRedirects: 5 },
      );
      if (!res.ok) {
        await drainResponseBodyWithLimit(res);
        throw new Error(`Homepage fetch returned ${res.status}`);
      }
      const html = await readResponseTextWithLimit(res, MAX_HTML_BYTES);
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
    orgId: string,
    url: string,
    text: string,
  ): Promise<ExtractedIcp> {
    const system = ICP_AUTO_EXTRACTOR_SYSTEM_PROMPT;

    const user = `Source URL: ${url}\n\nHomepage text:\n${text}`;

    // Single retry on parse/shape failure: appends the validation error to
    // the conversation so the model can self-correct. Returns null if both
    // attempts fail — we surface that as a BadRequest with manual-fallback
    // guidance rather than throwing on the LLM transport layer.
    const parsed = await chatJsonWithRetry<IcpLlmPayload>(this.llm, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      chatOptions: {
        // System pipeline (no agent template): resolve the model from env so
        // ops can swap without code changes. SYSTEM_MODEL_MINI is the cheap
        // tier used for short structured-extraction calls; falls back to the
        // historical default of gpt-4o-mini if unset.
        model: process.env.SYSTEM_MODEL_MINI ?? "gpt-4o-mini",
        maxTokens: 800,
        // Pin to deterministic sampling. With 0.7 (the historical default)
        // gpt-4o-mini was fabricating plausible-but-wrong ICPs from generic
        // homepages — "B2B SaaS / United Arab Emirates" was the canonical
        // example. Temperature 0 makes the model commit to the empty-payload
        // escape when the page is too generic.
        temperature: 0,
        agent: "icp_auto_extractor.extract",
        tags: ["pipeline", "icp_auto_extractor"],
        orgId,
        metadata: { source_url: url, org_id: orgId },
      },
      guard: isIcpLlmPayload,
      schemaDescription:
        '{"productSummary": string, "industry": string, "targetTitles": string[], ' +
        '"targetIndustries": string[], "targetGeos": string[], "intentKeywords": string[], ' +
        '"minEmployees": number|null, "maxEmployees": number|null}',
      onRetry: (err) =>
        this.logger.warn(`ICP auto-extract: retrying after parse failure: ${err}`),
      onFailure: (err) =>
        this.logger.warn(`ICP auto-extract: both attempts failed: ${err}`),
    });

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

/**
 * Shape of the raw LLM payload before we coerce it into ExtractedIcp.
 * Kept permissive (unknown for arrays) because the guard only ensures the
 * top-level keys are present with the right primitive types — the per-field
 * cleanup happens in `stringArray` / `numberOrUndefined`.
 */
interface IcpLlmPayload {
  productSummary?: unknown;
  industry?: unknown;
  targetTitles?: unknown;
  targetIndustries?: unknown;
  targetGeos?: unknown;
  intentKeywords?: unknown;
  minEmployees?: unknown;
  maxEmployees?: unknown;
}

function isIcpLlmPayload(value: unknown): value is IcpLlmPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;

  const isStringArray = (v: unknown): boolean =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const isNonEmptyStringArray = (v: unknown): boolean =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");

  // Tightened gate: require BOTH targetTitles AND targetIndustries to be
  // non-empty string arrays. The previous "at least one of titles/industries/
  // keywords is a string[]" check accepted sparse outputs like
  // {targetTitles: []} which led to fabricated downstream behaviour. If the
  // model is uncertain it must commit to the empty-payload escape contract
  // documented in the system prompt, which fails this guard and triggers the
  // BadRequest fallback ("define an ICP manually").
  const titlesOk = isNonEmptyStringArray(obj.targetTitles);
  const industriesOk = isNonEmptyStringArray(obj.targetIndustries);
  if (!titlesOk || !industriesOk) return false;

  // The other array fields, if present, must still be string[] (empty OK).
  if (obj.targetGeos !== undefined && !isStringArray(obj.targetGeos)) return false;
  if (obj.intentKeywords !== undefined && !isStringArray(obj.intentKeywords)) return false;

  // productSummary, when present, must be a string OR null (the prompt
  // explicitly allows null when the homepage is too generic to summarise).
  if (
    obj.productSummary !== undefined &&
    obj.productSummary !== null &&
    typeof obj.productSummary !== "string"
  ) {
    return false;
  }
  return true;
}

/**
 * System prompt for the ICP auto-extractor.
 *
 * Why this exists: the prior prompt asked the model to "infer the ICP" with
 * no uncertainty escape and accepted single-token industries like "B2B SaaS"
 * with no geo qualifier. That sparse output got mechanically copied onto
 * every Company row in SerpDiscoveryService.parseCompanyResult, producing
 * the "all 200 companies tagged industry=B2B SaaS, country=UAE" pathology.
 * This rewrite forces the model to be a cautious analyst: it must ground
 * every field in a quoted homepage snippet, and it must return empty arrays
 * when the homepage is too generic.
 */
const ICP_AUTO_EXTRACTOR_SYSTEM_PROMPT = [
  "You are a cautious B2B GTM analyst. Your job is to extract an Ideal Customer Profile (ICP) from a single homepage — and to REFUSE if the homepage is too generic to support a confident answer.",
  "",
  "Output shape (always — no prose, no markdown fences):",
  '  {"productSummary": string|null, "industry": string, "targetTitles": string[], "targetIndustries": string[], "targetGeos": string[], "intentKeywords": string[], "minEmployees": number|null, "maxEmployees": number|null}',
  "",
  "MANDATORY UNCERTAINTY ESCAPE — return ALL arrays empty AND productSummary=null when ANY of these is true:",
  "  - The homepage text is shorter than ~50 words of substantive content.",
  "  - The page is a holding page, parked domain, login wall, or 404.",
  "  - The product or value proposition cannot be identified with confidence from the text in front of you. Guessing based on the domain name alone is forbidden.",
  "  - The page is a generic services / consulting landing page that doesn't name a specific buyer or vertical.",
  "  - The homepage describes multiple unrelated product lines and you cannot pick the primary ICP.",
  '  In all these cases the correct output is: {"productSummary": null, "industry": "", "targetTitles": [], "targetIndustries": [], "targetGeos": [], "intentKeywords": [], "minEmployees": null, "maxEmployees": null}.',
  "  An empty ICP is a CORRECT answer when the page is uninformative. A fabricated ICP is a failure.",
  "",
  "PER-FIELD RULES — every non-empty value below must be justifiable from a specific quoted snippet of the homepage text.",
  "",
  "  productSummary (string or null):",
  "    One sentence, <=300 chars. Must paraphrase a clear value-proposition sentence on the page. Null if no such sentence exists.",
  "",
  "  industry (string):",
  "    The company's OWN industry (what they sell), not their customers' industry. Examples: 'B2B SaaS — RevOps automation', 'Series A fintech infrastructure', 'Marketing agency'.",
  "",
  "  targetTitles (string[]):",
  "    Specific buyer roles named or strongly implied on the page. Examples: 'VP of RevOps', 'Head of Demand Generation', 'Director of Sales Engineering'. Reject generic single-word entries like 'Manager' or 'Director' with no qualifier.",
  "",
  "  targetIndustries (string[]):",
  "    Specific verticals with a qualifier. Examples: 'Series B fintech in MENA', 'mid-market B2B SaaS in North America', 'enterprise healthcare in Western Europe'.",
  "    DO NOT output single-token answers like ['B2B SaaS']. 'B2B SaaS' without a geography or stage qualifier is too generic to drive SERP queries — every aggregator on the internet matches it, which is what produced the original garbage rows.",
  "    DO NOT output ['B2B SaaS'] unless the homepage EXPLICITLY says they sell to B2B SaaS companies AND there is no usable geo or stage qualifier to add.",
  "    If the homepage doesn't clearly say who they sell to, return [].",
  "",
  "  targetGeos (string[]):",
  "    Country names only when explicitly stated on the page or unmistakably implied (e.g. an address block, a 'Serving the UAE since 2019' line). Otherwise return [] — do NOT fall back to 'Global'.",
  "",
  "  intentKeywords (string[]):",
  "    Phrases a buyer would search when in-market for this product. Must be specific (3+ words). Empty array is acceptable.",
  "",
  "  minEmployees / maxEmployees (number or null):",
  "    Only set if the page explicitly mentions a target company size band. Otherwise null.",
  "",
  "EXAMPLES",
  "  Good (homepage is a clear SDR-AI product targeting RevOps leaders at US SaaS companies):",
  '    {"productSummary": "AI agents that automate outbound sales for B2B SaaS RevOps teams.", "industry": "B2B SaaS — Sales Automation", "targetTitles": ["VP of RevOps", "Head of Sales Operations", "Director of Demand Generation"], "targetIndustries": ["Series B+ B2B SaaS in North America"], "targetGeos": ["United States"], "intentKeywords": ["outbound sales automation", "AI SDR for SaaS"], "minEmployees": 50, "maxEmployees": 1000}',
  "",
  "  Good (homepage is a parked / holding / generic page):",
  '    {"productSummary": null, "industry": "", "targetTitles": [], "targetIndustries": [], "targetGeos": [], "intentKeywords": [], "minEmployees": null, "maxEmployees": null}',
  "",
  "  BAD (do NOT output): targetIndustries=['B2B SaaS'] with targetGeos=['United Arab Emirates'] when neither 'SaaS' nor 'UAE' appears in the homepage text. That's fabrication — it's exactly the failure mode that motivated this rewrite.",
  "",
  "Respond with the JSON object only — no prose, no markdown fences.",
].join("\n");

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
