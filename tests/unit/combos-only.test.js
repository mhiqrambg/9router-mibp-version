// Global combos-only mode: only combo names are listed/callable.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [
    { id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] },
  ],
  keys: {},
}));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback", combosOnly: true }),
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const keyAccess = await import("../../src/sse/services/keyAccess.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");

const enc = new TextEncoder();
const sse = (frames) => new Response(new ReadableStream({
  start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
}), { status: 200, headers: { "Content-Type": "text/event-stream" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn", connectionName: "mock" });
  mocks.handleChatCore.mockResolvedValue({
    success: true,
    response: sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"]),
  });
});

const chat = (model) => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
}));

describe("combos-only helpers", () => {
  it("is disabled without the flag", () => {
    expect(keyAccess.isCombosOnlyEnabled({})).toBe(false);
    expect(keyAccess.isCombosOnlyEnabled({ combosOnly: false })).toBe(false);
    expect(keyAccess.shouldApplyCombosOnly(["llm"], {})).toBe(false);
  });
  it("applies to llm + web, not media kinds", () => {
    const on = { combosOnly: true };
    expect(keyAccess.shouldApplyCombosOnly(["llm"], on)).toBe(true);
    expect(keyAccess.shouldApplyCombosOnly(["webSearch", "webFetch"], on)).toBe(true);
    expect(keyAccess.shouldApplyCombosOnly(["image"], on)).toBe(false);
    expect(keyAccess.shouldApplyCombosOnly(["tts"], on)).toBe(false);
    expect(keyAccess.shouldApplyCombosOnly(["llm", "image"], on)).toBe(false);
  });
  it("denies non-combos with 404 model_not_found", async () => {
    const on = { combosOnly: true };
    expect(keyAccess.enforceCombosOnly("Main", ["openai/model-a"], on)).toBeNull();
    const denied = keyAccess.enforceCombosOnly("openai/model-a", null, on);
    expect(denied.status).toBe(404);
    const body = await denied.json();
    expect(body.error.message).toContain("openai/model-a");
    expect(keyAccess.enforceCombosOnly("openai/model-a", null, {})).toBeNull();
  });
});

describe("combos-only chat gate", () => {
  it("allows the combo, rejects raw models before credential lookup", async () => {
    expect((await chat("Main")).status).toBe(200);
    vi.clearAllMocks();
    const r = await chat("openai/model-a");
    expect(r.status).toBe(404);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});
