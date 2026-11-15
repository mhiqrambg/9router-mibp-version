import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

// Regression: buildModelsList() fetches a compatible provider's live /models
// catalog but used to keep only the model ids, discarding the capabilities /
// context_length / max_output_tokens the gateway advertises. Clients then read
// the static 200k floor instead of the real window (nutaraline advertises
// 1M / 921600 for ernie-5.5-flash-preview) and compact/truncate at the wrong
// point. These tests pin the live caps end to end.
const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const CONNECTED = [{
  id: 1,
  provider: "openai-compatible-chat-ntr",
  isActive: true,
  apiKey: "sk-test",
  providerSpecificData: { baseUrl: "https://gateway.test/v1" },
}];

function mockModelsResponse(payload) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCatalogSource(null);
});

describe("compatible provider live capabilities", () => {
  it("publishes the upstream context window and max output instead of the 200k floor", async () => {
    db.getProviderConnections.mockResolvedValue(CONNECTED);
    mockModelsResponse({
      data: [{
        id: "ernie-5.5-flash-preview",
        capabilities: { contextWindow: 1024000, maxOutput: 921600, vision: false, reasoning: true, tools: true },
        architecture: { input_modalities: ["text"] },
      }],
    });

    const models = await buildModelsList(["llm"]);
    const entry = models.find((m) => m.id.endsWith("/ernie-5.5-flash-preview"));

    expect(entry).toMatchObject({
      context_length: 1024000,
      max_completion_tokens: 921600,
      capabilities: { contextWindow: 1024000, maxOutput: 921600, vision: false, reasoning: true, tools: true },
    });
  });

  it("derives vision from architecture.input_modalities", async () => {
    db.getProviderConnections.mockResolvedValue(CONNECTED);
    mockModelsResponse({
      data: [{
        id: "baidu/ERNIE-4.5-VL-424B-A47B-Base-PT",
        context_length: 131072,
        architecture: { input_modalities: ["text", "image"] },
      }],
    });

    const models = await buildModelsList(["llm"]);
    const entry = models.find((m) => m.id.endsWith("/ERNIE-4.5-VL-424B-A47B-Base-PT"));

    expect(entry?.capabilities).toMatchObject({ vision: true, contextWindow: 131072 });
  });

  it("publishes caps even for a model the static table does not know", async () => {
    db.getProviderConnections.mockResolvedValue(CONNECTED);
    mockModelsResponse({
      data: [
        { id: "acme/unknown-chat-model", capabilities: { contextWindow: 32000, maxOutput: 8000, vision: true, reasoning: false } },
        { id: "acme/another-unknown", context_length: 4096 },
      ],
    });

    const llm = await buildModelsList(["llm"]);
    const first = llm.find((m) => m.id.endsWith("/acme/unknown-chat-model"));
    const second = llm.find((m) => m.id.endsWith("/acme/another-unknown"));

    expect(first).toMatchObject({
      context_length: 32000,
      max_completion_tokens: 8000,
      capabilities: { contextWindow: 32000, maxOutput: 8000, vision: true, reasoning: false },
    });
    // `context_length` (OpenRouter/OpenAI style) is accepted as a live limit too,
    // so an unknown model never falls back to the 200k/64k floor.
    expect(second?.context_length).toBe(4096);
  });
});