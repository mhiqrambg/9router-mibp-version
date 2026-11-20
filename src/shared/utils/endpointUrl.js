import { assertNotMetadataTarget, assertPublicUrl } from "./ssrfGuard.js";

/**
 * Gate for operator-supplied provider endpoints before they are stored.
 *
 * The server fetches these URLs with the operator's key, so a malformed URL or a
 * cloud-metadata target is refused outright. Private targets (loopback, LAN,
 * *.internal) are allowed only when the dashboard request itself is local — that
 * is a self-hosted gateway on this machine or its LAN. A remote dashboard caller
 * (an exposed instance, a tunnel) gets the full public-only guard.
 */
export function checkEndpointUrl(rawUrl, { allowPrivate = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Base URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Base URL must use http:// or https://" };
  }

  try {
    assertNotMetadataTarget(rawUrl);
    if (!allowPrivate) assertPublicUrl(rawUrl);
  } catch {
    if (!allowPrivate) {
      return { ok: false, error: "Base URL must be a public address — private targets are only accepted from this machine" };
    }
    return { ok: false, error: "Base URL must not point at a cloud metadata endpoint" };
  }

  return { ok: true };
}
