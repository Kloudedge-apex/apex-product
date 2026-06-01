import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

export class SsrfGuardError extends Error {
  readonly name = "SsrfGuardError";
  constructor(message: string) {
    super(message);
  }
}

export type DnsLookupAll = (hostname: string) => Promise<readonly LookupAddress[]>;

export interface SsrfGuardOptions {
  /**
   * Optional hostname allowlist. If omitted, defaults to an env-configured
   * allowlist in production (see SSRF_GUARD_HOSTNAME_ALLOWLIST).
   */
  hostnameAllowlist?: readonly string[] | undefined;
  /** DNS resolver seam for tests. Defaults to node:dns/promises lookup({ all: true }). */
  lookupAll?: DnsLookupAll | undefined;
  /** Env seam for tests. */
  env?: NodeJS.ProcessEnv | undefined;
}

export interface SsrfGuardedFetchOptions extends SsrfGuardOptions {
  /** Manual redirect follow limit. Default 5. */
  maxRedirects?: number | undefined;
  /**
   * Fetcher seam for tests and for wiring retries. Defaults to global fetch.
   * Must be called with `redirect: "manual"` (this wrapper enforces it).
   */
  fetcher?: (url: URL, init: RequestInit) => Promise<Response>;
}

function defaultLookupAll(hostname: string): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function parseAllowlistCsv(value: string): string[] {
  return value
    .split(/[,\n]/g)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 0);
}

function getProdHostnameAllowlist(env: NodeJS.ProcessEnv): string[] | undefined {
  if (env.NODE_ENV !== "production") return undefined;
  const raw = env.SSRF_GUARD_HOSTNAME_ALLOWLIST;
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = parseAllowlistCsv(raw);
  return parsed.length > 0 ? parsed : undefined;
}

function hostnameMatchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith("*.")) {
      const suffix = e.slice(2);
      return h === suffix || h.endsWith(`.${suffix}`);
    }
    return h === e;
  });
}

export function parseHttpUrlOrThrow(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch (err) {
    throw new SsrfGuardError(`Invalid URL: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfGuardError(`Disallowed URL protocol: ${url.protocol}`);
  }

  if (!url.hostname) {
    throw new SsrfGuardError("URL hostname is required");
  }

  if (url.username || url.password) {
    throw new SsrfGuardError("URL must not contain username/password");
  }

  return url;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const bytes = parts.map((p) => Number.parseInt(p, 10));
  if (bytes.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) return false;

  const [a, b] = bytes;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  return false;
}

function ipv6ToBigInt(input: string): bigint | null {
  let addr = input.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  if (addr.length === 0) return null;

  // Embedded IPv4 (incl. v4-mapped). Convert into two hextets.
  let embeddedIpv4: string | null = null;
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon >= 0) {
      embeddedIpv4 = addr.slice(lastColon + 1);
      addr = addr.slice(0, lastColon) + ":0:0";
    } else {
      return null;
    }
  }

  const parts = addr.split("::");
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(":").filter((x) => x.length > 0) : [];
  const right = parts.length === 2 && parts[1]
    ? parts[1].split(":").filter((x) => x.length > 0)
    : [];

  const total = left.length + right.length;
  if (parts.length === 1) {
    if (total !== 8) return null;
  } else {
    if (total > 8) return null;
  }

  const fill = parts.length === 2 ? 8 - total : 0;
  const hextets = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  if (hextets.length !== 8) return null;

  let value = 0n;
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    value = (value << 16n) + BigInt(Number.parseInt(h, 16));
  }

  if (embeddedIpv4) {
    const v4Parts = embeddedIpv4.split(".").map((p) => Number.parseInt(p, 10));
    if (v4Parts.length !== 4 || v4Parts.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) {
      return null;
    }
    const v4 =
      (BigInt(v4Parts[0]) << 24n) |
      (BigInt(v4Parts[1]) << 16n) |
      (BigInt(v4Parts[2]) << 8n) |
      BigInt(v4Parts[3]);
    // Replace the last 32 bits with the embedded v4.
    value = ((value >> 32n) << 32n) | v4;
  }

  return value;
}

function isBlockedIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === null) return false;

  if (value === 1n) return true; // ::1

  const first16 = Number((value >> 112n) & 0xffffn);
  // fc00::/7 (unique local)
  if ((first16 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local unicast)
  if ((first16 & 0xffc0) === 0xfe80) return true;

  // IPv4-mapped / embedded v4 cases: if last 32 bits are private, block.
  const embeddedV4 = Number(value & 0xffffffffn);
  const v4 = [
    (embeddedV4 >>> 24) & 0xff,
    (embeddedV4 >>> 16) & 0xff,
    (embeddedV4 >>> 8) & 0xff,
    embeddedV4 & 0xff,
  ].join(".");
  if (isBlockedIpv4(v4)) return true;

  return false;
}

export function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return false;
}

function resolveEffectiveAllowlist(opts: SsrfGuardOptions): readonly string[] | undefined {
  if (opts.hostnameAllowlist) return opts.hostnameAllowlist.map((h) => h.toLowerCase());
  const env = opts.env ?? process.env;
  return getProdHostnameAllowlist(env);
}

export async function assertUrlIsPublicHttp(urlInput: string | URL, opts: SsrfGuardOptions = {}): Promise<URL> {
  const url = parseHttpUrlOrThrow(urlInput);

  const allowlist = resolveEffectiveAllowlist(opts);
  if (allowlist && allowlist.length > 0 && !hostnameMatchesAllowlist(url.hostname, allowlist)) {
    throw new SsrfGuardError(`Hostname not in allowlist: ${url.hostname}`);
  }

  const lookupAll = opts.lookupAll ?? defaultLookupAll;
  let results: readonly LookupAddress[];
  try {
    results = await lookupAll(url.hostname);
  } catch (err) {
    throw new SsrfGuardError(
      `DNS lookup failed for ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!results || results.length === 0) {
    throw new SsrfGuardError(`DNS lookup returned no addresses for ${url.hostname}`);
  }

  for (const { address } of results) {
    if (isBlockedIp(address)) {
      throw new SsrfGuardError(`Blocked IP for ${url.hostname}: ${address}`);
    }
  }

  return url;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function shouldSwitchToGetOnRedirect(status: number, method: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  return status === 301 || status === 302 || status === 303;
}

export async function ssrfGuardedFetch(
  input: string | URL,
  init: RequestInit = {},
  opts: SsrfGuardedFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const fetcher = opts.fetcher ?? ((url: URL, requestInit: RequestInit) => fetch(url, requestInit));

  let url = parseHttpUrlOrThrow(input);
  let method = (init.method ?? "GET").toString();
  let body = init.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    url = await assertUrlIsPublicHttp(url, opts);

    const requestInit: RequestInit = {
      ...init,
      method,
      body,
      redirect: "manual",
    };

    const res = await fetcher(url, requestInit);

    if (!isRedirectStatus(res.status)) {
      return res;
    }

    if (hop === maxRedirects) {
      try {
        await res.arrayBuffer();
      } catch {
        /* ignore */
      }
      throw new SsrfGuardError(`Too many redirects (>${maxRedirects})`);
    }

    const location = res.headers.get("location");
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }

    if (!location) {
      return res;
    }

    const next = new URL(location, url);
    url = parseHttpUrlOrThrow(next);

    if (shouldSwitchToGetOnRedirect(res.status, method)) {
      method = "GET";
      body = undefined;
    }
  }

  // Unreachable, but keeps TS happy.
  throw new SsrfGuardError("Redirect loop");
}
