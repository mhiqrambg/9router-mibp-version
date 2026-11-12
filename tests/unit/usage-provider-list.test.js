// The Usage page lists providers from two sources:
//   1. active LLM connections (deduped by provider id), and
//   2. noAuth free providers that need no connection (e.g. opencode).
//
// Hidden providers (devin-cli, mimo-free) must NOT be auto-added — they are
// excluded from the Providers page, so surfacing them in Usage (with zero
// connections and zero traffic) is a leak. Regression: devin-cli showed up in
// Usage but nowhere in Providers.
import { describe, it, expect } from "vitest";
import { buildUsageProviderList, isLLMUsageProvider } from "../../src/shared/utils/usageProviders.js";

const isLLM = () => true;

describe("isLLMUsageProvider", () => {
  const registry = {
    codex: {},
    whisper: { serviceKinds: ["stt"] },
    "openai-compatible-node": undefined,
  };

  it("rejects orphan connections whose provider left the registry", () => {
    // perch-cli was removed in af79f359; its connection row survived.
    expect(isLLMUsageProvider("perch-cli", registry, {})).toBe(false);
  });

  it("keeps custom compatible nodes via nodeNameMap", () => {
    expect(isLLMUsageProvider("openai-compatible-node", registry, { "openai-compatible-node": "My Node" })).toBe(true);
  });

  it("applies serviceKinds when the provider is known", () => {
    expect(isLLMUsageProvider("codex", registry, {})).toBe(true);
    expect(isLLMUsageProvider("whisper", registry, {})).toBe(false);
  });
});

describe("buildUsageProviderList", () => {
  it("does not auto-add hidden noAuth free providers", () => {
    const freeProviders = {
      opencode: { id: "opencode", name: "OpenCode", noAuth: true },
      "devin-cli": { id: "devin-cli", name: "Devin CLI", noAuth: true, hidden: true },
      "mimo-free": { id: "mimo-free", name: "MiMo Free", noAuth: true, hidden: true },
    };

    const list = buildUsageProviderList({
      connections: [],
      freeProviders,
      isLLMProvider: isLLM,
    });

    const ids = list.map((p) => p.provider);
    expect(ids).toContain("opencode");
    expect(ids).not.toContain("devin-cli");
    expect(ids).not.toContain("mimo-free");
  });

  it("includes active LLM connections, deduped by provider", () => {
    const list = buildUsageProviderList({
      connections: [
        { provider: "codex", isActive: true },
        { provider: "codex", isActive: true },
        { provider: "zed", isActive: true },
      ],
      freeProviders: {},
      isLLMProvider: isLLM,
    });
    expect(list.map((p) => p.provider)).toEqual(["codex", "zed"]);
  });

  it("skips inactive connections and non-LLM providers", () => {
    const list = buildUsageProviderList({
      connections: [
        { provider: "codex", isActive: false },
        { provider: "whisper", isActive: true },
      ],
      freeProviders: {},
      isLLMProvider: (id) => id !== "whisper",
    });
    expect(list).toEqual([]);
  });

  it("does not duplicate a free provider that already has a connection", () => {
    const freeProviders = {
      opencode: { id: "opencode", name: "OpenCode", noAuth: true },
    };
    const list = buildUsageProviderList({
      connections: [{ provider: "opencode", isActive: true }],
      freeProviders,
      isLLMProvider: isLLM,
    });
    expect(list.map((p) => p.provider)).toEqual(["opencode"]);
  });

  it("attaches nodeName from the lookup when present", () => {
    const list = buildUsageProviderList({
      connections: [{ provider: "node-1", isActive: true }],
      freeProviders: {},
      nodeNameMap: { "node-1": "My Node" },
      isLLMProvider: isLLM,
    });
    expect(list[0].nodeName).toBe("My Node");
  });
});
