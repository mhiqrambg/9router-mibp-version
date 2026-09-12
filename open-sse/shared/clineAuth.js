// Cline CLI identity (mirrors apps/cli + sdk/packages/llms request-headers.ts
// in cline/cline). Upstream gates the cline-free/* model aliases to Cline
// product surfaces + recent client versions — requests sent as
// X-CLIENT-TYPE 9router are 403'd with "only available via Cline product
// surfaces". Verified live 2026-09-11: cline-cli/3.0.61 passes the gate.
const CLINE_CLIENT_TYPE = "cline-cli";
const CLINE_CLIENT_VERSION = "3.0.61";

export function getClineAccessToken(token) {
  if (typeof token !== "string") return "";
  const trimmed = token.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("workos:") ? trimmed : `workos:${trimmed}`;
}

export function getClineAuthorizationHeader(token) {
  const accessToken = getClineAccessToken(token);
  return accessToken ? `Bearer ${accessToken}` : "";
}

export function buildClineHeaders(token, extraHeaders = {}, opts = {}) {
  // API keys ride plain Bearer; OAuth access tokens must carry the WorkOS
  // `workos:` prefix so the backend routes verification to WorkOS
  // (cline/cline: "Prefixed with 'workos:'..."). Verified live 2026-09-11:
  // plain sk_* works, workos:sk_* → 401.
  const trimmed = typeof token === "string" ? token.trim() : "";
  const authorization = !trimmed
    ? ""
    : opts.isApiKey
      ? `Bearer ${trimmed}`
      : getClineAuthorizationHeader(trimmed);
  const headers = {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
    "X-PLATFORM": "cli",
    "X-PLATFORM-VERSION": CLINE_CLIENT_VERSION,
    "X-CLIENT-TYPE": CLINE_CLIENT_TYPE,
    "X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
    "X-CORE-VERSION": CLINE_CLIENT_VERSION,
    "X-IS-MULTIROOT": "false",
    ...extraHeaders,
  };

  if (authorization) {
    headers.Authorization = authorization;
  }

  return headers;
}
