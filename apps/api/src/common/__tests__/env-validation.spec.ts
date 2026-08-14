import { describe, it, expect, afterEach } from "vitest";
import {
  validateEnv,
  fingerprintFor,
  EnvValidationError,
  validateEnvOrExit,
} from "../env-validation";
import { Logger } from "@nestjs/common";
import {
  encrypt,
  decrypt,
  _resetCryptoKeyCacheForTests,
} from "../../integrations/crypto.util";
import {
  DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH,
  DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK,
  DELIVERY_UNKNOWN_WRITE_MODE,
} from "../../outreach/outreach-delivery-unknown-compatibility";

const HEX_KEY = "a".repeat(64);
const HEX_KEY_2 = "b".repeat(64);

function baseProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    REQUIRE_PRODUCTION_ENV: "true",
    DATABASE_URL: "postgresql://localhost/test",
    ENCRYPTION_KEY: HEX_KEY,
    ADMIN_API_KEY: "admin-secret",
    OPENAI_API_KEY: "sk-test-openai",
    GOOGLE_CLIENT_ID: "gmail-client-id",
    GOOGLE_CLIENT_SECRET: "gmail-client-secret",
    GOOGLE_REDIRECT_URI:
      "https://api.workforceos.xyz/api/integrations/gmail/callback",
    GMAIL_PUBSUB_TOPIC: "projects/workforce-prod/topics/gmail-inbound",
    GMAIL_PUSH_AUDIENCE:
      "https://api.workforceos.xyz/api/integrations/gmail/push",
    GMAIL_PUSH_PUBLISHER_SA:
      "gmail-push@workforce-prod.iam.gserviceaccount.com",
    METRICS_AUTH_TOKEN: "metrics-test-token",
    API_PUBLIC_URL: "https://api.workforceos.xyz",
    OAUTH_STATE_SECRET: "s".repeat(32),
    FRONTEND_URL: "https://workforceos.xyz",
  } as NodeJS.ProcessEnv;
}

describe("validateEnv", () => {
  it("passes with a complete production env", () => {
    const { issues } = validateEnv(baseProdEnv());
    expect(issues).toEqual([]);
  });

  it("fails when DATABASE_URL is missing", () => {
    const env = baseProdEnv();
    delete env.DATABASE_URL;
    const { issues } = validateEnv(env);
    expect(issues).toContain("DATABASE_URL is required");
  });

  it("fails when ENCRYPTION_KEY is missing", () => {
    const env = baseProdEnv();
    delete env.ENCRYPTION_KEY;
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("ENCRYPTION_KEY is required"))).toBe(
      true,
    );
  });

  it("fails when ENCRYPTION_KEY length is wrong in production", () => {
    const env = baseProdEnv();
    env.ENCRYPTION_KEY = "short";
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("64 hex characters"))).toBe(true);
  });

  it("fails when NODE_ENV is not production but REQUIRE_PRODUCTION_ENV=true", () => {
    const env = baseProdEnv();
    env.NODE_ENV = "development";
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes('must be "production"'))).toBe(true);
  });

  it("fails when ADMIN_API_KEY is missing in production", () => {
    const env = baseProdEnv();
    delete env.ADMIN_API_KEY;
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("ADMIN_API_KEY"))).toBe(true);
  });

  it("requires REDIS_URL when WORKER_ENABLED=true", () => {
    const env = baseProdEnv();
    env.WORKER_ENABLED = "true";
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("REDIS_URL"))).toBe(true);
  });

  it("does not require REDIS_URL when WORKER_ENABLED is not set", () => {
    const env = baseProdEnv();
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("REDIS_URL"))).toBe(false);
  });

  it("returns a fingerprint that never includes the raw key", () => {
    const { encryptionKeyFingerprint } = validateEnv(baseProdEnv());
    expect(encryptionKeyFingerprint).toBeTruthy();
    expect(encryptionKeyFingerprint).not.toContain(HEX_KEY);
    expect(encryptionKeyFingerprint?.length).toBe(8);
  });

  it("passes with the minimum prod credential set (1 LLM key + Gmail OAuth)", () => {
    const { issues } = validateEnv(baseProdEnv());
    expect(issues).toEqual([]);
  });

  it("accepts AZURE_OPENAI_KEY as the LLM provider when OPENAI_API_KEY is unset", () => {
    const env = baseProdEnv();
    delete env.OPENAI_API_KEY;
    env.AZURE_OPENAI_KEY = "azure-test-key";
    const { issues } = validateEnv(env);
    expect(issues).toEqual([]);
  });

  it("accepts ANTHROPIC_API_KEY alone as the LLM provider", () => {
    const env = baseProdEnv();
    delete env.OPENAI_API_KEY;
    env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { issues } = validateEnv(env);
    expect(issues).toEqual([]);
  });

  it("fails when no LLM provider key is set in production", () => {
    const env = baseProdEnv();
    delete env.OPENAI_API_KEY;
    const { issues } = validateEnv(env);
    expect(
      issues.some((i) =>
        i.includes("OPENAI_API_KEY / AZURE_OPENAI_KEY / ANTHROPIC_API_KEY"),
      ),
    ).toBe(true);
  });

  it("fails when GOOGLE_CLIENT_ID is missing", () => {
    const env = baseProdEnv();
    delete env.GOOGLE_CLIENT_ID;
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("GOOGLE_CLIENT_ID"))).toBe(true);
  });

  it("fails when GOOGLE_CLIENT_SECRET is missing", () => {
    const env = baseProdEnv();
    delete env.GOOGLE_CLIENT_SECRET;
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("GOOGLE_CLIENT_SECRET"))).toBe(true);
  });

  it.each([undefined, "", "   "])(
    "fails when METRICS_AUTH_TOKEN is %s in production",
    (token) => {
      const env = baseProdEnv();
      if (token === undefined) {
        delete env.METRICS_AUTH_TOKEN;
      } else {
        env.METRICS_AUTH_TOKEN = token;
      }
      const { issues } = validateEnv(env);
      expect(issues).toContain(
        "METRICS_AUTH_TOKEN is required when NODE_ENV=production",
      );
    },
  );

  it("fails when API_PUBLIC_URL is missing in production", () => {
    const env = baseProdEnv();
    delete env.API_PUBLIC_URL;
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("API_PUBLIC_URL is required"))).toBe(
      true,
    );
  });

  it.each([
    ["http://api.workforceos.xyz", "must use https"],
    ["https://localhost", "public DNS hostname"],
    ["https://api.workforceos.xyz/wrong", "path must be empty or /api"],
  ])("fails for invalid production API_PUBLIC_URL %s", (value, message) => {
    const env = baseProdEnv();
    env.API_PUBLIC_URL = value;
    const { issues } = validateEnv(env);
    expect(issues.some((issue) => issue.includes(message))).toBe(true);
  });

  it.each([undefined, "", "   "])(
    "requires a nonblank OAUTH_STATE_SECRET in production (%s)",
    (value) => {
      const env = baseProdEnv();
      if (value === undefined) delete env.OAUTH_STATE_SECRET;
      else env.OAUTH_STATE_SECRET = value;
      const { issues } = validateEnv(env);
      expect(issues).toContain(
        "OAUTH_STATE_SECRET is required when NODE_ENV=production",
      );
    },
  );

  it.each(["short", ` ${"s".repeat(32)}`, `${"s".repeat(32)} `])(
    "rejects weak or noncanonical OAUTH_STATE_SECRET (%s)",
    (value) => {
      const env = baseProdEnv();
      env.OAUTH_STATE_SECRET = value;
      const { issues } = validateEnv(env);
      expect(
        issues.some((issue) =>
          issue.includes("OAUTH_STATE_SECRET must be at least 32 characters"),
        ),
      ).toBe(true);
    },
  );

  it.each([undefined, "", "   "])(
    "requires a nonblank FRONTEND_URL in production (%s)",
    (value) => {
      const env = baseProdEnv();
      if (value === undefined) delete env.FRONTEND_URL;
      else env.FRONTEND_URL = value;
      const { issues } = validateEnv(env);
      expect(issues).toContain(
        "FRONTEND_URL is required when NODE_ENV=production",
      );
    },
  );

  it.each([
    ["http://workforceos.xyz", "must use https"],
    ["https://localhost", "public DNS hostname"],
    ["https://127.0.0.1", "public DNS hostname"],
    ["https://workforceos.xyz/settings", "path must be empty"],
    ["https://workforceos.xyz?next=/settings", "must not contain"],
    ["https://workforceos.xyz/", "canonical origin"],
  ])("rejects noncanonical production FRONTEND_URL %s", (value, message) => {
    const env = baseProdEnv();
    env.FRONTEND_URL = value;
    const { issues } = validateEnv(env);
    expect(issues.some((issue) => issue.includes(message))).toBe(true);
  });

  it.each([
    "GOOGLE_REDIRECT_URI",
    "GMAIL_PUBSUB_TOPIC",
    "GMAIL_PUSH_AUDIENCE",
    "GMAIL_PUSH_PUBLISHER_SA",
  ] as const)("requires nonblank %s in production", (name) => {
    const env = baseProdEnv();
    env[name] = "   ";
    const { issues } = validateEnv(env);
    expect(issues).toContain(`${name} is required when NODE_ENV=production`);
  });

  it.each([
    [
      "GOOGLE_REDIRECT_URI",
      "https://wrong.example/api/integrations/gmail/callback",
      "must equal https://api.workforceos.xyz/api/integrations/gmail/callback",
    ],
    [
      "GMAIL_PUSH_AUDIENCE",
      "https://wrong.example/api/integrations/gmail/push",
      "must equal https://api.workforceos.xyz/api/integrations/gmail/push",
    ],
    ["GMAIL_PUBSUB_TOPIC", "gmail-inbound", "canonical projects/"],
    [
      "GMAIL_PUSH_PUBLISHER_SA",
      "publisher@example.com",
      "canonical Google service-account email",
    ],
  ] as const)("rejects noncanonical %s", (name, value, message) => {
    const env = baseProdEnv();
    env[name] = value;
    const { issues } = validateEnv(env);
    expect(issues.some((issue) => issue.includes(message))).toBe(true);
  });

  it("treats empty-string LLM keys the same as unset", () => {
    const env = baseProdEnv();
    env.OPENAI_API_KEY = "";
    const { issues } = validateEnv(env);
    expect(
      issues.some((i) =>
        i.includes("OPENAI_API_KEY / AZURE_OPENAI_KEY / ANTHROPIC_API_KEY"),
      ),
    ).toBe(true);
  });

  describe("outreach wildcard guard (GL8c)", () => {
    const wildcardIssue = (issues: readonly string[]) =>
      issues.some((i) => i.includes("OUTREACH_LIVE_FOR_ORGS"));

    it("rejects OUTREACH_LIVE_FOR_ORGS='*' in production", () => {
      const env = baseProdEnv();
      env.OUTREACH_LIVE_FOR_ORGS = "*";
      const { issues } = validateEnv(env);
      expect(wildcardIssue(issues)).toBe(true);
    });

    it("rejects a whitespace-padded wildcard too", () => {
      const env = baseProdEnv();
      env.OUTREACH_LIVE_FOR_ORGS = "  *  ";
      const { issues } = validateEnv(env);
      expect(wildcardIssue(issues)).toBe(true);
    });

    it("accepts the wildcard with the explicit OUTREACH_ALLOW_WILDCARD=true escape hatch", () => {
      const env = baseProdEnv();
      env.OUTREACH_LIVE_FOR_ORGS = "*";
      env.OUTREACH_ALLOW_WILDCARD = "true";
      const { issues } = validateEnv(env);
      expect(wildcardIssue(issues)).toBe(false);
    });

    it("accepts an explicit org allowlist in production", () => {
      const env = baseProdEnv();
      env.OUTREACH_LIVE_FOR_ORGS = "tenant-zero,org_pilot_1";
      const { issues } = validateEnv(env);
      expect(wildcardIssue(issues)).toBe(false);
    });

    it("never REQUIRES the var — the api container does not carry it (deployed-env reality check)", () => {
      // baseProdEnv has OUTREACH_LIVE_FOR_ORGS unset, mirroring the api app.
      const { issues } = validateEnv(baseProdEnv());
      expect(wildcardIssue(issues)).toBe(false);
      expect(issues).toEqual([]);
    });

    it("does not reject the wildcard outside production", () => {
      const env: NodeJS.ProcessEnv = {
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost/test",
        ENCRYPTION_KEY: HEX_KEY,
        OUTREACH_LIVE_FOR_ORGS: "*",
      } as NodeJS.ProcessEnv;
      const { issues } = validateEnv(env);
      expect(wildcardIssue(issues)).toBe(false);
    });
  });

  describe("first-class FAILED write rollout gate", () => {
    it("keeps the optional flag disabled by default", () => {
      const { issues } = validateEnv(baseProdEnv());
      expect(issues).toEqual([]);
    });

    it("rejects an invalid boolean value", () => {
      const env = baseProdEnv();
      env.OUTREACH_FAILED_STATUS_WRITES_ENABLED = "yes";
      const { issues } = validateEnv(env);
      expect(
        issues.some((issue) => issue.includes("must be exactly true or false")),
      ).toBe(true);
    });

    it("requires the exact reader-drain and inventory attestation", () => {
      const env = baseProdEnv();
      env.OUTREACH_FAILED_STATUS_WRITES_ENABLED = "true";
      const { issues } = validateEnv(env);
      expect(
        issues.some((issue) =>
          issue.includes("readers-drained-legacy-inventory-reviewed-v1"),
        ),
      ).toBe(true);
    });

    it("accepts the fully attested enablement", () => {
      const env = baseProdEnv();
      env.OUTREACH_FAILED_STATUS_WRITES_ENABLED = "true";
      env.OUTREACH_FAILED_STATUS_WRITES_ACK =
        "readers-drained-legacy-inventory-reviewed-v1";
      const { issues } = validateEnv(env);
      expect(issues).toEqual([]);
    });
  });

  describe("DELIVERY_UNKNOWN write-mode rollback compatibility gate", () => {
    it("defaults to disabled with no writer attestation", () => {
      const { issues } = validateEnv(baseProdEnv());
      expect(issues).toEqual([]);
    });

    it("accepts explicit disabled mode only without an attestation or epoch", () => {
      const env = baseProdEnv();
      env.OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE =
        DELIVERY_UNKNOWN_WRITE_MODE.DISABLED;
      expect(validateEnv(env).issues).toEqual([]);

      env.OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK =
        DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK;
      env.OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH =
        DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH;
      const { issues } = validateEnv(env);
      expect(
        issues.some((issue) =>
          issue.includes(
            "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE=disabled requires",
          ),
        ),
      ).toBe(true);
    });

    it("rejects invalid modes and the removed boolean contract", () => {
      const env = baseProdEnv();
      env.OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE = "compatibility-fallback";
      env.OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED = "false";
      const { issues } = validateEnv(env);
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE must be disabled or first-class",
          ),
          expect.stringContaining(
            "OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ENABLED and OUTREACH_DELIVERY_UNKNOWN_STATUS_WRITES_ACK are unsupported",
          ),
        ]),
      );
    });

    it("requires the exact first-class attestation and compatibility epoch", () => {
      const env = baseProdEnv();
      env.OUTREACH_DELIVERY_UNKNOWN_WRITE_MODE =
        DELIVERY_UNKNOWN_WRITE_MODE.FIRST_CLASS;
      env.OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK = "wrong-ack";
      env.OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH = "wrong-epoch";
      expect(validateEnv(env).issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK=${DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK}`,
          ),
          expect.stringContaining(
            `OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH=${DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH}`,
          ),
        ]),
      );

      env.OUTREACH_DELIVERY_UNKNOWN_WRITE_ACK =
        DELIVERY_UNKNOWN_FIRST_CLASS_WRITE_ACK;
      env.OUTREACH_ROLLBACK_COMPATIBILITY_EPOCH =
        DELIVERY_UNKNOWN_COMPATIBILITY_EPOCH;
      const { issues } = validateEnv(env);
      expect(issues).toEqual([]);
    });
  });

  it("does NOT require prod credentials outside production", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost/test",
      ENCRYPTION_KEY: HEX_KEY,
    } as NodeJS.ProcessEnv;
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("OPENAI_API_KEY"))).toBe(false);
    expect(issues.some((i) => i.includes("GOOGLE_CLIENT_ID"))).toBe(false);
    expect(issues.some((i) => i.includes("GOOGLE_CLIENT_SECRET"))).toBe(false);
    expect(issues.some((i) => i.includes("METRICS_AUTH_TOKEN"))).toBe(false);
    expect(issues.some((i) => i.includes("GOOGLE_REDIRECT_URI"))).toBe(false);
    expect(issues.some((i) => i.includes("GMAIL_PUBSUB_TOPIC"))).toBe(false);
  });
});

describe("fingerprintFor", () => {
  it("produces deterministic 8-char fingerprints", () => {
    expect(fingerprintFor(HEX_KEY)).toBe(fingerprintFor(HEX_KEY));
    expect(fingerprintFor(HEX_KEY).length).toBe(8);
  });

  it("returns different fingerprints for different keys", () => {
    expect(fingerprintFor(HEX_KEY)).not.toBe(fingerprintFor(HEX_KEY_2));
  });

  it("would detect api/worker mismatch when env files differ", () => {
    // Simulates the cross-container parity check: api has one key, worker
    // has another. Fingerprint divergence is observable from logs alone,
    // without ever printing either secret.
    const apiPrint = fingerprintFor(HEX_KEY);
    const workerPrint = fingerprintFor(HEX_KEY_2);
    expect(apiPrint).not.toBe(workerPrint);
  });
});

describe("validateEnvOrExit", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetCryptoKeyCacheForTests();
  });

  it("throws EnvValidationError when env is invalid", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      REQUIRE_PRODUCTION_ENV: "true",
    } as NodeJS.ProcessEnv;
    const logger = new Logger("test");
    expect(() => validateEnvOrExit(logger)).toThrow(EnvValidationError);
  });
});

describe("encryption roundtrip against the configured crypto.util", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    _resetCryptoKeyCacheForTests();
  });

  it("encrypts and decrypts to the same plaintext", () => {
    process.env.ENCRYPTION_KEY = HEX_KEY;
    _resetCryptoKeyCacheForTests();
    const plaintext = "hello-from-the-validator";
    const ct = encrypt(plaintext);
    expect(ct).not.toContain(plaintext);
    expect(decrypt(ct)).toBe(plaintext);
  });
});
