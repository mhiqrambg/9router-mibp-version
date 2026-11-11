import { describe, expect, it } from "vitest";
import { buildCapsLookup, lookupCaps, sanitizeCaps } from "../../open-sse/providers/customCaps.js";

const rows = [
  { providerAlias: "openai-compatible-chat-77bd", id: "deepseek-v4.1-flash-1017:flex", caps: { vision: false, reasoning: true } },
  { providerAlias: "oc", id: "Mimo-v2.6-flash-free", caps: { vision: true } },
  { providerAlias: "oc", id: "no-caps-model", name: "ignored" },
];

describe("custom capability overrides", () => {
  it("keeps only boolean caps and drops empty entries", () => {
    expect(sanitizeCaps({ vision: false, reasoning: "yes" })).toEqual({ vision: false });
    expect(sanitizeCaps({ name: "x" })).toBeNull();
    expect(sanitizeCaps(null)).toBeNull();
  });

  it("resolves provider-scoped rows case-insensitively", () => {
    const map = buildCapsLookup(rows);
    expect(lookupCaps(map, "openai-compatible-chat-77BD", "DeepSeek-V4.1-Flash-1017:flex")).toEqual({
      vision: false,
      reasoning: true,
    });
  });

  it("falls back to the bare model id when the request carries no provider", () => {
    const map = buildCapsLookup(rows);
    expect(lookupCaps(map, "", "mimo-v2.6-flash-free")).toEqual({ vision: true });
    expect(lookupCaps(map, undefined, "deepseek-v4.1-flash-1017:flex")).toEqual({ vision: false, reasoning: true });
  });

  it("strips a vendor prefix before matching", () => {
    const map = buildCapsLookup(rows);
    expect(lookupCaps(map, "openrouter", "deepseek-ai/mimo-v2.6-flash-free")).toEqual({ vision: true });
  });

  it("ignores rows without caps and unknown models", () => {
    const map = buildCapsLookup(rows);
    expect(lookupCaps(map, "oc", "no-caps-model")).toBeNull();
    expect(lookupCaps(map, "oc", "never-edited")).toBeNull();
    expect(lookupCaps(null, "oc", "anything")).toBeNull();
  });
});
