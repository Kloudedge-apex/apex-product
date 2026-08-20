import { isIP } from "node:net";

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * Canonicalize an operator-entered or provider-returned web domain.
 * URLs are accepted for usability, but credentials, ports, IP literals, and
 * single-label hosts are rejected so one bad exclusion cannot become an
 * unexpectedly broad or inert sourcing rule.
 */
export function normalizeIcpDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    if (url.username || url.password || url.port) return null;

    const hostname = url.hostname
      .toLowerCase()
      .replace(/\.$/u, "")
      .replace(/^www\./u, "");
    if (
      hostname.length > 253 ||
      !hostname.includes(".") ||
      isIP(hostname) !== 0
    ) {
      return null;
    }

    const labels = hostname.split(".");
    if (labels.some((label) => !DOMAIN_LABEL.test(label))) return null;
    return hostname;
  } catch {
    return null;
  }
}

/** Exact domains and their subdomains are excluded; suffix lookalikes are not. */
export function isIcpExcludedDomain(
  candidate: string,
  exclusions: readonly string[],
): boolean {
  const domain = normalizeIcpDomain(candidate);
  if (!domain) return false;

  return exclusions.some((value) => {
    const excluded = normalizeIcpDomain(value);
    return (
      excluded !== null &&
      (domain === excluded || domain.endsWith(`.${excluded}`))
    );
  });
}
