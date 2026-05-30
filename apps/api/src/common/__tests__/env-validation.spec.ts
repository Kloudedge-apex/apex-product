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
    OUTREACH_UNSUBSCRIBE_SECRET: "test_unsub_secret_" + "x".repeat(32),
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
    expect(issues.some((i) => i.includes("ENCRYPTION_KEY is required"))).toBe(true);
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
    expect(issues.some((i) => i.includes("must be \"production\""))).toBe(true);
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
    expect(issues.some((i) => i.includes("OPENAI_API_KEY / AZURE_OPENAI_KEY / ANTHROPIC_API_KEY"))).toBe(true);
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

  it("treats empty-string LLM keys the same as unset", () => {
    const env = baseProdEnv();
    env.OPENAI_API_KEY = "";
    const { issues } = validateEnv(env);
    expect(issues.some((i) => i.includes("OPENAI_API_KEY / AZURE_OPENAI_KEY / ANTHROPIC_API_KEY"))).toBe(true);
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
