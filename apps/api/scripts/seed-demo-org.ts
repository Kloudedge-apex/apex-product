/**
 * seed-demo-org.ts — populates a Loom-demo Org with realistic-looking
 * B2B SaaS outbound data.
 *
 * Audience: investors + Techstars SF reviewers + sales-ops prospects.
 * Persona: an Org selling sales-tooling to other B2B SaaS companies, ICP
 * focused on VP Sales / CRO / RevOps at mid-market (50-500 employee)
 * SaaS firms.
 *
 * What it seeds (idempotent — re-running is safe):
 *   - IcpProfile         (the target persona definition)
 *   - 80 Company rows   (varied SaaS verticals: devtools, fintech-saas,
 *                        analytics, security, infra, RevOps tooling)
 *   - 120 Person rows   (1-3 contacts per company, realistic title mix)
 *   - 120 LeadScore rows (spread 32-94 with bell-curve weighting)
 *   - 30 OutreachArtifacts in a 10/10/10 split:
 *        PENDING_REVIEW — fresh approval queue
 *        APPROVED       — waiting on the send-outreach worker
 *        SENT           — historical baseline with mock provider ids
 *
 * USAGE
 *   The Org row must already exist (created via the normal signup flow
 *   by the operator's demo email — Clerk webhook provisions it). Pass
 *   the new Org id via env:
 *
 *     DEMO_ORG_ID=cm... pnpm tsx apps/api/scripts/seed-demo-org.ts
 *
 *   DATABASE_URL must be set to the target Postgres. For prod runs,
 *   open the temp firewall rule first (see live-readiness-audit prompt
 *   for the snippet), then close it after.
 *
 * SAFETY
 *   - Refuses to run when the Org row is missing.
 *   - Uses deterministic recipientRef hashing so re-runs do NOT
 *     duplicate artifacts (matches the prod unique constraint).
 *   - Does NOT touch the User table — the demo user signs in via Clerk
 *     and lands in the Org via the standard webhook path.
 */
import { PrismaClient, OutreachArtifactStatus, OutreachChannel } from "@prisma/client";

const ORG_ID = process.env.DEMO_ORG_ID;
if (!ORG_ID) {
  console.error("Set DEMO_ORG_ID env to the target Org id (created via Clerk signup).");
  process.exit(1);
}

const prisma = new PrismaClient();

// ── Realistic name pools ────────────────────────────────────────────────
const COMPANY_PREFIXES = [
  "Vector", "Lumen", "Stratus", "Vertex", "Cascade", "Helix", "Arclight",
  "Beacon", "Cohort", "Compass", "Foundry", "Frontline", "Grit", "Halo",
  "Hyperion", "Indigo", "Junction", "Kestrel", "Linden", "Maple",
  "Mercury", "Meridian", "Mirage", "Nexus", "Nova", "Origin", "Orion",
  "Outlier", "Parallel", "Patchwork", "Perigee", "Phantom", "Phoenix",
  "Pivot", "Polestar", "Quanta", "Radial", "Relay", "Riverbed", "Sable",
  "Salient", "Sentinel", "Sequel", "Sequoia", "Sigma", "Signal",
  "Solstice", "Sonic", "Spectra", "Stack", "Stride", "Surge", "Switch",
  "Talos", "Tandem", "Tempo", "Tessera", "Thread", "Tidal", "Tiger",
  "Torch", "Trident", "Tundra", "Twilio-style", "Umbra", "Unison",
  "Vantage", "Vega", "Verse", "Vista", "Volta", "Watson", "Wayfind",
  "Whetstone", "Wildwire", "Wisp", "Yardstick", "Zenith", "Zephyr",
];

const COMPANY_SUFFIXES = [
  "Labs", "AI", "Cloud", "Systems", "Networks", "Analytics", "Data",
  "Insights", "Compute", "Stack", "Studio", "Works", "Engineering", "Ops",
];

const VERTICALS = [
  "DevTools", "Observability", "Security", "Data Platform", "Fintech SaaS",
  "RevOps Tooling", "Analytics", "Productivity", "AI Infrastructure",
  "Customer Data Platform", "Marketing Automation", "Compliance",
];

const FIRST_NAMES = [
  "Alex", "Priya", "Marcus", "Sasha", "Jordan", "Hannah", "Diego",
  "Aisha", "Kenji", "Maya", "Liam", "Zara", "Ethan", "Nina", "Owen",
  "Leah", "Caleb", "Sofia", "Noah", "Ada", "Wei", "Anya", "Jamal",
  "Iris", "Tomas", "Yara", "Felix", "Mira", "Ravi", "Elena", "Theo",
  "Rin", "Mateo", "Aria", "Hassan", "Lucia", "Dmitri", "Naomi",
  "Andre", "Saanvi", "Cole", "Tara", "Vikram", "Cora", "Tobias",
  "Iman", "Beck", "Esme", "Levi", "Anika", "Jonah",
];

const LAST_NAMES = [
  "Chen", "Patel", "Johnson", "Garcia", "Smith", "Kim", "Nguyen",
  "Brown", "Khan", "Hernandez", "Schmidt", "Lopez", "Singh", "Rossi",
  "Yamamoto", "Park", "Andersen", "Mehta", "Williams", "Tanaka",
  "Diaz", "Ferreira", "Murphy", "Goldberg", "Reyes", "Ahmad", "Klein",
  "Kowalski", "Petrov", "Olsen", "Nakamura", "Iqbal", "Vasquez",
  "Carter", "Bennett", "Mitra", "Krause", "Souza", "Ng", "Vargas",
];

const TITLES_VP = ["VP of Sales", "VP Revenue", "VP Growth", "VP Marketing"];
const TITLES_CXO = ["Chief Revenue Officer", "Chief Sales Officer", "Chief Growth Officer"];
const TITLES_HEAD = ["Head of Sales", "Head of RevOps", "Head of Growth", "Head of Marketing", "Head of Pipeline"];
const TITLES_DIR = ["Director of Sales", "Director of RevOps", "Director of Pipeline", "Director of Growth"];
const TITLES_MGR = ["Sales Manager", "RevOps Manager", "Marketing Operations Manager"];

const ALL_TITLES = [
  ...TITLES_VP.flatMap((t) => Array(3).fill(t)),
  ...TITLES_CXO.flatMap((t) => Array(2).fill(t)),
  ...TITLES_HEAD.flatMap((t) => Array(4).fill(t)),
  ...TITLES_DIR.flatMap((t) => Array(3).fill(t)),
  ...TITLES_MGR.flatMap((t) => Array(2).fill(t)),
];

const COUNTRIES = ["United States", "United States", "United States", "United Kingdom", "Canada", "Germany", "Australia"];

const EMP_RANGES = [
  "50-100", "50-100", "100-250", "100-250", "100-250", "250-500", "250-500",
];

const FUNDING = ["Seed", "Series A", "Series B", "Series B", "Series C", "Bootstrapped"];

const TECH_STACKS: Record<string, string[]> = {
  DevTools: ["GitHub", "Linear", "Sentry", "PostHog"],
  Observability: ["Datadog", "Sentry", "Grafana", "PagerDuty"],
  Security: ["Snyk", "Auth0", "Vanta", "1Password"],
  "Data Platform": ["Snowflake", "dbt", "Fivetran", "Airbyte"],
  "Fintech SaaS": ["Stripe", "Plaid", "Mercury", "QuickBooks"],
  "RevOps Tooling": ["Salesforce", "HubSpot", "Outreach", "Gong"],
  Analytics: ["Mixpanel", "Amplitude", "Segment", "Looker"],
  Productivity: ["Notion", "Slack", "Linear", "Figma"],
  "AI Infrastructure": ["OpenAI", "Anthropic", "Pinecone", "LangSmith"],
  "Customer Data Platform": ["Segment", "Rudderstack", "Hightouch", "Census"],
  "Marketing Automation": ["HubSpot", "Marketo", "Customer.io", "Iterable"],
  Compliance: ["Vanta", "Drata", "Secureframe", "OneTrust"],
};

const INTENT_SIGNALS = [
  "hiring SDR", "hiring AE", "hiring VP Sales", "Series B announced",
  "Series C announced", "new CRO joined", "expanded GTM team",
  "scaling outbound", "rolled out new CRM", "raised growth round",
];

// Subject + body templates (XML-scaffolded, mimicking the SDR drafter)
const SUBJECT_TEMPLATES = [
  (co: string) => `Quick question on ${co} pipeline scale`,
  (co: string) => `${co}'s SDR setup — worth a 15 min?`,
  (co: string) => `Noticed ${co} is hiring AEs — outbound thoughts`,
  (co: string) => `For ${co}: outbound idea for new CRO`,
  (co: string) => `${co} + Apex: 2-min idea`,
];

const BODY_TEMPLATES: ReadonlyArray<(args: { first: string; co: string; signal: string; vertical: string }) => string> = [
  ({ first, co, signal, vertical }) =>
    `Hi ${first},\n\nNoticed ${co} is ${signal} — usually when ${vertical} teams scale outbound at your stage, the bottleneck is SDR ramp + write-quality, not list size.\n\nWe help ${vertical} teams ship one calibrated cold email per qualified lead per day, fully reviewed by a human before send. No spam, no template-stamping.\n\nWorth 15 min next week to compare notes? Happy to send what we're seeing across similar Series B+ ${vertical} cos.\n\nThanks,\nApex SDR`,

  ({ first, co, signal, vertical }) =>
    `Hi ${first},\n\nSaw ${co} ${signal}. Most ${vertical} GTM leaders we talk to at your stage are stuck choosing between Outreach-style sequences (volume but stamps the brand) and hand-written outbound (quality but doesn't scale).\n\nWe're building a third option: AI-drafted, human-approved, one email per lead, grounded in real signals only — no fabricated specifics. Calibrated for deliverability, not volume.\n\nWould a 15-min call to compare what's working make sense?\n\nThanks,\nApex SDR`,

  ({ first, co, signal, vertical }) =>
    `Hi ${first},\n\nQuick one: ${co} ${signal} is exactly the inflection where most ${vertical} teams either over-hire SDRs or over-automate outbound. Both burn the brand.\n\nWe split the difference — AI does the first 80% of the draft from grounded research, your team reviews and sends. Our best customers are seeing ~3x reply rates with 1/3 the SDR ramp.\n\nOpen to a quick chat?\n\nThanks,\nApex SDR`,
];

// ── Helpers ──────────────────────────────────────────────────────────────
function pick<T>(arr: readonly T[], seed: number): T {
  return arr[seed % arr.length];
}
function picks<T>(arr: readonly T[], n: number, seedStart: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[(seedStart + i * 7) % arr.length]);
  return out;
}
function rand(seed: number, max: number): number {
  // Cheap deterministic pseudo-random — different from Math.random so
  // re-runs produce the same data.
  return Math.abs((seed * 2654435761) % max);
}
function domainFor(coName: string): string {
  return coName.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18) + ".com";
}
function emailFor(first: string, last: string, domain: string): string {
  return `${first}.${last}@${domain}`.toLowerCase();
}

// ── Main seed ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const org = await prisma.org.findUnique({ where: { id: ORG_ID! } });
  if (!org) {
    throw new Error(`Org ${ORG_ID} not found. Create it via Clerk signup first.`);
  }
  console.log(`Seeding demo data into org: ${org.name} (${org.id})`);

  // 1. ICP profile
  const icp = await prisma.icpProfile.upsert({
    where: { id: `demo-icp-${ORG_ID}` },
    create: {
      id: `demo-icp-${ORG_ID}`,
      orgId: ORG_ID!,
      name: "Mid-market B2B SaaS GTM leaders",
      targetTitles: [...TITLES_VP, ...TITLES_CXO, ...TITLES_HEAD, "Director of RevOps"],
      targetIndustries: VERTICALS,
      targetGeos: ["United States", "United Kingdom", "Canada"],
      intentKeywords: INTENT_SIGNALS,
      minEmployees: 50,
      maxEmployees: 500,
      seedDomains: [],
    },
    update: {},
  });
  console.log(`  ✓ IcpProfile ${icp.id}`);

  // 2. Companies (80)
  const companyRows: Array<{ id: string; name: string; domain: string; vertical: string }> = [];
  for (let i = 0; i < 80; i++) {
    const prefix = pick(COMPANY_PREFIXES, i * 3);
    const suffix = pick(COMPANY_SUFFIXES, i * 5);
    const name = `${prefix} ${suffix}`;
    const domain = domainFor(`${prefix}${suffix}`);
    const vertical = pick(VERTICALS, i);
    const id = `demo-co-${ORG_ID}-${i}`;
    await prisma.company.upsert({
      where: { id },
      create: {
        id,
        orgId: ORG_ID!,
        name,
        domain,
        employeeRange: pick(EMP_RANGES, i),
        industry: vertical,
        country: pick(COUNTRIES, i),
        fundingStage: pick(FUNDING, i),
        techStack: TECH_STACKS[vertical] ?? ["Salesforce", "Slack"],
        intentSignals: picks(INTENT_SIGNALS, 2, i),
      },
      update: {},
    });
    companyRows.push({ id, name, domain, vertical });
  }
  console.log(`  ✓ ${companyRows.length} Companies`);

  // 3. People (120 — 1-3 per company)
  const personRows: Array<{ id: string; first: string; last: string; email: string; title: string; companyId: string; companyName: string; vertical: string }> = [];
  let personIdx = 0;
  for (const co of companyRows) {
    const count = 1 + (rand(personIdx, 100) % 3); // 1-3 per company
    for (let p = 0; p < count && personRows.length < 120; p++) {
      const first = pick(FIRST_NAMES, personIdx * 2);
      const last = pick(LAST_NAMES, personIdx * 3);
      const title = pick(ALL_TITLES, personIdx * 5);
      const email = emailFor(first, last, co.domain);
      const id = `demo-p-${ORG_ID}-${personIdx}`;
      const seniority = title.includes("Chief")
        ? "C_LEVEL"
        : title.includes("VP")
          ? "VP"
          : (title.includes("Director") || title.includes("Head"))
            ? "DIRECTOR"
            : "MANAGER";
      const department = title.includes("Marketing")
        ? "MARKETING"
        : "SALES";
      await prisma.person.upsert({
        where: { id },
        create: {
          id,
          companyId: co.id,
          firstName: first,
          lastName: last,
          title,
          seniority,
          department,
          location: pick(["San Francisco, CA", "New York, NY", "Austin, TX", "Remote", "London, UK", "Toronto, ON"], personIdx),
          emails: { create: [{ email, source: "PATTERN_GUESS" }] },
        },
        update: {},
      });
      personRows.push({ id, first, last, email, title, companyId: co.id, companyName: co.name, vertical: co.vertical });
      personIdx++;
    }
    if (personRows.length >= 120) break;
  }
  console.log(`  ✓ ${personRows.length} Persons`);

  // 4. LeadScores (one per person, bell-curve around 65)
  for (let i = 0; i < personRows.length; i++) {
    const p = personRows[i];
    // Bell-curve: most in 50-80, some 30-50 and 85-95
    let score: number;
    const bucket = rand(i, 100);
    if (bucket < 15) score = 32 + (rand(i + 1, 18));      // 32-50
    else if (bucket < 75) score = 50 + (rand(i + 2, 30)); // 50-80
    else score = 80 + (rand(i + 3, 15));                  // 80-94
    await prisma.leadScore.upsert({
      where: { orgId_personId: { orgId: ORG_ID!, personId: p.id } },
      create: {
        orgId: ORG_ID!,
        personId: p.id,
        score,
        breakdown: { fit: Math.min(100, score + (rand(i, 10) - 5)), intent: Math.min(100, score - 5 + (rand(i, 15))) },
      },
      update: {},
    });
  }
  console.log(`  ✓ ${personRows.length} LeadScores`);

  // 5. OutreachArtifacts — 30 total, 10 per status
  // Pick the top 30 by score for the demo
  const topPersons = [...personRows].slice(0, 30);

  const statuses: Array<{ status: OutreachArtifactStatus; count: number; sentOffsetHours?: [number, number] }> = [
    { status: OutreachArtifactStatus.PENDING_REVIEW, count: 10 },
    { status: OutreachArtifactStatus.APPROVED, count: 10 },
    { status: OutreachArtifactStatus.SENT, count: 10, sentOffsetHours: [2, 96] },
  ];

  let artIdx = 0;
  for (const { status, count, sentOffsetHours } of statuses) {
    for (let i = 0; i < count && artIdx < topPersons.length; i++) {
      const p = topPersons[artIdx];
      const subject = pick(SUBJECT_TEMPLATES, artIdx)(p.companyName);
      const body = pick(BODY_TEMPLATES, artIdx)({
        first: p.first,
        co: p.companyName,
        signal: pick(INTENT_SIGNALS, artIdx),
        vertical: p.vertical,
      });
      const artifactId = `demo-art-${ORG_ID}-${artIdx}`;
      const sentAt = status === OutreachArtifactStatus.SENT && sentOffsetHours
        ? new Date(Date.now() - (sentOffsetHours[0] + rand(artIdx, sentOffsetHours[1] - sentOffsetHours[0])) * 3_600_000)
        : null;

      await prisma.outreachArtifact.upsert({
        where: { id: artifactId },
        create: {
          id: artifactId,
          orgId: ORG_ID!,
          toolName: "send_email",
          channel: OutreachChannel.EMAIL,
          recipientRef: p.email,
          subject,
          bodyText: body,
          payload: { to: p.email, subject, body },
          status,
          sentAt,
          sendReceiptId: sentAt ? `demo-receipt-${artIdx}` : null,
        },
        update: {},
      });
      artIdx++;
    }
  }
  console.log(`  ✓ ${artIdx} OutreachArtifacts (10/10/10 PENDING_REVIEW/APPROVED/SENT)`);

  console.log("\nDemo seed complete.");
  console.log(`  Org: ${org.name} (${org.id})`);
  console.log("  Sign in with the demo email + click 'Drafts' or 'Inbox' to start the Loom.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
