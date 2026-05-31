/**
 * Pure validators that gate Person/Company rows before they're written to the
 * database. They exist because the production sourcing pipeline was ingesting
 * three classes of garbage:
 *
 *   1. FAQ headers + page section titles ("Frequently Asked Questions",
 *      "Services We Help You Find", "Legal Compliance") becoming Person rows
 *      with fabricated emails like `frequently.askedquestions@gccdomestic.com`.
 *   2. Country/region names ("Saudi Arabia", "United Arab Emirates") landing
 *      as Person.firstName/Person.lastName after a SERP title was split on
 *      `–` / `|`.
 *   3. SEO aggregator URLs (dnb.com, consultancy-me.com, legal500.com,
 *      cultureamp.com, landbase.com) becoming Company rows blanket-tagged with
 *      whatever industry/country happened to be `icp.targetIndustries[0]` /
 *      `icp.targetGeos[0]`.
 *
 * These helpers are pure, dependency-free, and side-effect-free. They return
 * a boolean — the caller decides what to log/skip. They are intentionally
 * conservative: false negatives (rejecting a real lead) are recoverable, but
 * false positives (accepting garbage) are what poison the outreach queue.
 */

/**
 * Apex/SLD-level blocklist used by `isAggregatorDomain` AND by
 * `SerpDiscoveryService.parseCompanyResult` to filter SERP hits. Kept here so
 * both call sites stay in sync — if a new aggregator starts polluting the
 * pipeline, add it here once.
 *
 * Subdomain handling: matched against the last two dotted segments of the
 * hostname (e.g. `team.consultancy-me.com` matches `consultancy-me.com`).
 *
 * Entries are grouped by category for ease of review. Order does not matter.
 */
export const AGGREGATOR_AND_NOISE_DOMAINS: readonly string[] = [
  // B2B aggregators / data brokers — produced rows like "D&B Hoovers" blanket-tagged "B2B SaaS UAE".
  "dnb.com",
  "crunchbase.com",
  "zoominfo.com",
  "apollo.io",
  "rocketreach.co",
  "clearbit.com",
  "hunter.io",
  "lusha.com",

  // Review / comparison sites — long-tail SEO hits, not target companies.
  "g2.com",
  "capterra.com",
  "getapp.com",
  "softwareadvice.com",
  "trustradius.com",
  "clutch.co",
  "goodfirms.co",

  // Job / career aggregators (parent pages — company-specific subdomains on
  // greenhouse.io / lever.co are handled separately by the ATS scraper).
  "indeed.com",
  "glassdoor.com",
  "ziprecruiter.com",
  "lever.co",
  "greenhouse.io",

  // News / media — articles ABOUT companies, not the companies themselves.
  "forbes.com",
  "techcrunch.com",
  "bloomberg.com",
  "reuters.com",
  "wsj.com",
  "ft.com",
  "businessinsider.com",
  "venturebeat.com",
  "theverge.com",

  // Wiki / research / analyst publications.
  "wikipedia.org",
  "britannica.com",
  "statista.com",
  "gartner.com",
  "forrester.com",
  "mckinsey.com",
  "bcg.com",

  // Regulatory / legal directories — produced fake-person rows like
  // "Legal Compliance" because their listing pages have FAQ-shaped headers.
  "legal500.com",
  "chambers.com",
  "lawyers.com",
  "martindale.com",

  // Region-specific SEO hosts — the original audit caught these:
  // consultancy-me.com, marknteladvisors.com, ocorian.com, devcommx.com,
  // regtechafrica.com, majubiz.com were all converted into Company rows
  // labelled "B2B SaaS / United Arab Emirates" with zero supporting evidence.
  "consultancy-me.com",
  "consultancy.uk",
  "consultancy.eu",
  "marknteladvisors.com",
  "ocorian.com",
  "devcommx.com",
  "regtechafrica.com",
  "majubiz.com",
  "gccdomestic.com",

  // Generic SEO content hosts (the *roots* — specific customer subdomains
  // on hubspot.com etc. won't be matched because we test the apex domain).
  "cultureamp.com",
  "landbase.com",
  "hubspot.com",

  // Social — handled via dedicated discovery paths; ban here to keep them
  // out of the "treat as company website" branch.
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "reddit.com",
  "medium.com",
  "substack.com",

  // Domain registrars + parking — entire domain often resolves to an SEO
  // placeholder page.
  "godaddy.com",
  "namecheap.com",
  "parkingcrew.net",
  "sedo.com",

  // Marketplaces — wrong shape for B2B outreach.
  "amazon.com",
  "alibaba.com",
  "ebay.com",

  // Generic infra / hosting roots — github.com root pages, gitlab.com,
  // vercel.com, netlify.com, cloudflare.com get hit by SEO content but
  // aren't the customer we're trying to reach.
  "cloudflare.com",
  "akamai.com",
  "github.com",
  "gitlab.com",
  "vercel.com",
  "netlify.com",

  // Search engines (catch redirects that survived URL parsing).
  "google.com",
];

/**
 * Section-header / nav / footer / CTA words that bubbled up as Person rows
 * when the team-page LLM extractor (pre-fix) or SERP title parser was fed a
 * directory page instead of a real team list. Each entry was actually seen in
 * a poisoned production row — DO NOT remove without confirming the rejection
 * isn't load-bearing.
 */
const SECTION_HEADER_WORDS: ReadonlySet<string> = new Set([
  // From FAQ panels — produced firstName="Frequently" lastName="Asked".
  "frequently",
  "asked",
  "questions",

  // From service-category labels — produced firstName="Services" lastName="We".
  "services",
  "service",
  "solutions",
  "products",
  "pricing",

  // Legal / compliance section headers — produced firstName="Legal" lastName="Compliance".
  "legal",
  "compliance",
  "privacy",
  "terms",
  "cookie",
  "copyright",

  // Page-structure / nav / footer.
  "footer",
  "navigation",
  "menu",
  "header",
  "sidebar",

  // Generic CTAs / standard nav items.
  "about",
  "contact",
  "home",
  "resources",
  "blog",
  "careers",
  "company",
  "team",
  "leadership",
  "investors",
  "press",
  "media",
  "support",
  "help",
  "documentation",
  "docs",
  "login",
  "signup",
  "register",
  "search",
  "subscribe",
  "newsletter",

  // FAQ section verbs / connectors.
  "find",
  "discover",
  "learn",
  "read",
  "explore",
  "join",
  "get",
  "click",
  "view",
  "browse",

  // Common phrase tails caught in pre-fix garbage (`firstName="Find"
  // lastName="Out"`, `firstName="Read" lastName="More"` etc.).
  "out",
  "more",
  "here",
  "now",
  "today",
  "started",
]);

/**
 * Country, region, and continent names that bubbled up as Person rows when
 * a SERP-title splitter or DOM-pattern matcher hit a geo-tag heading. Stored
 * lowercased; both name parts are compared case-insensitively.
 *
 * Trade-off: a real person named "Saudi" or "Jordan" will be falsely rejected
 * — that's acceptable. The cost of letting `firstName="Saudi" lastName="Arabia"`
 * through (a row that triggered fake-email generation in prod) is much higher.
 */
const COUNTRY_AND_REGION_WORDS: ReadonlySet<string> = new Set([
  // MENA — most of the prod garbage was from MENA SEO directories.
  "saudi",
  "arabia",
  "united",
  "arab",
  "emirates",
  "bahrain",
  "kuwait",
  "qatar",
  "oman",
  "egypt",
  "jordan",
  "lebanon",
  "iraq",
  "iran",
  "syria",
  "yemen",
  "palestine",
  "israel",
  "morocco",
  "tunisia",
  "algeria",
  "libya",
  "sudan",
  "turkey",

  // Common country / region tokens that appear as standalone words.
  "india",
  "china",
  "japan",
  "korea",
  "vietnam",
  "thailand",
  "singapore",
  "malaysia",
  "indonesia",
  "philippines",
  "pakistan",
  "bangladesh",
  "australia",
  "newzealand",
  "germany",
  "france",
  "spain",
  "italy",
  "portugal",
  "netherlands",
  "belgium",
  "sweden",
  "norway",
  "finland",
  "denmark",
  "switzerland",
  "austria",
  "poland",
  "russia",
  "ukraine",
  "ireland",
  "scotland",
  "england",
  "wales",
  "britain",
  "kingdom",
  "states",
  "america",
  "canada",
  "mexico",
  "brazil",
  "argentina",
  "chile",
  "colombia",
  "peru",
  "venezuela",
  "africa",
  "nigeria",
  "kenya",
  "ethiopia",

  // Two-letter / common abbreviations.
  "usa",
  "uk",
  "uae",
  "ksa",
  "eu",

  // City names that consistently showed up as fake "names" in audit rows
  // (Dubai · Abu Dhabi headers split on `·`).
  "dubai",
  "abu",
  "dhabi",
  "riyadh",
  "doha",
  "manama",
  "muscat",
  "amman",
  "cairo",
  "istanbul",
  "london",
  "paris",
  "berlin",
  "madrid",
  "rome",
  "tokyo",
  "beijing",
  "shanghai",
  "mumbai",
  "delhi",
  "bangalore",
  "sydney",
  "melbourne",
  "toronto",
  "vancouver",
  "york", // New York
  "francisco", // San Francisco
  "angeles", // Los Angeles
]);

/**
 * Role keywords. If any of these appears in the title (case-insensitive,
 * substring match — we want "VP of RevOps" to match "vp"), the title is
 * accepted by `isLikelyJobTitle`. The list is intentionally generous: it's
 * easier to maintain than a regex and the false-accept cost is bounded
 * because the title also has to pass length + country + separator checks.
 */
const ROLE_KEYWORDS: readonly string[] = [
  "ceo",
  "cto",
  "cfo",
  "coo",
  "cmo",
  "cio",
  "cso",
  "ciso",
  "cro",
  "cdo",
  "chief",
  "vp",
  "vice president",
  "director",
  "head",
  "lead",
  "manager",
  "engineer",
  "developer",
  "designer",
  "sales",
  "marketing",
  "product",
  "operations",
  "founder",
  "co-founder",
  "cofounder",
  "partner",
  "principal",
  "consultant",
  "analyst",
  "researcher",
  "scientist",
  "architect",
  "advisor",
  "president",
  "owner",
];

/** Single-token name validator used by `isLikelyHumanName`. */
function looksLikeNameToken(token: string): boolean {
  if (token.length < 2 || token.length > 25) return false;
  // Allow letters (incl. extended Latin for international names), plus the
  // two punctuation marks that legitimately appear in names: apostrophes
  // (O'Brien) and hyphens (Jean-Luc).
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'-]*$/.test(token)) return false;
  // Reject digits and other punctuation (already excluded by the regex above,
  // but be explicit so future regex changes don't silently widen this).
  if (/[0-9]/.test(token)) return false;
  // Real names are TitleCase. "JOHN SMITH" and "john smith" almost always
  // come from CSS-uppercased headings or lower-cased nav links — both were
  // sources of garbage in the audit.
  if (token === token.toUpperCase()) return false;
  if (token === token.toLowerCase()) return false;
  return true;
}

/**
 * Returns true iff the input looks like a real human full name. False on:
 *   - missing first or last name
 *   - FAQ / section-header words (frequently, services, legal, etc.)
 *   - country / region names
 *   - tokens with digits, weird punctuation, all-uppercase, or all-lowercase
 *   - tokens outside the 2–25 char range
 */
export function isLikelyHumanName(input: {
  firstName?: string | null;
  lastName?: string | null;
}): boolean {
  const first = (input.firstName ?? "").trim();
  const last = (input.lastName ?? "").trim();
  if (first.length === 0 || last.length === 0) return false;

  // For multi-word last names ("Van Der Berg", "De La Cruz"), test the first
  // token of the last name — that's what the existing isValidPersonName check
  // does and we want to match its behavior for non-pejorative rejections.
  const firstLower = first.toLowerCase();
  const lastFirstToken = last.split(/\s+/)[0] ?? "";
  const lastLower = lastFirstToken.toLowerCase();

  // FAQ / nav / footer words — these produced rows like firstName="Frequently"
  // lastName="Asked", firstName="Services" lastName="We", etc.
  if (SECTION_HEADER_WORDS.has(firstLower)) return false;
  if (SECTION_HEADER_WORDS.has(lastLower)) return false;

  // Country / region names — split on whitespace so "Saudi Arabia" → reject.
  if (COUNTRY_AND_REGION_WORDS.has(firstLower)) return false;
  if (COUNTRY_AND_REGION_WORDS.has(lastLower)) return false;

  if (!looksLikeNameToken(first)) return false;
  if (!looksLikeNameToken(lastFirstToken)) return false;

  return true;
}

/**
 * Returns true iff `domain` is on the aggregator / SEO / social / parking
 * blocklist. Compares against the last two dotted segments so subdomains
 * (`team.consultancy-me.com`) are correctly matched. Inputs are
 * case-insensitive; we strip a leading `www.` because some callers don't.
 */
export function isAggregatorDomain(domain: string): boolean {
  if (!domain || domain.length === 0) return false;
  const cleaned = domain.toLowerCase().replace(/^www\./, "").trim();
  // Take the apex (last two segments). `legal500.com` → `legal500.com`;
  // `team.consultancy-me.com` → `consultancy-me.com`. Multi-part TLDs like
  // `.co.uk` are best-effort here — if a noisy `.co.uk` SEO host shows up in
  // prod we'll add it to the blocklist with the full host.
  const parts = cleaned.split(".");
  if (parts.length < 2) return false;
  const apex = parts.slice(-2).join(".");
  // Also test the full host for exact matches in case the blocklist contains
  // a multi-part entry (e.g. `consultancy.uk` — which is already only two
  // segments — vs a future `something.co.uk`).
  for (const blocked of AGGREGATOR_AND_NOISE_DOMAINS) {
    const blockedLower = blocked.toLowerCase();
    if (apex === blockedLower) return true;
    if (cleaned === blockedLower) return true;
    if (cleaned.endsWith(`.${blockedLower}`)) return true;
  }
  return false;
}

/**
 * Returns true iff `title` looks like a real job title.
 *
 * Rejects:
 *   - missing / too short / too long
 *   - titles that are actually country names (caught "Saudi Arabia" being
 *     treated as a person's title)
 *   - "service category" phrases — short comma/middot-separated lists like
 *     "Housemaids and domestic helpers", "Dubai · Abu Dhabi" with no
 *     recognizable role keyword in them.
 *
 * Accepts:
 *   - anything containing a known role keyword (CEO, VP of X, Director, etc.)
 *   - anything else that survives the length + separator checks (we'd rather
 *     accept an unfamiliar title than silently drop a real one).
 */
export function isLikelyJobTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (trimmed.length < 2 || trimmed.length > 100) return false;

  const lower = trimmed.toLowerCase();

  // Reject if the whole title is just a country / region label.
  const tokens = lower.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length > 0 && tokens.every((t) => COUNTRY_AND_REGION_WORDS.has(t))) {
    return false;
  }

  // Detect role keyword. Substring match so "VP of RevOps", "Engineering
  // Manager", "Head of Sales" all hit.
  const hasRole = ROLE_KEYWORDS.some((kw) => lower.includes(kw));
  if (hasRole) return true;

  // "Service category" phrases — comma/middot/pipe separators with no role
  // keyword. Caught real prod garbage like "Housemaids and domestic helpers"
  // and "Dubai · Abu Dhabi · Sharjah" landing in Person.title.
  if (/[·,|]/.test(trimmed)) return false;

  // No separators, no role keyword: accept. Real-world titles like
  // "Operations" or "Strategy" don't always include the canonical role token
  // (e.g. "Strategy" is a department name often used as a title). We'd
  // rather accept than reject without strong evidence.
  return true;
}
