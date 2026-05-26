import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encrypt,
  decrypt,
  encryptCredentials,
  decryptCredentials,
  _resetCryptoKeyCacheForTests,
} from "../crypto.util";

const HEX_KEY = "a".repeat(64);

describe("crypto.util — key resolution", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetCryptoKeyCacheForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetCryptoKeyCacheForTests();
    vi.restoreAllMocks();
  });

  it("production + missing key → throws FATAL", () => {
    process.env = { ...originalEnv, NODE_ENV: "production" } as NodeJS.ProcessEnv;
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("hello")).toThrow(
      /FATAL: ENCRYPTION_KEY env var required in production/,
    );
  });

  it("production + empty key → throws FATAL", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      ENCRYPTION_KEY: "",
    } as NodeJS.ProcessEnv;
    expect(() => encrypt("hello")).toThrow(
      /FATAL: ENCRYPTION_KEY env var required in production/,
    );
  });

  it("production + too-short key (<32 chars) → throws FATAL", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      ENCRYPTION_KEY: "x".repeat(31),
    } as NodeJS.ProcessEnv;
    expect(() => encrypt("hello")).toThrow(
      /FATAL: ENCRYPTION_KEY env var required in production/,
    );
  });

  it("production + valid 64-char hex key → encrypt/decrypt roundtrip", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      ENCRYPTION_KEY: HEX_KEY,
    } as NodeJS.ProcessEnv;

    const plaintext = "refresh-token-from-hubspot-abcdef";
    const ct = encrypt(plaintext);
    expect(ct).not.toContain(plaintext);
    expect(decrypt(ct)).toBe(plaintext);
  });

  it("production + 32+ char non-hex passphrase → throws FATAL (no scrypt fallback)", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      ENCRYPTION_KEY: "this-is-a-long-passphrase-but-not-hex",
    } as NodeJS.ProcessEnv;
    expect(() => encrypt("hello")).toThrow(/FATAL/);
  });

  it("dev + missing key → encrypts via dev fallback and warns once", () => {
    process.env = { ...originalEnv, NODE_ENV: "development" } as NodeJS.ProcessEnv;
    delete process.env.ENCRYPTION_KEY;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ct1 = encrypt("dev-secret-1");
    expect(decrypt(ct1)).toBe("dev-secret-1");
    const ct2 = encrypt("dev-secret-2");
    expect(decrypt(ct2)).toBe("dev-secret-2");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(
      /ENCRYPTION_KEY unset.*dev fallback/i,
    );
  });

  it("dev + valid hex key → uses hex key (no warning)", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      ENCRYPTION_KEY: HEX_KEY,
    } as NodeJS.ProcessEnv;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ct = encrypt("hello-dev");
    expect(decrypt(ct)).toBe("hello-dev");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("crypto.util — decryptCredentials throws on corruption", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetCryptoKeyCacheForTests();
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      ENCRYPTION_KEY: HEX_KEY,
    } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetCryptoKeyCacheForTests();
  });

  it("roundtrips a credentials object", () => {
    const creds = { access_token: "at_123", refresh_token: "rt_456", expires_at: 1 };
    const ct = encryptCredentials(creds);
    expect(decryptCredentials(ct)).toEqual(creds);
  });

  it("throws on malformed ciphertext (wrong segment count)", () => {
    expect(() => decryptCredentials("not-a-real-ciphertext")).toThrow(
      /Invalid encrypted data format/,
    );
  });

  it("throws on tampered ciphertext (auth tag mismatch)", () => {
    const ct = encryptCredentials({ token: "abc" });
    const parts = ct.split(":");
    // Flip a byte in the encrypted payload — GCM auth must catch this.
    const tampered = `${parts[0]}:${parts[1]}:${parts[2].replace(/^./, (c) =>
      c === "0" ? "1" : "0",
    )}`;
    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it("throws on ciphertext encrypted under a different key", () => {
    const ct = encryptCredentials({ token: "abc" });
    // Rotate the key — decryption must fail loudly, not return { raw: ct }.
    process.env.ENCRYPTION_KEY = "b".repeat(64);
    _resetCryptoKeyCacheForTests();
    expect(() => decryptCredentials(ct)).toThrow();
  });

  it("throws when decrypted payload is not valid JSON", () => {
    // Encrypt non-JSON via the lower-level primitive, then ask decryptCredentials
    // to parse it — JSON.parse should throw.
    const ct = encrypt("not-json-at-all");
    expect(() => decryptCredentials(ct)).toThrow();
  });
});
