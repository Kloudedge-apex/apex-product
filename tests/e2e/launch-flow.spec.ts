/**
 * Launch-flow E2E: org bootstrap → ICP → SDR agent → pipeline → HITL approve →
 * outreach artifact, exercised twice to cover both `exclusions` shapes from
 * the recent type-union fix (string[] AND newline-delimited string).
 *
 * Runtime requirements (see PR_NOTES.md > "E2E launch-flow spec"):
 *   - API running on E2E_API_BASE_URL (default http://localhost:4000) with
 *     NODE_ENV != "production", ALLOW_DEV_ORG_HEADER=true, and CLERK_DOMAIN
 *     / CLERK_JWKS_URL UNSET. Under those conditions OrgScopeGuard accepts
 *     an `x-org-id` header instead of a verified Clerk JWT.
 *   - DATABASE_URL pointing at a Postgres the worker can also reach — the
 *     spec seeds an Org row directly because POST /api/orgs is
 *     @SkipOrgGuard() and demands a real Bearer token even in dev.
 *   - LangGraph worker (apex-gtm-worker / `pnpm dev` covers it via Turbo)
 *     running against the same DB+Redis so the graph actually advances to
 *     AWAITING_APPROVAL and produces outreach artifacts after approve.
 *
 * The spec never drives a browser — Clerk auth has no test harness on this
 * branch and the canonical happy-path is API-only.
 */
import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { prisma } from "@apex/db";
import { getDevApiContext } from "./fixtures/clerk-dev-fixture";

const APPROVAL_TIMEOUT_MS = 90_000;
const ARTIFACT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

type GraphRunStatus =
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

interface GraphRunPayload {
  id: string;
  status: GraphRunStatus;
  currentNode: string | null;
  error: string | null;
}

interface OutreachArtifactPayload {
  id: string;
  status:
    | "DRAFT"
    | "PENDING_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "SENT"
    | "SUPPRESSED";
}

const ACCEPTABLE_ARTIFACT_STATES: ReadonlyArray<OutreachArtifactPayload["status"]> = [
  "PENDING_REVIEW",
  "APPROVED",
  "SENT",
  "SUPPRESSED",
];

interface IcpResponse {
  id: string;
}

interface AgentResponse {
  id: string;
}

interface PipelineRunResponse {
  graphRunId: string | null;
}

/** Generate a random alphanumeric suffix safe for slugs / org names. */
function rand(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/**
 * Seed an Org row plus the matching AgentTemplate for the SDR slug so the
 * spec can create agents without round-tripping the GET /templates lazy-seed
 * path. Returns both ids.
 */
async function seedOrgAndSdrTemplate(): Promise<{
  orgId: string;
  templateId: string;
}> {
  const slug = rand("e2e-launch");
  const org = await prisma.org.create({
    data: {
      name: `E2E ${slug}`,
      slug,
      plan: "TRIAL",
      trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });

  const existing = await prisma.agentTemplate.findFirst({
    where: { name: "SDR Agent", domain: "SALES" },
    select: { id: true },
  });
  const template =
    existing ??
    (await prisma.agentTemplate.create({
      data: {
        name: "SDR Agent",
        domain: "SALES",
        description: "E2E-seeded SDR template",
        defaultConfig: {},
        requiredIntegrations: ["email", "crm"],
      },
      select: { id: true },
    }));

  return { orgId: org.id, templateId: template.id };
}

/** Best-effort tear-down. Cascades wipe runs / artifacts / agents. */
async function deleteOrg(orgId: string): Promise<void> {
  try {
    await prisma.org.delete({ where: { id: orgId } });
  } catch {
    // Org was already gone or test never created it — fine.
  }
}

/**
 * Create the ICP profile the supervisor will source against. seedDomains is a
 * `String[]` column on `IcpProfile`, so we always send an array (matches the
 * recent `seedDomains must be String[] not String` hotfix).
 */
async function createIcp(api: APIRequestContext, name: string): Promise<string> {
  const res = await api.post("/api/leads/icp", {
    data: {
      name,
      targetTitles: ["VP Engineering", "Head of Platform"],
      targetIndustries: ["SaaS"],
      targetGeos: ["US"],
      minEmployees: 50,
      maxEmployees: 500,
      seedDomains: ["stripe.com", "linear.app"],
    },
  });
  expect(res.status(), `ICP create failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as IcpResponse;
  expect(body.id).toBeTruthy();
  return body.id;
}

/**
 * Create an SDR agent with the given exclusions payload. The agents config is
 * a Prisma JSON column, so we drop the union value through unchanged — this
 * is exactly what the type-union fix at the controller layer guards.
 */
async function createSdrAgent(
  api: APIRequestContext,
  templateId: string,
  name: string,
  exclusions: string | string[],
): Promise<string> {
  const res = await api.post("/api/agents", {
    data: {
      templateId,
      name,
      domain: "SALES",
      config: {
        model: "gpt-4o",
        dailyEmailLimit: 5,
        exclusions,
        dryRun: true,
      },
    },
  });
  expect(res.status(), `Agent create failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as AgentResponse;
  expect(body.id).toBeTruthy();
  return body.id;
}

/**
 * Kick the supervisor. /pipeline/run returns 202 with the graphRunId we will
 * poll. The endpoint is best-effort about ICP fan-out, but with one freshly
 * created ICP we expect a graphRunId back.
 */
async function triggerPipelineRun(api: APIRequestContext): Promise<string> {
  const res = await api.post("/api/pipeline/run", { data: {} });
  expect(res.status(), `pipeline/run failed: ${await res.text()}`).toBe(202);
  const body = (await res.json()) as PipelineRunResponse;
  expect(
    body.graphRunId,
    `pipeline/run returned no graphRunId: ${JSON.stringify(body)}`,
  ).not.toBeNull();
  return body.graphRunId as string;
}

async function fetchGraphRun(
  api: APIRequestContext,
  runId: string,
): Promise<GraphRunPayload> {
  const res = await api.get(`/api/graph/runs/${runId}`);
  expect(res.ok(), `GET graph run failed: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as GraphRunPayload;
}

async function fetchArtifacts(
  api: APIRequestContext,
  runId: string,
): Promise<OutreachArtifactPayload[]> {
  const res = await api.get(`/api/graph/runs/${runId}/outreach-artifacts`);
  expect(
    res.ok(),
    `GET outreach-artifacts failed: ${await res.text()}`,
  ).toBeTruthy();
  return (await res.json()) as OutreachArtifactPayload[];
}

async function approveGraphRun(
  api: APIRequestContext,
  runId: string,
): Promise<void> {
  const res = await api.post(`/api/graph/runs/${runId}/approve`, {
    data: { approvedBy: "e2e-test" },
  });
  expect(res.ok(), `approve failed: ${await res.text()}`).toBeTruthy();
}

/**
 * The shared body of both scenarios. Parameterised on the exclusions shape so
 * the same canonical happy-path drives both test cases.
 */
async function runLaunchFlow(
  api: APIRequestContext,
  templateId: string,
  scenarioTag: string,
  exclusions: string | string[],
): Promise<void> {
  await createIcp(api, rand(`icp-${scenarioTag}`));
  await createSdrAgent(
    api,
    templateId,
    rand(`sdr-${scenarioTag}`),
    exclusions,
  );

  const runId = await triggerPipelineRun(api);

  await expect
    .poll(
      async () => {
        const run = await fetchGraphRun(api, runId);
        if (run.status === "FAILED") {
          throw new Error(
            `Graph run ${runId} failed before reaching approval: ${
              run.error ?? "no error message"
            }`,
          );
        }
        return run.status;
      },
      {
        timeout: APPROVAL_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS],
        message: `Graph run ${runId} never reached AWAITING_APPROVAL`,
      },
    )
    .toBe("AWAITING_APPROVAL");

  await approveGraphRun(api, runId);

  // Poll the artifact count, then re-fetch for state assertions. We don't
  // grab the value out of `poll` because Playwright's API returns void —
  // re-fetching is cheaper than threading state through a shared variable.
  await expect
    .poll(
      async () => (await fetchArtifacts(api, runId)).length,
      {
        timeout: ARTIFACT_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS],
        message: `No outreach artifacts surfaced for run ${runId}`,
      },
    )
    .toBeGreaterThan(0);

  const finalArtifacts = await fetchArtifacts(api, runId);
  for (const artifact of finalArtifacts) {
    expect(
      ACCEPTABLE_ARTIFACT_STATES,
      `Artifact ${artifact.id} in unexpected state ${artifact.status}`,
    ).toContain(artifact.status);
  }
}

/**
 * Each scenario gets its OWN org. The pipeline service is single-flight per
 * org (ConflictException if `RUNNING` / `AWAITING_APPROVAL` exists), so two
 * runs against the same org would race under `fullyParallel: true`.
 */
test.describe("launch flow — pipeline + HITL + outreach artifact", () => {
  // 90s for AWAITING_APPROVAL + 60s for artifact + headroom for setup.
  test.setTimeout(APPROVAL_TIMEOUT_MS + ARTIFACT_TIMEOUT_MS + 60_000);

  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  for (const scenario of [
    {
      tag: "arr",
      title: "exclusions as string[] reaches outreach artifact",
      exclusions: ["blocked1.com", "blocked2.com"] as string[],
    },
    {
      tag: "str",
      title: "exclusions as newline-delimited string reaches outreach artifact",
      exclusions: "blocked1.com\nblocked2.com",
    },
  ]) {
    test(scenario.title, async () => {
      const { orgId, templateId } = await seedOrgAndSdrTemplate();
      const api = await getDevApiContext({ orgId });
      try {
        await runLaunchFlow(api, templateId, scenario.tag, scenario.exclusions);
      } finally {
        await api.dispose();
        await deleteOrg(orgId);
      }
    });
  }
});
