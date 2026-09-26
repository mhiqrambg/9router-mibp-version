// Global device-code proxy threading: every device_code provider must forward
// options.proxyPoolId into its requestDeviceCode + pollToken (+ postExchange)
// fetches via fetchOAuthWithPool (mocked here).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/lib/oauth/oauthProxy.js", () => ({
  fetchOAuthWithPool: vi.fn(),
  oauthProxyPoolIdFrom: (options = {}) =>
    String(options?.proxyPoolId || options?.proxy_pool || "").trim() || null,
}));

import { fetchOAuthWithPool } from "../../src/lib/oauth/oauthProxy.js";
import github from "../../src/lib/oauth/providers/github.js";
import kimi from "../../src/lib/oauth/providers/kimi.js";
import kiro from "../../src/lib/oauth/providers/kiro.js";
import freebuff from "../../src/lib/oauth/providers/freebuff.js";
import grokCli from "../../src/lib/oauth/providers/grok-cli.js";
import kilocode from "../../src/lib/oauth/providers/kilocode.js";
import { createQoderProvider } from "../../src/lib/oauth/providers/qoder.js";

const mockedFetch = vi.mocked(fetchOAuthWithPool);

function jsonResponse(obj, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(obj), json: async () => obj };
}

function poolArgs() {
  return mockedFetch.mock.calls.map((c) => c[2]);
}

beforeEach(() => {
  mockedFetch.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("github", () => {
  const config = { deviceCodeUrl: "https://github.com/login/device/code", tokenUrl: "https://github.com/login/oauth/access_token", clientId: "cid", scopes: "repo" };
  it("threads pool through device-code, poll and postExchange", async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ device_code: "d", user_code: "u" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "at" }))
      .mockResolvedValueOnce(jsonResponse({ token: "ct" }))
      .mockResolvedValueOnce(jsonResponse({ login: "octo" }));
    await github.requestDeviceCode(config, undefined, { proxyPoolId: "pool-g" });
    await github.pollToken(config, "d", null, null, { proxyPoolId: "pool-g" });
    await github.postExchange({ access_token: "at" }, { proxyPoolId: "pool-g" });
    expect(poolArgs()).toEqual(["pool-g", "pool-g", "pool-g", "pool-g"]);
  });
});

describe("kimi", () => {
  const config = { deviceCodeUrl: "https://kimi.com/device", tokenUrl: "https://kimi.com/token", clientId: "cid" };
  it("threads pool through device-code and poll", async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ device_code: "d", user_code: "u", interval: 5 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "at" }));
    await kimi.requestDeviceCode(config, undefined, { proxyPoolId: "pool-k" });
    await kimi.pollToken(config, "d", null, { _kimiDeviceId: "dev" }, { proxyPoolId: "pool-k" });
    expect(poolArgs()).toEqual(["pool-k", "pool-k"]);
  });
});

describe("kiro", () => {
  it("threads pool through register, device-auth and poll", async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ clientId: "c", clientSecret: "s" }))
      .mockResolvedValueOnce(jsonResponse({ deviceCode: "d", userCode: "u", verificationUri: "v", interval: 5 }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "at" }));
    await kiro.requestDeviceCode({}, undefined, { proxyPoolId: "pool-kiro" });
    await kiro.pollToken({}, "d", null, { _clientId: "c", _clientSecret: "s", _region: "us-east-1" }, { proxyPoolId: "pool-kiro" });
    expect(poolArgs()).toEqual(["pool-kiro", "pool-kiro", "pool-kiro"]);
  });
});

describe("freebuff", () => {
  it("threads pool through code and status", async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ fingerprintId: "f", fingerprintHash: "h", loginUrl: "https://freebuff.com/login?auth_code=abc", expiresAt: Date.now() + 60000 }))
      .mockResolvedValueOnce(jsonResponse({ user: { authToken: "tok", email: "e@x.com", name: "n" } }));
    const out = await freebuff.requestDeviceCode({}, undefined, { proxyPoolId: "pool-f" });
    await freebuff.pollToken({}, out.device_code, null, null, { proxyPoolId: "pool-f" });
    expect(poolArgs()).toEqual(["pool-f", "pool-f"]);
  });
});

describe("grok-cli", () => {
  const config = { deviceCodeUrl: "https://auth.x.ai/device", tokenUrl: "https://auth.x.ai/token", clientId: "cid", scope: "s" };
  it("threads pool through device-code, poll and postExchange", async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ device_code: "d" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "at" }))
      .mockResolvedValueOnce(jsonResponse({ email: "g@x.ai" }));
    await grokCli.requestDeviceCode(config, undefined, { proxyPoolId: "pool-x" });
    await grokCli.pollToken(config, "d", null, null, { proxyPoolId: "pool-x" });
    await grokCli.postExchange({ access_token: "at" }, { proxyPoolId: "pool-x" });
    expect(poolArgs()).toEqual(["pool-x", "pool-x", "pool-x"]);
  });
});

describe("kilocode", () => {
  const config = { initiateUrl: "https://kilo/init", pollUrlBase: "https://kilo/poll", apiBaseUrl: "https://kilo" };
  it("threads pool through initiate, poll and profile", async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ code: "c", verificationUrl: "v" }))
      .mockResolvedValueOnce(jsonResponse({ status: "approved", token: "tok", userEmail: "k@x.com" }))
      .mockResolvedValueOnce(jsonResponse({ organizations: [{ id: "org" }] }));
    await kilocode.requestDeviceCode(config, undefined, { proxyPoolId: "pool-kc" });
    const out = await kilocode.pollToken(config, "c", null, null, { proxyPoolId: "pool-kc" });
    expect(out.ok).toBe(true);
    expect(poolArgs()).toEqual(["pool-kc", "pool-kc", "pool-kc"]);
  });
});

describe("qoder (covers qoder-cn via the same factory)", () => {
  it("threads pool through poll and userinfo", async () => {
    const provider = createQoderProvider({});
    mockedFetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ token: "dt-1", expires_in: 3600 }), json: async () => ({ token: "dt-1", expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}", json: async () => ({ name: "Q", email: "q@x.com" }) });
    const out = await provider.pollToken({}, "nonce-1", "verifier-1", { _qoderMachineId: "m" }, { proxyPoolId: "pool-q" });
    expect(out.ok).toBe(true);
    expect(poolArgs()).toEqual(["pool-q", "pool-q"]);
  });

  it("requestDeviceCode stays local (no fetch, no pool needed)", async () => {
    const provider = createQoderProvider({});
    const out = await provider.requestDeviceCode({}, undefined, { proxyPoolId: "pool-q" });
    expect(out.device_code).toBeTruthy();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
