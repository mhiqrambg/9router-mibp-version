import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { unwrapDataEnvelope } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { buildClineHeaders } = await import("../../open-sse/shared/clineAuth.js");

// Cline gateway wraps non-streaming Chat Completions in {data, success}.
// handleNonStreamingResponse calls unwrapDataEnvelope unconditionally (it runs
// before the needsTranslation gate, which openai→openai never passes).
const ENVELOPED = {
  data: {
    id: "gen-123",
    object: "chat.completion",
    created: 1789056634,
    model: "deepseek/deepseek-v4-flash-0731",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi there!" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 29, total_tokens: 38 },
  },
  success: true,
};

describe("cline {data} envelope unwrap", () => {
  it("unwraps choices/usage to top level", () => {
    const out = unwrapDataEnvelope(structuredClone(ENVELOPED));
    expect(out.choices?.[0]?.message?.content).toBe("Hi there!");
    expect(out.usage?.prompt_tokens).toBe(9);
  });

  it("leaves plain OpenAI bodies untouched", () => {
    const out = unwrapDataEnvelope(structuredClone(ENVELOPED.data));
    expect(out.choices?.[0]?.message?.content).toBe("Hi there!");
  });

  it("prefers top-level choices when both exist", () => {
    const body = { ...structuredClone(ENVELOPED), choices: [{ index: 0, message: { role: "assistant", content: "top" }, finish_reason: "stop" }] };
    const out = unwrapDataEnvelope(body);
    expect(out.choices?.[0]?.message?.content).toBe("top");
  });

  it("ignores non-envelope bodies", () => {
    expect(unwrapDataEnvelope(null)).toBe(null);
    expect(unwrapDataEnvelope({ error: "x" })).toEqual({ error: "x" });
  });
});

describe("cline auth header shape", () => {
  it("sends API keys as plain Bearer", () => {
    expect(buildClineHeaders("sk_abc", {}, { isApiKey: true }).Authorization).toBe("Bearer sk_abc");
  });

  it("prefixes OAuth tokens with workos:", () => {
    expect(buildClineHeaders("tok123").Authorization).toBe("Bearer workos:tok123");
    expect(buildClineHeaders("workos:tok123").Authorization).toBe("Bearer workos:tok123");
  });

  it("sends Cline product identity headers (free-model gate)", () => {
    const h = buildClineHeaders("tok123");
    expect(h["X-CLIENT-TYPE"]).toBe("cline-cli");
    expect(h["User-Agent"]).toMatch(/^Cline\//);
  });
});
