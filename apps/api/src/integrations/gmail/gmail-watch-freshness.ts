/**
 * Gmail returns watch expiration as milliseconds since Unix epoch. Persist the
 * provider value instead of inferring validity from our last renewal attempt:
 * a successful API call can still return a shortened expiration window.
 */
export const GMAIL_WATCH_EXPIRATION_KEY = "watchExpiration";
export const GMAIL_WATCH_MAX_PROVIDER_HORIZON_MS =
  8 * 24 * 60 * 60 * 1000;

export function normalizeGmailWatchExpiration(
  value: unknown,
  now: Date = new Date(),
): string | null {
  const raw =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? String(value)
        : "";
  if (!/^\d+$/.test(raw)) return null;

  const expirationMs = Number(raw);
  if (
    !Number.isSafeInteger(expirationMs) ||
    expirationMs <= now.getTime() ||
    expirationMs > now.getTime() + GMAIL_WATCH_MAX_PROVIDER_HORIZON_MS
  ) {
    return null;
  }
  return String(expirationMs);
}

export function gmailWatchExpiration(
  credentials: unknown,
  now: Date = new Date(),
): string | null {
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    return null;
  }
  return normalizeGmailWatchExpiration(
    (credentials as Record<string, unknown>)[GMAIL_WATCH_EXPIRATION_KEY],
    now,
  );
}

export function isGmailWatchFresh(
  credentials: unknown,
  now: Date = new Date(),
): boolean {
  return gmailWatchExpiration(credentials, now) !== null;
}

export function withGmailWatchExpiration(
  credentials: unknown,
  expiration: string,
): Record<string, unknown> {
  const current =
    credentials &&
    typeof credentials === "object" &&
    !Array.isArray(credentials)
      ? (credentials as Record<string, unknown>)
      : {};
  return {
    ...current,
    [GMAIL_WATCH_EXPIRATION_KEY]: expiration,
  };
}
