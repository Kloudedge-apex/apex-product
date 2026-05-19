import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

let cachedKey: Buffer | null = null;

/**
 * Resolve the 32-byte key used for AES-256-GCM token encryption.
 *
 * In production, ENCRYPTION_KEY is REQUIRED — we refuse to derive a key from
 * a known-default passphrase, which would make every stored OAuth token
 * effectively plaintext.
 *
 * In non-production, allow a deterministic dev key only when the caller has
 * opted in via ENCRYPTION_KEY_DEV_FALLBACK=true. Anything stored under the
 * dev key cannot be migrated, so do not enable this in shared environments.
 */
function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ENCRYPTION_KEY;

  if (!raw || raw.length === 0) {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.ENCRYPTION_KEY_DEV_FALLBACK === "true"
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        "[crypto] ENCRYPTION_KEY unset — using deterministic dev key. " +
        "NEVER enable ENCRYPTION_KEY_DEV_FALLBACK in production.",
      );
      cachedKey = crypto.scryptSync("apex-dev-key", "salt", 32);
      return cachedKey;
    }
    throw new Error(
      "ENCRYPTION_KEY is required. Set it to a 32-byte hex string (64 hex chars). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }

  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    cachedKey = Buffer.from(raw, "hex");
    return cachedKey;
  }

  // Passphrase form — still allowed in non-production. Refuse in production
  // because scrypt-derived keys from short passphrases are weaker than a
  // randomly-generated 32-byte key.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ENCRYPTION_KEY in production must be a 64-character hex string (32 bytes). " +
      "Refusing to derive a key from a passphrase.",
    );
  }
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
 * data and configuration drift.
 */
export function decryptCredentials(encrypted: string): Record<string, unknown> {
  const json = decrypt(encrypted);
  return JSON.parse(json) as Record<string, unknown>;
}

/** Test helper — resets the memoized key so a fresh env can be picked up. */
export function _resetCryptoKeyCacheForTests(): void {
  cachedKey = null;
}
