import * as crypto from "node:crypto";

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
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  try {
    return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
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

/**
 * Build the public unsubscribe URL stamped on outbound email
 * `List-Unsubscribe` headers. Reads API_PUBLIC_URL (canonical for the api
 * Container App's externally-routable hostname); falls back to the legacy
 * BASE_URL or http://localhost:3000 for dev.
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
  const base =
    env.API_PUBLIC_URL?.trim() ||
    env.BASE_URL?.trim() ||
    "http://localhost:3000";
  const trimmed = base.replace(/\/+$/, "");
  // Tolerate operators who set API_PUBLIC_URL with the prefix already
  // included — never emit a `/api/api/` double segment.
  const origin = trimmed.endsWith(`/${API_GLOBAL_PREFIX}`)
    ? trimmed.slice(0, -(API_GLOBAL_PREFIX.length + 1))
    : trimmed;
  const token = signUnsubscribeToken({ orgId, recipientRef, env });
  return `${origin}/${API_GLOBAL_PREFIX}/u/${encodeURIComponent(token)}`;
}

/**
 * Build the RFC 8058 `mailto:` unsubscribe target. Most providers (Google,
 * Yahoo) accept either or both; we ship both so dumb clients still work.
 */
export function buildUnsubscribeMailto(
  orgId: string,
  recipientRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const domain = env.UNSUBSCRIBE_MAILTO_DOMAIN?.trim() || "unsubscribe.nikxius.com";
  const token = signUnsubscribeToken({ orgId, recipientRef, env });
  return `unsubscribe+${token}@${domain}`;
}
