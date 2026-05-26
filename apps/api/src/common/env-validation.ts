import * as crypto from "crypto";
import { Logger } from "@nestjs/common";
import { isWorkerEnabled } from "../runtime/worker.service";

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
 *     - OPENAI_API_KEY must be set
 *     - ANTHROPIC_API_KEY must be set
 *     - GMAIL_OAUTH_CLIENT_ID must be set
 *     - GMAIL_OAUTH_CLIENT_SECRET must be set
 *     - HUBSPOT_CLIENT_ID must be set
 *     - HUBSPOT_CLIENT_SECRET must be set
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

  if (isProd) {
    // Required third-party credentials. Missing keys would otherwise surface
    // as opaque 500s on the first user request that hits an LLM call or an
    // OAuth start endpoint. Collect all of them so the operator can fix the
    // pod config in one redeploy.
    // NOTE: env names below MUST match what the rest of the codebase actually
    // reads (see apps/api/src/integrations/integrations.service.ts and
    // gmail.service.ts / hubspot.service.ts). The Gmail OAuth client is named
    // GOOGLE_CLIENT_ID/SECRET, not GMAIL_OAUTH_*.
    const REQUIRED_PROD_SECRETS = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "HUBSPOT_CLIENT_ID",
      "HUBSPOT_CLIENT_SECRET",
    ] as const;
    for (const name of REQUIRED_PROD_SECRETS) {
      const value = env[name];
      if (!value || value.length === 0) {
        issues.push(`${name} is required when NODE_ENV=production`);
      }
    }
  }

  return { issues, encryptionKeyFingerprint };
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
