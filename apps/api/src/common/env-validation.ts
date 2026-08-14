import * as crypto from "crypto";
import { isIP } from "node:net";
import { Logger } from "@nestjs/common";
import { isWorkerEnabled } from "../runtime/worker.service";
import { resolveApiPublicOrigin } from "../outreach/unsubscribe-token.util";
import {
  DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH,
  DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK,
  DELIVERY_UNKNOWN_WRITE_MODE,
} from "../outreach/outreach-delivery-unknown-compatibility";

/**
 * Fail-fast startup config validator.
 *
 * Called from main.ts BEFORE NestFactory.create so a misconfigured container
 * exits with a clear message instead of silently running with insecure state
 * (e.g. NODE_ENV=development on a prod container, encryption key mismatch
 * between api/worker, missing ADMIN_API_KEY).
 *
 * Validation matrix:
 *
 *   In all environments:
 *     - DATABASE_URL must be set
 *     - ENCRYPTION_KEY must be set and pass crypto.util.ts's format check
 *     - If WORKER_ENABLED=true, REDIS_URL must be set
 *
 *   When REQUIRE_PRODUCTION_ENV=true (set on every deployed Container App):
 *     - NODE_ENV must equal "production"
 *     - ADMIN_API_KEY must be set
 *
 *   When NODE_ENV="production" (i.e. running as a deployed image):
 *     - At least one LLM provider key (OPENAI_API_KEY | AZURE_OPENAI_KEY | ANTHROPIC_API_KEY)
 *     - GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (Gmail OAuth, needed by api + worker)
 *     - METRICS_AUTH_TOKEN (protects the public Prometheus endpoint)
 *
 * Missing prod secrets are collected and reported in a single throw so the
 * operator can fix everything in one redeploy instead of bouncing the pod
 * once per missing var.
 *
 * Never prints the key. Logs a SHA-256 fingerprint (first 8 hex of digest) so
 * api/worker drift shows up in side-by-side logs.
 */

export class EnvValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Environment validation failed:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

interface ValidationResult {
  readonly issues: readonly string[];
  readonly encryptionKeyFingerprint: string | null;
}

/**
 * Pure validator — returns issues instead of throwing. Used directly by tests.
 * Production callers should use validateEnvOrExit which wraps this and throws.
 */
export function validateEnv(
  env: NodeJS.ProcessEnv = process.env,
): ValidationResult {
  const issues: string[] = [];
  const isProd = env.NODE_ENV === "production";
  const requireProd = env.REQUIRE_PRODUCTION_ENV === "true";

  if (!env.DATABASE_URL || env.DATABASE_URL.length === 0) {
    issues.push("DATABASE_URL is required");
  }

  const encryptionKeyFingerprint = checkEncryptionKey(env, isProd, issues);

  if (isWorkerEnabled(env)) {
    if (!env.REDIS_URL || env.REDIS_URL.length === 0) {
      issues.push("REDIS_URL is required when WORKER_ENABLED=true");
    }
  }

  if (requireProd) {
    if (env.NODE_ENV !== "production") {
      issues.push(
        `REQUIRE_PRODUCTION_ENV=true but NODE_ENV="${env.NODE_ENV ?? "<unset>"}" (must be "production")`,
      );
    }
    if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length === 0) {
      issues.push("ADMIN_API_KEY is required when REQUIRE_PRODUCTION_ENV=true");
    }
  }

  const bootstrapAttemptId =
    env.WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID;
  const bootstrapMinimumGeneration =
    env.WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION;
  const bootstrapGuardPartial =
    (bootstrapAttemptId === undefined) !==
    (bootstrapMinimumGeneration === undefined);
  if (bootstrapGuardPartial) {
    issues.push(
      "production bootstrap deployment guard requires both attempt id and minimum generation",
    );
  } else if (
    bootstrapAttemptId !== undefined &&
    bootstrapMinimumGeneration !== undefined
  ) {
    if (!/^[0-9a-f]{32}$/.test(bootstrapAttemptId)) {
      issues.push(
        "WORKFORCE_PRODUCTION_BOOTSTRAP_ATTEMPT_ID must be exactly 32 lowercase hexadecimal characters",
      );
    }
    if (!/^[1-9][0-9]*$/.test(bootstrapMinimumGeneration)) {
      issues.push(
        "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION must be a positive safe integer",
      );
    } else if (!Number.isSafeInteger(Number(bootstrapMinimumGeneration))) {
      issues.push(
        "WORKFORCE_PRODUCTION_BOOTSTRAP_MIN_WRITER_FENCE_GENERATION must be a positive safe integer",
      );
    }
  }
  if (
    isProd &&
    bootstrapAttemptId === undefined &&
    bootstrapMinimumGeneration === undefined
  ) {
    issues.push(
      "production bootstrap deployment guard is required when NODE_ENV=production",
    );
  }

  if (isProd) {
    if (!env.METRICS_AUTH_TOKEN?.trim()) {
      issues.push("METRICS_AUTH_TOKEN is required when NODE_ENV=production");
    }

    let apiPublicOrigin: string | null = null;
    try {
      apiPublicOrigin = resolveApiPublicOrigin(env);
    } catch (err) {
      issues.push(
        err instanceof Error
          ? err.message
          : "API_PUBLIC_URL is invalid for production",
      );
    }

    validateProductionGmailConfiguration(env, apiPublicOrigin, issues);
    validateProductionOAuthConfiguration(env, issues);

    // The remaining required credentials are needed by both the api and the
    // worker. Anything role-specific remains warned-not-thrown so a partial
    // integration config does not take the whole pod down.
    //
    // LLM provider: at least one of OPENAI_API_KEY / AZURE_OPENAI_KEY /
    // ANTHROPIC_API_KEY must be set. Prod uses Azure OpenAI today, but the
    // codepath chooses dynamically.
    const hasAnyLlmKey = [
      "OPENAI_API_KEY",
      "AZURE_OPENAI_KEY",
      "ANTHROPIC_API_KEY",
    ].some((k) => {
      const v = env[k];
      return typeof v === "string" && v.length > 0;
    });
    if (!hasAnyLlmKey) {
      issues.push(
        "At least one of OPENAI_API_KEY / AZURE_OPENAI_KEY / ANTHROPIC_API_KEY must be set when NODE_ENV=production",
      );
    }

    // Gmail OAuth: needed by both api (start oauth flow) and worker
    // (token refresh during send). Names per integrations.service.ts.
    for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
      const value = env[name];
      if (!value || value.length === 0) {
        issues.push(`${name} is required when NODE_ENV=production`);
      }
    }

    // Outreach wildcard guard (GL8c). OUTREACH_LIVE_FOR_ORGS="*" arms live
    // outbound email for EVERY org — refuse to boot a production container
    // with it unless OUTREACH_ALLOW_WILDCARD="true" is set as an explicit,
    // auditable escape hatch. Deployed-env reality check: only the worker
    // Container App carries OUTREACH_LIVE_FOR_ORGS, so this never REQUIRES
    // the var (the api app stays valid with it unset) — it only rejects the
    // wildcard value. Runtime mirror lives in outreach-allowlist.util.ts.
    if (
      env.OUTREACH_LIVE_FOR_ORGS?.trim() === "*" &&
      env.OUTREACH_ALLOW_WILDCARD !== "true"
    ) {
      issues.push(
        'OUTREACH_LIVE_FOR_ORGS="*" enables live outreach for ALL orgs and is refused when NODE_ENV=production. ' +
          "List org ids explicitly, or set OUTREACH_ALLOW_WILDCARD=true to override deliberately.",
      );
    }

    const failedWrites = env.OUTREACH_FAILED_STATUS_WRITES_ENABLED;
    if (
      failedWrites !== undefined &&
      failedWrites !== "true" &&
      failedWrites !== "false"
    ) {
      issues.push(
        "OUTREACH_FAILED_STATUS_WRITES_ENABLED must be exactly true or false when set",
      );
    }
    if (
      failedWrites === "true" &&
      env.OUTREACH_FAILED_STATUS_WRITES_ACK !==
        "readers-drained-legacy-inventory-reviewed-v1"
    ) {
      issues.push(
        "OUTREACH_FAILED_STATUS_WRITES_ENABLED=true requires " +
          "OUTREACH_FAILED_STATUS_WRITES_ACK=readers-drained-legacy-inventory-reviewed-v1",
      );
    }

    const deliveryUnknownMode = env.OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE;
    const deliveryUnknownAck = env.OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK;
    const rollbackCompatibilityEpoch =
      env.OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH;
    const configuredDeliveryUnknownMode =
      deliveryUnknownMode ?? DELIVERY_UNKNOWN_WRITE_MODE.DISABLED;

    if (
      deliveryUnknownMode !== undefined &&
      deliveryUnknownMode !== DELIVERY_UNKNOWN_WRITE_MODE.DISABLED &&
      deliveryUnknownMode !== DELIVERY_UNKNOWN_WRITE_MODE.FIRST_CLASS
    ) {
      issues.push(
        "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE must be disabled or first-class when set",
      );
    }
    if (
      configuredDeliveryUnknownMode ===
        DELIVERY_UNKNOWN_WRITE_MODE.FIRST_CLASS &&
      deliveryUnknownAck !== DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK
    ) {
      issues.push(
        "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=first-class requires " +
          `OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK=${DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK}`,
      );
    }
    if (
      configuredDeliveryUnknownMode === DELIVERY_UNKNOWN_WRITE_MODE.FIRST_CLASS &&
      rollbackCompatibilityEpoch !== DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH
    ) {
      issues.push(
        `OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=${configuredDeliveryUnknownMode} requires ` +
          `OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH=${DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH}`,
      );
    }
    if (
      configuredDeliveryUnknownMode === DELIVERY_UNKNOWN_WRITE_MODE.DISABLED &&
      (deliveryUnknownAck?.trim() || rollbackCompatibilityEpoch?.trim())
    ) {
      issues.push(
        "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=disabled requires OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK and OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH to be empty",
      );
    }
    if (
      env.OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED !== undefined ||
      env.OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK !== undefined
    ) {
      issues.push(
        "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED and OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK are unsupported; use the explicit OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE contract",
      );
    }
  }

  return { issues, encryptionKeyFingerprint };
}

function validateProductionOAuthConfiguration(
  env: NodeJS.ProcessEnv,
  issues: string[],
): void {
  const stateSecret = env.OAUTH_STATE_SECRET;
  if (!stateSecret?.trim()) {
    issues.push("OAUTH_STATE_SECRET is required when NODE_ENV=production");
  } else if (stateSecret !== stateSecret.trim() || stateSecret.length < 32) {
    issues.push(
      "OAUTH_STATE_SECRET must be at least 32 characters with no surrounding whitespace in production",
    );
  }

  const frontendUrl = env.FRONTEND_URL?.trim();
  if (!frontendUrl) {
    issues.push("FRONTEND_URL is required when NODE_ENV=production");
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(frontendUrl);
  } catch {
    issues.push("FRONTEND_URL must be a valid absolute URL");
    return;
  }

  if (parsed.protocol !== "https:") {
    issues.push("FRONTEND_URL must use https in production");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    issues.push(
      "FRONTEND_URL must not contain credentials, a query, or a fragment",
    );
  }
  if (parsed.pathname !== "/") {
    issues.push("FRONTEND_URL path must be empty");
  }
  if (frontendUrl !== parsed.origin) {
    issues.push(
      "FRONTEND_URL must be a canonical origin without a trailing slash",
    );
  }
  if (isNonPublicHostname(parsed.hostname)) {
    issues.push("FRONTEND_URL must use a public DNS hostname in production");
  }
}

function isNonPublicHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!normalized || isIP(normalized) !== 0 || !normalized.includes(".")) {
    return true;
  }

  const reservedSuffixes = [
    "arpa",
    "corp",
    "example",
    "home",
    "internal",
    "invalid",
    "lan",
    "local",
    "localhost",
    "onion",
    "test",
  ];
  if (
    reservedSuffixes.some(
      (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }

  if (normalized.length > 253) return true;
  return normalized
    .split(".")
    .some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}

function validateProductionGmailConfiguration(
  env: NodeJS.ProcessEnv,
  apiPublicOrigin: string | null,
  issues: string[],
): void {
  const expectedRedirectUri = apiPublicOrigin
    ? `${apiPublicOrigin}/api/integrations/gmail/callback`
    : null;
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  if (!redirectUri) {
    issues.push("GOOGLE_REDIRECT_URI is required when NODE_ENV=production");
  } else if (expectedRedirectUri && redirectUri !== expectedRedirectUri) {
    issues.push(
      `GOOGLE_REDIRECT_URI must equal ${expectedRedirectUri} in production`,
    );
  }

  const topic = env.GMAIL_PUBSUB_TOPIC?.trim();
  if (!topic) {
    issues.push("GMAIL_PUBSUB_TOPIC is required when NODE_ENV=production");
  } else if (
    !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(
      topic,
    )
  ) {
    issues.push(
      "GMAIL_PUBSUB_TOPIC must be a canonical projects/<project-id>/topics/<topic-id> resource name",
    );
  }

  const expectedPushAudience = apiPublicOrigin
    ? `${apiPublicOrigin}/api/integrations/gmail/push`
    : null;
  const pushAudience = env.GMAIL_PUSH_AUDIENCE?.trim();
  if (!pushAudience) {
    issues.push("GMAIL_PUSH_AUDIENCE is required when NODE_ENV=production");
  } else if (expectedPushAudience && pushAudience !== expectedPushAudience) {
    issues.push(
      `GMAIL_PUSH_AUDIENCE must equal ${expectedPushAudience} in production`,
    );
  }

  const publisherServiceAccount = env.GMAIL_PUSH_PUBLISHER_SA?.trim();
  if (!publisherServiceAccount) {
    issues.push("GMAIL_PUSH_PUBLISHER_SA is required when NODE_ENV=production");
  } else if (
    !/^[a-z][a-z0-9-]{0,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(
      publisherServiceAccount,
    )
  ) {
    issues.push(
      "GMAIL_PUSH_PUBLISHER_SA must be a canonical Google service-account email",
    );
  }
}

function checkEncryptionKey(
  env: NodeJS.ProcessEnv,
  isProd: boolean,
  issues: string[],
): string | null {
  const raw = env.ENCRYPTION_KEY;
  if (!raw || raw.length === 0) {
    if (!isProd && env.ENCRYPTION_KEY_DEV_FALLBACK === "true") {
      return fingerprintFor("dev-fallback");
    }
    issues.push("ENCRYPTION_KEY is required (64 hex chars / 32 bytes)");
    return null;
  }
  // Must match the same shape crypto.util.ts will accept.
  if (isProd && !(raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw))) {
    issues.push(
      `ENCRYPTION_KEY must be exactly 64 hex characters in production (got length=${raw.length})`,
    );
    return null;
  }
  if (!(raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw))) {
    // Non-prod with passphrase: tolerated by crypto.util.ts via scrypt.
    // Still emit a fingerprint so dev mismatches are debuggable.
    return fingerprintFor(raw);
  }
  return fingerprintFor(raw);
}

/**
 * SHA-256(key) → first 8 hex chars. One-way; cannot reconstruct the key.
 * Stable across processes given the same input. Suitable for cross-container
 * drift detection in logs.
 */
export function fingerprintFor(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function validateEnvOrExit(logger: Logger): void {
  const result = validateEnv();
  if (result.encryptionKeyFingerprint) {
    logger.log(
      `Env validated. ENCRYPTION_KEY fingerprint=${result.encryptionKeyFingerprint} (sha256 prefix)`,
    );
  }
  if (result.issues.length > 0) {
    throw new EnvValidationError(result.issues);
  }
}
