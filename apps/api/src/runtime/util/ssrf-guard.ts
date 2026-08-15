import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { drainResponseBodyWithLimit } from "../../common/http-body.util";

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
  fetcher?: (
    url: URL,
    init: RequestInit,
    pinnedFetch: PinnedFetch,
  ) => Promise<Response>;
}

export type PinnedFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

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

function ipv4Bytes(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number.parseInt(p, 10));
  if (bytes.some((b) => !Number.isFinite(b) || b < 0 || b > 255)) return null;
  return bytes as [number, number, number, number];
}

function isPrivateOrLocalIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return false;

  const [a, b] = bytes;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  return false;
}

/** Deny every IPv4 range that is not ordinary global unicast. */
function isBlockedIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return true;
  const [a, b, c] = bytes;

  if (isPrivateOrLocalIpv4(address)) return true;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified/current host)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 shared space
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark network
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, and limited broadcast
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

function hasIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  return bits === 0 || value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits);
}

function embeddedIpv4(value: bigint): string {
  const embedded = Number(value & 0xffffffffn);
  return [
    (embedded >>> 24) & 0xff,
    (embedded >>> 16) & 0xff,
    (embedded >>> 8) & 0xff,
    embedded & 0xff,
  ].join(".");
}

function isPrivateOrLocalIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === null) return false;

  if (value === 1n) return true; // ::1

  const first16 = Number((value >> 112n) & 0xffffn);
  // fc00::/7 (unique local)
  if ((first16 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (link-local unicast)
  if ((first16 & 0xffc0) === 0xfe80) return true;

  // Only IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96) addresses
  // carry IPv4 semantics. Never classify an arbitrary public IPv6 address by
  // its low 32 bits.
  const upper96 = value >> 32n;
  if (upper96 === 0n || upper96 === 0xffffn) {
    return isPrivateOrLocalIpv4(embeddedIpv4(value));
  }

  return false;
}

function isBlockedIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === null) return true;

  if (value === 0n || isPrivateOrLocalIpv6(address)) return true;

  const upper96 = value >> 32n;
  if (upper96 === 0n || upper96 === 0xffffn) {
    return isBlockedIpv4(embeddedIpv4(value));
  }

  // NAT64 well-known prefix. The embedded target must still be global.
  const nat64Prefix = ipv6ToBigInt("64:ff9b::")!;
  if (hasIpv6Prefix(value, nat64Prefix, 96)) {
    return isBlockedIpv4(embeddedIpv4(value));
  }

  // Fail closed outside today's global-unicast allocation (2000::/3).
  if (value >> 125n !== 1n) return true;

  // Special-purpose/documentation ranges within 2000::/3.
  if (hasIpv6Prefix(value, ipv6ToBigInt("2001::")!, 23)) return true;
  if (hasIpv6Prefix(value, ipv6ToBigInt("2001:db8::")!, 32)) return true;
  if (hasIpv6Prefix(value, ipv6ToBigInt("2002::")!, 16)) return true;
  if (hasIpv6Prefix(value, ipv6ToBigInt("3fff::")!, 20)) return true;

  return false;
}

/** Private/loopback/link-local only; used for immediate proxy trust. */
export function isPrivateOrLocalIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateOrLocalIpv4(address);
  if (family === 6) return isPrivateOrLocalIpv6(address);
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

interface ResolvedPublicHttpUrl {
  url: URL;
  addresses: readonly LookupAddress[];
}

function hostnameForLookup(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

async function resolvePublicHttpUrl(
  urlInput: string | URL,
  opts: SsrfGuardOptions = {},
): Promise<ResolvedPublicHttpUrl> {
  const url = parseHttpUrlOrThrow(urlInput);

  const allowlist = resolveEffectiveAllowlist(opts);
  if (allowlist && allowlist.length > 0 && !hostnameMatchesAllowlist(url.hostname, allowlist)) {
    throw new SsrfGuardError(`Hostname not in allowlist: ${url.hostname}`);
  }

  const lookupHostname = hostnameForLookup(url.hostname);
  const literalFamily = isIP(lookupHostname);
  const lookupAll = opts.lookupAll ?? defaultLookupAll;
  let results: readonly LookupAddress[];
  if (literalFamily === 4 || literalFamily === 6) {
    results = [{ address: lookupHostname, family: literalFamily }];
  } else {
    try {
      results = await lookupAll(lookupHostname);
    } catch (err) {
      throw new SsrfGuardError(
        `DNS lookup failed for ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!results || results.length === 0) {
    throw new SsrfGuardError(`DNS lookup returned no addresses for ${url.hostname}`);
  }
  if (results.length > 32) {
    throw new SsrfGuardError(`DNS lookup returned too many addresses for ${url.hostname}`);
  }

  const addresses: LookupAddress[] = [];
  const seen = new Set<string>();
  for (const { address } of results) {
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new SsrfGuardError(`DNS lookup returned an invalid IP for ${url.hostname}`);
    }
    if (isBlockedIp(address)) {
      throw new SsrfGuardError(`Blocked IP for ${url.hostname}: ${address}`);
    }
    const key = `${family}:${address}`;
    if (!seen.has(key)) {
      seen.add(key);
      addresses.push({ address, family });
    }
  }

  return { url, addresses };
}

export async function assertUrlIsPublicHttp(
  urlInput: string | URL,
  opts: SsrfGuardOptions = {},
): Promise<URL> {
  return (await resolvePublicHttpUrl(urlInput, opts)).url;
}

export function selectPinnedAddress(
  requestedHostname: string,
  validatedHostname: string,
  addresses: readonly LookupAddress[],
): LookupAddress {
  const requested = hostnameForLookup(requestedHostname).toLowerCase();
  const validated = hostnameForLookup(validatedHostname).toLowerCase();
  if (requested !== validated) {
    throw new SsrfGuardError("Pinned DNS lookup hostname did not match the validated hostname");
  }
  const address = addresses[0];
  if (!address) {
    throw new SsrfGuardError("Pinned DNS lookup had no validated address");
  }
  return address;
}

async function closeAgent(agent: Agent): Promise<void> {
  try {
    await agent.close();
  } catch {
    // The request result is already authoritative; cleanup errors are not.
  }
}

function responseWithAgentCleanup(response: Response, agent: Agent): Response {
  if (!response.body) {
    void closeAgent(agent);
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await closeAgent(agent);
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        await closeAgent(agent);
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await closeAgent(agent);
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Build a transport pinned to an already validated DNS snapshot. Callers must
 * obtain `addresses` from `resolvePublicHttpUrl`; exported for connector-level
 * tests that exercise Undici against a local listener.
 */
export function createPinnedFetch(
  validatedUrl: URL,
  addresses: readonly LookupAddress[],
): PinnedFetch {
  return async (input, init = {}) => {
    const requestedUrl = parseHttpUrlOrThrow(input);
    if (requestedUrl.origin !== validatedUrl.origin) {
      throw new SsrfGuardError("Pinned fetch origin did not match the validated origin");
    }

    const agent = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          try {
            selectPinnedAddress(
              hostname,
              validatedUrl.hostname,
              addresses,
            );
            const family = options.family === 4 || options.family === 6
              ? options.family
              : 0;
            const candidates = family === 0
              ? [...addresses]
              : addresses.filter((address) => address.family === family);
            if (candidates.length === 0) {
              const error = new Error("Pinned DNS lookup had no address for the requested family") as NodeJS.ErrnoException;
              error.code = "ENOTFOUND";
              throw error;
            }

            if (options.all) {
              callback(null, candidates);
            } else {
              const address = candidates[0]!;
              callback(null, address.address, address.family);
            }
          } catch (error) {
            if (options.all) {
              callback(error as NodeJS.ErrnoException, []);
            } else {
              callback(error as NodeJS.ErrnoException, "", 0);
            }
          }
        },
      },
    });

    try {
      const response = await undiciFetch(
        requestedUrl,
        {
          ...init,
          dispatcher: agent,
        } as Parameters<typeof undiciFetch>[1],
      );
      return responseWithAgentCleanup(response as unknown as Response, agent);
    } catch (error) {
      await closeAgent(agent);
      throw error;
    }
  };
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

  let url = parseHttpUrlOrThrow(input);
  let method = (init.method ?? "GET").toString();
  let body = init.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resolved = await resolvePublicHttpUrl(url, opts);
    url = resolved.url;

    const requestInit: RequestInit = {
      ...init,
      method,
      body,
      redirect: "manual",
    };

    const pinnedFetch = createPinnedFetch(url, resolved.addresses);
    const res = opts.fetcher
      ? await opts.fetcher(url, requestInit, pinnedFetch)
      : await pinnedFetch(url, requestInit);

    if (!isRedirectStatus(res.status)) {
      // Current guarded callers need only the status for non-success results.
      // Drain a bounded prefix here so a discarded 4xx/5xx cannot retain the
      // per-request pinned Agent/socket indefinitely.
      if (!res.ok) await drainResponseBodyWithLimit(res);
      return res;
    }

    if (hop === maxRedirects) {
      await drainResponseBodyWithLimit(res);
      throw new SsrfGuardError(`Too many redirects (>${maxRedirects})`);
    }

    const location = res.headers.get("location");
    await drainResponseBodyWithLimit(res);

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
