/**
 * Dev-only authentication fixture for the launch-flow E2E spec.
 *
 * The production auth path is Clerk JWTs verified by `OrgScopeGuard`. We do
 * NOT have `@clerk/testing` installed on this branch, so we lean on the
 * documented dev fallback: when the API runs with
 * `ALLOW_DEV_ORG_HEADER=true` and Clerk env vars are unset, the guard accepts
 * an `x-org-id` header in place of a verified JWT.
 *
 * That fallback does NOT cover `POST /api/orgs` itself — that controller is
 * marked `@SkipOrgGuard()` and always demands a real Bearer token. For E2E we
 * sidestep that by seeding the Org row directly via Prisma in `beforeAll` and
 * then exercising every protected route with this header-only client.
 */
import {
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";

const DEFAULT_BASE_URL = "http://localhost:4000";

export interface DevApiContextOptions {
  /** Org id to assert in the `x-org-id` header. */
  orgId: string;
  /**
   * Base URL of the NestJS API. Defaults to `E2E_API_BASE_URL` env, then to
   * `http://localhost:4000` (the value `main.ts` listens on when `API_PORT`
   * is unset).
   */
  baseURL?: string;
}

/**
 * Build a Playwright `APIRequestContext` pre-configured for the dev-org-header
 * auth path. Every request sent through the returned context carries
 * `x-org-id: <orgId>` and `Content-Type: application/json`, so callers can
 * focus on payloads.
 */
export async function getDevApiContext(
  options: DevApiContextOptions,
): Promise<APIRequestContext> {
  const baseURL =
    options.baseURL ?? process.env.E2E_API_BASE_URL ?? DEFAULT_BASE_URL;

  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: {
      "x-org-id": options.orgId,
      "Content-Type": "application/json",
    },
  });
}
