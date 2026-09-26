// fetchOAuthWithPool: direct fetch by default, pool resolution + proxyAwareFetch
// when a pool id is chosen. Pool resolution is mocked; the real helper runs.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import {
  fetchOAuthWithPool,
  oauthProxyPoolIdFrom,
  errorCauseChain,
} from "../../src/lib/oauth/oauthProxy.js";

function jsonResponse(obj, ok = true) {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(obj), json: async () => obj };
}

describe("oauthProxyPoolIdFrom", () => {
  it("accepts proxyPoolId and proxy_pool spellings", () => {
    expect(oauthProxyPoolIdFrom({ proxyPoolId: "pool-1" })).toBe("pool-1");
    expect(oauthProxyPoolIdFrom({ proxy_pool: "pool-2" })).toBe("pool-2");
    expect(oauthProxyPoolIdFrom({})).toBeNull();
    expect(oauthProxyPoolIdFrom()).toBeNull();
  });
});

describe("errorCauseChain", () => {
  it("flattens an undici-style cause chain with codes", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("Connect Timeout Error (attempted address: www.codebuddy.ai:443, timeout: 10000ms)"),
        { code: "UND_ERR_CONNECT_TIMEOUT" }
      ),
    });
    expect(errorCauseChain(err)).toBe(
      "Connect Timeout Error (attempted address: www.codebuddy.ai:443, timeout: 10000ms) [UND_ERR_CONNECT_TIMEOUT]"
    );
  });

  it("returns empty string when there is no cause", () => {
    expect(errorCauseChain(new Error("boom"))).toBe("");
    expect(errorCauseChain(null)).toBe("");
    expect(errorCauseChain(undefined)).toBe("");
  });
});

describe("fetchOAuthWithPool", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    });
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses direct fetch when no pool is chosen", async () => {
    await fetchOAuthWithPool("https://example.com/state", { method: "POST" }, null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
  });

  it("resolves the pool and delegates to proxyAwareFetch", async () => {
    await fetchOAuthWithPool("https://example.com/state", { method: "POST" }, "pool-1");
    expect(mocks.resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "pool-1" });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.com/state",
      { method: "POST" },
      {
        vercelRelayUrl: "",
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.local:8080",
        connectionNoProxy: "",
        strictProxy: false,
      }
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards relay pools via vercelRelayUrl", async () => {
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.example.com/proxy",
      strictProxy: false,
    });
    await fetchOAuthWithPool("https://example.com/state", {}, "relay-pool");
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://example.com/state",
      {},
      expect.objectContaining({ vercelRelayUrl: "https://relay.example.com/proxy" })
    );
  });
});
