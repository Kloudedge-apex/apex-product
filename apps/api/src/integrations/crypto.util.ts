import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

let cachedKey: Buffer | null = null;
let devFallbackWarned = false;

/**
 * Resolve the 32-byte key used for AES-256-GCM token encryption.
 *
 * In production, ENCRYPTION_KEY is REQUIRED — we refuse to derive a key from
 * a known-default passphrase, which would make every stored OAuth token
 * effectively plaintext. The check is fail-fast at first use: if NODE_ENV is
 * "production" AND ENCRYPTION_KEY is missing/empty/shorter than 32 chars we
 * throw a loud FATAL error so the container crash-loops instead of writing
 * data encrypted under a known key.
 *
 * In non-production, fall back to a deterministic dev key so local dev/test
 * keeps working. We emit a one-time warning so the fallback is visible in
 * the logs and nobody ships it by accident.
 */
function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw: string = process.env.ENCRYPTION_KEY ?? "";
  const isProd = process.env.NODE_ENV === "production";

  if (isProd) {
    if (raw.length < 32) {
      throw new Error(
        "FATAL: ENCRYPTION_KEY env var required in production " +
          "(must be at least 32 chars; recommended: 64 hex chars / 32 bytes).",
      );
    }
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
      cachedKey = Buffer.from(raw, "hex");
      return cachedKey;
    }
    // Production with a long-but-not-hex key: reject. scrypt over a passphrase
    // is weaker than a random 32-byte key and we want operators to provide a
    // proper hex secret in prod.
    throw new Error(
      "FATAL: ENCRYPTION_KEY env var required in production " +
        "(must be a 64-character hex string; refusing to derive a key from a passphrase).",
    );
  }

  // Non-production path.
  if (raw.length === 0) {
    if (!devFallbackWarned) {
      devFallbackWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[crypto] ENCRYPTION_KEY unset — using deterministic dev fallback. " +
          "This is only safe outside production. Set ENCRYPTION_KEY to a 64-char hex string " +
          "to silence this warning.",
      );
    }
    cachedKey = crypto.scryptSync("apex-dev-key", "salt", 32);
    return cachedKey;
  }

  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    cachedKey = Buffer.from(raw, "hex");
    return cachedKey;
  }

  // Non-production passphrase form — derive via scrypt.
  cachedKey = crypto.scryptSync(raw, "apex-salt", 32);
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function encryptCredentials(credentials: Record<string, unknown>): string {
  return encrypt(JSON.stringify(credentials));
}

/**
 * Decrypts a credentials blob. Throws on any failure — callers must handle.
 *
 * Previously this returned `{ raw: ciphertext }` on failure, which silently
 * leaked ciphertext into downstream code paths. Failing loud surfaces stale
 * data and configuration drift instead of corrupting downstream calls with
 * unparseable "credentials".
 */
export function decryptCredentials(encrypted: string): Record<string, unknown> {
  const json = decrypt(encrypted);
  return JSON.parse(json) as Record<string, unknown>;
}

/** Test helper — resets the memoized key and warn-once flag for a fresh env. */
export function _resetCryptoKeyCacheForTests(): void {
  cachedKey = null;
  devFallbackWarned = false;
}
