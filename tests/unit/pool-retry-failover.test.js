import { describe, expect, it } from "vitest";

import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { retryAfterUntil } from "../../open-sse/executors/opencode.js";
import { upstreamResponseHeaders } from "../../open-sse/utils/upstreamHeaders.js";
import { pickProxyPoolId } from "../../src/lib/network/connectionProxy.js";

const HOUR = 60 * 60 * 1000;

function headers(map) {
  return new Headers(map);
}

describe("opencode pool-scoped errors honour Retry-After", () => {
  const executor = new OpenCodeExecutor();

  function parseError(status, body, headerMap) {
    return executor.parseError(
      { status, headers: headers(headerMap || {}) },
      body,
    );
  }

  it("benches the pool for the Retry-After duration in seconds", () => {
    const now = Date.now();
    const parsed = parseError(
      403,
      "detected abusive traffic from this IP address",
      { "retry-after": "3600" },
    );
    expect(parsed.poolScoped.reason).toBe("ip-blocked");
    expect(parsed.poolScoped.until - now).toBeGreaterThan(59 * 60 * 1000);
    expect(parsed.poolScoped.until - now).toBeLessThan(61 * 60 * 1000);
  });

  it("reads retry-after-ms as milliseconds, not seconds", () => {
    const now = Date.now();
    const parsed = parseError(429, "free usage limit reached", {
      "retry-after-ms": "120000",
    });
    expect(parsed.poolScoped.reason).toBe("ip-limit");
    expect(parsed.poolScoped.until - now).toBeGreaterThan(110 * 1000);
    expect(parsed.poolScoped.until - now).toBeLessThan(130 * 1000);
  });

  it("caps a multi-hour ban so one bad response cannot park a pool all day", () => {
    const now = Date.now();
    const parsed = parseError(429, "quota exhausted", {
      "retry-after": String((13.7 * HOUR) / 1000),
    });
    expect(parsed.poolScoped.until - now).toBeLessThanOrEqual(6 * HOUR);
    expect(parsed.poolScoped.until - now).toBeGreaterThan(6 * HOUR - 60 * 1000);
  });

  it("leaves until unset when the upstream sends no retry hint", () => {
    const parsed = parseError(403, "from your current network");
    expect(parsed.poolScoped.reason).toBe("ip-blocked");
    expect(parsed.poolScoped.until).toBeUndefined();
  });

  it("ignores the fingerprint 403 that pool rotation cannot fix", () => {
    expect(parseError(403, "free tier can only be used from within OpenCode")).toBeNull();
  });
});

describe("retryAfterUntil", () => {
  it("accepts the HTTP-date form", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const until = retryAfterUntil(headers({ "retry-after": "2026-10-20T12:05:00Z" }), now);
    expect(until - now).toBe(5 * 60 * 1000);
  });

  it("returns undefined for garbage values", () => {
    expect(retryAfterUntil(headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterUntil(headers({ "retry-after": "-30" }))).toBeUndefined();
    expect(retryAfterUntil(null)).toBeUndefined();
  });

  it("reads plain header objects too", () => {
    const now = Date.now();
    expect(retryAfterUntil({ "retry-after": "60" }, now) - now).toBe(60 * 1000);
  });
});

describe("pickProxyPoolId with a per-request exclusion set", () => {
  const pools = ["pool-a", "pool-b", "pool-c"];

  it("never returns a pool that already failed in this request", () => {
    for (const strategy of ["round-robin", "random", "smart", "none"]) {
      for (let i = 0; i < 5; i += 1) {
        const picked = pickProxyPoolId(pools, strategy, "opencode", {
          scope: "opencode::model",
          excludeIds: ["pool-a", "pool-b"],
        });
        expect(picked).toBe("pool-c");
      }
    }
  });

  it("returns null instead of replaying a pool once the chain is exhausted", () => {
    expect(
      pickProxyPoolId(pools, "round-robin", "opencode", { excludeIds: pools.slice() }),
    ).toBeNull();
    expect(
      pickProxyPoolId(["only-pool"], "none", "opencode", { excludeIds: ["only-pool"] }),
    ).toBeNull();
  });

  it("still fails open for a provider without a retry chain", () => {
    expect(pickProxyPoolId(["only-pool"], "none", "otherco", {})).toBe("only-pool");
    expect(pickProxyPoolId(pools, "round-robin", "otherco", { excludeIds: ["pool-b"] })).not.toBe(
      "pool-b",
    );
  });
});

describe("upstreamResponseHeaders", () => {
  it("caps the retry-after it hands to the client", () => {
    const out = upstreamResponseHeaders(headers({ "retry-after": "1800000" }));
    expect(out["retry-after"]).toBe("300");
  });

  it("keeps a short retry-after untouched", () => {
    const out = upstreamResponseHeaders(headers({ "retry-after": "12" }));
    expect(out["retry-after"]).toBe("12");
  });

  it("passes the HTTP-date form through untouched", () => {
    const out = upstreamResponseHeaders(headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }));
    expect(out["retry-after"]).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
  });

  it("forwards the anthropic rate-limit headers unchanged", () => {
    const out = upstreamResponseHeaders(
      headers({ "anthropic-ratelimit-unified-status": "rejected", "x-should-retry": "true" }),
    );
    expect(out["anthropic-ratelimit-unified-status"]).toBe("rejected");
    expect(out["x-should-retry"]).toBe("true");
  });
});
