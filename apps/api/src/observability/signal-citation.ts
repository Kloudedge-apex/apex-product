const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SOURCE_URL_LENGTH = 2_048;

/**
 * Return a strict, real calendar date in yyyy-mm-dd form.
 *
 * Date.parse alone is insufficient here: JavaScript normalizes impossible
 * dates such as 2026-02-30 into March instead of rejecting them.
 */
export function normalizeSignalDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  const match = ISO_DATE.exec(candidate);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;

  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return candidate;
}

/** Return a safe absolute HTTP(S) citation URL without embedded credentials. */
export function normalizeSignalSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_SOURCE_URL_LENGTH) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Confidence is persisted as a probability, not an arbitrary score. */
export function normalizeSignalConfidence(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1
    ? value
    : null;
}
