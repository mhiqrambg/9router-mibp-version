import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

/**
 * OAuth requests happen before a provider connection exists, so there is no
 * providerSpecificData to resolve a proxy from. This helper lets the caller
 * route a single OAuth request (device-code / poll) through one of the
 * configured proxy pools (see /api/proxy-pools) by pool id.
 *
 * Reuses the standard pool resolution (legacy single-pool path: standard
 * HTTP proxy → ProxyAgent, vercel/cloudflare/deno → relay rewrite) so OAuth
 * behaves exactly like Test Connection does for the same pool.
 *
 * @param {string} url
 * @param {object} [options] fetch options
 * @param {string|null} [proxyPoolId] pool id from /api/proxy-pools; falsy = direct fetch
 * @returns {Promise<Response>}
 */
export async function fetchOAuthWithPool(url, options = {}, proxyPoolId = null) {
  const poolId = String(proxyPoolId || "").trim();
  if (!poolId) return fetch(url, options);

  const effective = await resolveConnectionProxyConfig({ proxyPoolId: poolId });
  return proxyAwareFetch(url, options, {
    vercelRelayUrl: effective?.vercelRelayUrl || "",
    connectionProxyEnabled: effective?.connectionProxyEnabled === true,
    connectionProxyUrl: effective?.connectionProxyUrl || "",
    connectionNoProxy: effective?.connectionNoProxy || "",
    strictProxy: effective?.strictProxy === true,
  });
}

/**
 * Pull the pool id out of a device-code/poll options bag. Accepts both the
 * query-param name (`proxy_pool`) and the body field name (`proxyPoolId`) so
 * route handlers don't need to normalize.
 */
export function oauthProxyPoolIdFrom(options = {}) {
  return String(options?.proxyPoolId || options?.proxy_pool || "").trim() || null;
}

/**
 * Flatten an error's `cause` chain (undici wraps the real failure — e.g.
 * ConnectTimeoutError with address/timeout — inside a bare "fetch failed")
 * into a short human-readable string for API error responses. Without this
 * the modal can only show "fetch failed" and the actionable detail stays
 * server-side in the logs.
 */
export function errorCauseChain(err, maxDepth = 3) {
  const parts = [];
  let cur = err?.cause;
  let depth = 0;
  while (cur && depth < maxDepth) {
    const msg = typeof cur === "string" ? cur : cur.message || String(cur);
    const code = cur && typeof cur === "object" && cur.code ? ` [${cur.code}]` : "";
    if (msg) parts.push(`${msg}${code}`);
    cur = cur && typeof cur === "object" ? cur.cause : null;
    depth++;
  }
  return parts.join(" <- ");
}
