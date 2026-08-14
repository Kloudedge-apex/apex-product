import { isPrivateOrLocalIp } from "../runtime/util/ssrf-guard";

/**
 * Trust forwarding headers only from a private, loopback, or link-local
 * immediate peer. Azure Container Apps terminates public ingress before the
 * application socket, so its internal proxy qualifies; a direct public peer
 * does not. Express then walks X-Forwarded-For from right to left and stops at
 * the first untrusted hop, preventing a client-prepended address from becoming
 * req.ip.
 */
export function isTrustedProxyAddress(address: string): boolean {
  return isPrivateOrLocalIp(address);
}
