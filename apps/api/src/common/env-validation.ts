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
 *     - At least one LLM provider key (OPENAI_API_KEY | AZURE_OPENAI_KEY | ANTHROPIC_API_KEY)
 *     - GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (Gmail OAuth, needed by api + worker)
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
    // Hard-fail only on credentials whose absence would crash the very
    // first request and which BOTH the api and the worker need at boot.
    // Anything else is warned-not-thrown so a partial config doesn't take
    // the whole pod down.
    //
    // LLM provider: at least one of OPENAI_API_KEY / AZURE_OPENAI_KEY /
    // ANTHROPIC_API_KEY must be set. Prod uses Azure OpenAI today, but the
    // codepath chooses dynamically.
    const hasAnyLlmKey = ["OPENAI_API_KEY", "AZURE_OPENAI_KEY", "ANTHROPIC_API_KEY"]
      .some((k) => {
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
