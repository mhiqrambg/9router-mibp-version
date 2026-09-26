// codebuddy-cn/intl thread options.proxyPoolId into device-code + poll via
// fetchOAuthWithPool (mocked here); providers that ignore the option are unaffected.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/lib/oauth/oauthProxy.js", () => ({
  fetchOAuthWithPool: vi.fn(async (url, options) => fetch(url, options)),
  oauthProxyPoolIdFrom: (options = {}) =>
    String(options?.proxyPoolId || options?.proxy_pool || "").trim() || null,
}));

import codebuddyIntl from "../../src/lib/oauth/providers/codebuddy-intl.js";
import codebuddyCn from "../../src/lib/oauth/providers/codebuddy-cn.js";
import { fetchOAuthWithPool } from "../../src/lib/oauth/oauthProxy.js";

function jsonResponse(obj, ok = true) {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(obj), json: async () => obj };
}

const config = {
  stateUrl: "https://example.com/state",
  tokenUrl: "https://example.com/token",
  platform: "web",
  userAgent: "test",
  pollInterval: 5000,
};

describe("codebuddy device-code proxy threading", () => {
  const mockedFetch = vi.mocked(fetchOAuthWithPool);
  beforeEach(() => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ code: 0, data: { state: "s", authUrl: "https://example.com/auth" } })
    );
  });
  afterEach(() => vi.clearAllMocks());

  it("intl requestDeviceCode forwards the pool id", async () => {
    const out = await codebuddyIntl.requestDeviceCode(config, undefined, { proxyPoolId: "pool-1" });
    expect(out.device_code).toBe("s");
    expect(mockedFetch.mock.calls[0][2]).toBe("pool-1");
  });

  it("intl requestDeviceCode works without options (backward compat)", async () => {
    const out = await codebuddyIntl.requestDeviceCode(config);
    expect(out.device_code).toBe("s");
    expect(mockedFetch.mock.calls[0][2]).toBeNull();
  });

  it("intl pollToken forwards the pool id", async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ code: 0, data: { accessToken: "at", refreshToken: "rt" } })
    );
    const out = await codebuddyIntl.pollToken(config, "s", null, null, { proxyPoolId: "pool-9" });
    expect(out.ok).toBe(true);
    expect(mockedFetch.mock.calls[0][0]).toContain("state=s");
    expect(mockedFetch.mock.calls[0][2]).toBe("pool-9");
  });

  it("cn requestDeviceCode + pollToken forward the pool id", async () => {
    await codebuddyCn.requestDeviceCode(config, undefined, { proxy_pool: "pool-2" });
    expect(mockedFetch.mock.calls[0][2]).toBe("pool-2");
    mockedFetch.mockResolvedValue(
      jsonResponse({ code: 0, data: { accessToken: "at" } })
    );
    const out = await codebuddyCn.pollToken(config, "s", null, null, { proxyPoolId: "pool-2" });
    expect(out.ok).toBe(true);
    expect(mockedFetch.mock.calls[1][2]).toBe("pool-2");
  });
});
