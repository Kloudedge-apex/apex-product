import * as crypto from "node:crypto";
import { isIP } from "node:net";

/**
 * One-click unsubscribe token (RFC 8058 / CAN-SPAM List-Unsubscribe-Post).
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>` where:
 *   payload = JSON.stringify({ o: orgId, r: recipientRef, v: 1, t: issuedAtSec })
 *   hmac    = HMAC-SHA256(secret, base64url(payload))
 *
 * The secret is sourced from `UNSUBSCRIBE_HMAC_SECRET` when set, else derived
 * from `ENCRYPTION_KEY` (already a 32-byte secret required at boot — see
 * env-validation.ts). This avoids a new mandatory env var while keeping the
 * unsubscribe URLs unforgeable.
 *
 * Tokens do NOT carry an explicit expiry — RFC 8058 unsubscribe must remain
 * valid for at least 30 days, and operators typically want them to keep
 * working indefinitely so an old archived email still unsubscribes a
 * recipient who finally clicks. The `t` field is recorded for audit only.
 */

const VERSION = 1;
const DEFAULT_FALLBACK_LABEL = "unsubscribe-v1";

interface TokenPayload {
  readonly o: string;
  readonly r: string;
  readonly v: number;
  readonly t: number;
}

export interface VerifiedUnsubscribe {
  readonly orgId: string;
  readonly recipientRef: string;
  readonly issuedAt: Date;
}

function getSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const direct = env.UNSUBSCRIBE_HMAC_SECRET;
  if (typeof direct === "string" && direct.length > 0) {
    return Buffer.from(direct, "utf-8");
  }
  // Fallback: derive from ENCRYPTION_KEY via HKDF-style HMAC. This avoids
  // requiring a new env var while still producing a key that is distinct
  // from the master encryption key (so token leakage cannot be used to
  // forge encrypted payloads, and vice versa).
  const enc = env.ENCRYPTION_KEY;
  if (typeof enc === "string" && enc.length > 0) {
    return crypto.createHmac("sha256", enc).update(DEFAULT_FALLBACK_LABEL).digest();
  }
  throw new Error(
    "Cannot sign unsubscribe token: neither UNSUBSCRIBE_HMAC_SECRET nor ENCRYPTION_KEY is set",
  );
}

function base64urlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  try {
    const decoded = Buffer.from(
      padded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );
    // Reject alternate spellings whose unused trailing bits decode to the
    // same bytes. Tokens have one canonical wire representation, so changing
    // any character is always detected as tampering.
    return base64urlEncode(decoded) === input ? decoded : null;
  } catch {
    return null;
  }
}

export interface SignUnsubscribeTokenInput {
  readonly orgId: string;
  readonly recipientRef: string;
  /** Override clock for tests. */
  readonly nowMs?: number;
  /** Override env for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

export function signUnsubscribeToken(input: SignUnsubscribeTokenInput): string {
  const secret = getSecret(input.env);
  const payload: TokenPayload = {
    o: input.orgId,
    r: input.recipientRef.toLowerCase().trim(),
    v: VERSION,
    t: Math.floor((input.nowMs ?? Date.now()) / 1000),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf-8");
  const payloadB64 = base64urlEncode(payloadBytes);
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const sigB64 = base64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

export function verifyUnsubscribeToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): VerifiedUnsubscribe | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const payloadBytes = base64urlDecode(payloadB64);
  const sigBytes = base64urlDecode(sigB64);
  if (!payloadBytes || !sigBytes) return null;

  let secret: Buffer;
  try {
    secret = getSecret(env);
  } catch {
    return null;
  }
  const expected = crypto.createHmac("sha256", secret).update(payloadB64).digest();

  if (expected.length !== sigBytes.length || !crypto.timingSafeEqual(expected, sigBytes)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== VERSION) return null;
  if (typeof p.o !== "string" || p.o.length === 0) return null;
  if (typeof p.r !== "string" || p.r.length === 0) return null;
  if (typeof p.t !== "number" || !Number.isFinite(p.t)) return null;

  return {
    orgId: p.o,
    recipientRef: p.r,
    issuedAt: new Date(p.t * 1000),
  };
}

/**
 * Global route prefix the Nest app mounts every controller under — main.ts
 * calls `app.setGlobalPrefix("api")`, so the UnsubscribeController's
 * `u/:token` route actually resolves at `/api/u/:token`. Kept as a single
 * constant so the advertised URL and the mounted route cannot drift again
 * (audit B11: the builder used to emit `/u/<token>`, which 404'd in prod).
 */
export const API_GLOBAL_PREFIX = "api";

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
      (suffix) =>
        normalized === suffix || normalized.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }

  if (normalized.length > 253) return true;
  const labels = normalized.split(".");
  return labels.some(
    (label) =>
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

/**
 * Resolve the externally reachable API origin used in compliance links.
 * Production deliberately has no legacy or localhost fallback: a worker must
 * fail before it can send mail carrying an unusable unsubscribe target.
 */
export function resolveApiPublicOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const isProduction = env.NODE_ENV === "production";
  const explicit = env.API_PUBLIC_URL?.trim();
  if (isProduction && !explicit) {
    throw new Error(
      "API_PUBLIC_URL is required when NODE_ENV=production (public HTTPS API origin)",
    );
  }

  const raw = explicit || "http://localhost:3000";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("API_PUBLIC_URL must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("API_PUBLIC_URL must use http or https");
  }
  if (isProduction && parsed.protocol !== "https:") {
    throw new Error("API_PUBLIC_URL must use https in production");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "API_PUBLIC_URL must not contain credentials, a query, or a fragment",
    );
  }

  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/" && path !== `/${API_GLOBAL_PREFIX}`) {
    throw new Error(
      `API_PUBLIC_URL path must be empty or /${API_GLOBAL_PREFIX}`,
    );
  }
  if (isProduction && isNonPublicHostname(parsed.hostname)) {
    throw new Error(
      "API_PUBLIC_URL must use a public DNS hostname in production",
    );
  }

  return parsed.origin;
}

/**
 * Build the public unsubscribe URL stamped on outbound email
 * `List-Unsubscribe` headers. Reads API_PUBLIC_URL (canonical for the api
 * Container App's externally-routable hostname). Production requires that
 * value and rejects an invalid/non-public origin. Development retains only
 * the localhost fallback.
 *
 * The result always carries exactly one `/${API_GLOBAL_PREFIX}` segment:
 * a base that already ends in `/api` is not doubled, a bare hostname gets
 * it appended. This is the URL mailbox providers POST to (RFC 8058), so it
 * must resolve — see UnsubscribeController.
 */
export function buildUnsubscribeUrl(
  orgId: string,
  recipientRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origin = resolveApiPublicOrigin(env);
  const token = signUnsubscribeToken({ orgId, recipientRef, env });
  return `${origin}/${API_GLOBAL_PREFIX}/u/${encodeURIComponent(token)}`;
}
