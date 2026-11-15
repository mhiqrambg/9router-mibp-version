// Endpoint toggles audit: the two switches on dashboard/endpoint.
//
//   Require API key  → every /v1 route rejects a request with no/invalid key
//                      (401) before it does any work, even when the caller is
//                      a restricted key.
//   Combos only      → only combo names are listed in /v1/models and only combo
//                      names are executable, for the kinds that have combo UI
//                      (llm, webSearch, webFetch). Raw provider/model ids get
//                      404. Media kinds (image/tts/stt/embedding/video) are out
//                      of scope by design — they have no combo UI.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [
    { id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] },
    { id: "c2", name: "search-combo", kind: "webSearch", models: ["tavily"] },
    { id: "c3", name: "fetch-combo", kind: "webFetch", models: ["firecrawl"] },
    // An LLM combo whose name is also a live provider's alias: the raw id is
    // hidden by combos-only, so it is reachable only through the combo name.
    { id: "c4", name: "claude-3.7-sonnet", models: ["af/anthropic/claude-3.7-sonnet"] },
  ],
  settings: { requireApiKey: true, combosOnly: true, comboStrategy: "fallback" },
  keys: {
    "sk-open": { id: "o", name: "open", isActive: true, access: { restricted: false, allow: [] } },
    "sk-web": { id: "w", name: "web", isActive: true, access: { restricted: true, allow: ["search-combo"] } },
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  getCombos: async () => fx.combos,
  getModelAliases: async () => ({}),
  getCustomModels: async () => [],
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getProviderConnections: async () => [],
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/lib/disabledModelsDb.js", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: vi.fn(async () => ({ connectionId: "conn", connectionName: "mock" })),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => {
    const a = request.headers.get("Authorization");
    if (a?.startsWith("Bearer ")) return a.slice(7);
    return request.headers.get("x-api-key");
  },
  isValidApiKey: vi.fn(async (k) => fx.keys[k]?.isActive === true),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: vi.fn(async () => ({ success: true, response: new Response("{}", { status: 200 }) })),
}));
vi.mock("open-sse/handlers/search/index.js", () => ({
  handleSearchCore: vi.fn(async ({ provider }) => ({
    success: true,
    data: { provider: provider.id, query: "q", results: [] },
    response: new Response("{}", { status: 200 }),
  })),
}));
vi.mock("open-sse/handlers/fetch/index.js", () => ({
  handleFetchCore: vi.fn(async () => ({ success: true, data: { provider: "firecrawl" } })),
}));

const { handleSearch } = await import("../../src/sse/handlers/search.js");
const { handleFetch } = await import("../../src/sse/handlers/fetch.js");
const { handleChat } = await import("../../src/sse/handlers/chat.js");
const core = await import("open-sse/handlers/search/index.js");
const chatCore = await import("open-sse/handlers/chatCore.js");

const post = (path, body, key) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
});
const search = (body, key) => handleSearch(post("/v1/search", body, key));
const fetchWeb = (body, key) => handleFetch(post("/v1/web/fetch", body, key));
const chat = (body, key) => handleChat(post("/v1/chat/completions", body, key));

beforeEach(() => {
  fx.settings = { requireApiKey: true, combosOnly: true, comboStrategy: "fallback" };
  core.handleSearchCore.mockClear();
  chatCore.handleChatCore.mockClear();
});

describe("Require API key", () => {
  it("401 on /v1/search, /v1/web/fetch and /v1/chat/completions without a key", async () => {
    expect((await search({ model: "search-combo", query: "q" }, null)).status).toBe(401);
    expect((await fetchWeb({ model: "fetch-combo", url: "https://example.com" }, null)).status).toBe(401);
    expect((await chat({ model: "Main", messages: [] }, null)).status).toBe(401);
  });

  it("401 on an invalid key, and no provider work happens", async () => {
    const r = await search({ model: "search-combo", query: "q" }, "sk-nope");
    expect(r.status).toBe(401);
    expect(core.handleSearchCore).not.toHaveBeenCalled();
    expect(chatCore.handleChatCore).not.toHaveBeenCalled();
  });

  it("the 401 fires before the model check (a missing key is not a 400)", async () => {
    const r = await search({ query: "q" }, null);
    expect(r.status).toBe(401);
  });

  it("with the toggle off, a keyless request reaches the provider", async () => {
    fx.settings = { requireApiKey: false, combosOnly: false, comboStrategy: "fallback" };
    const r = await search({ model: "tavily", query: "q" }, null);
    expect(r.status).toBe(200);
    expect(core.handleSearchCore).toHaveBeenCalled();
  });
});

describe("Combos only", () => {
  it("lists only combos for the llm + web kinds", async () => {
    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const llm = (await buildModelsList(["llm"], {})).map((m) => m.id);
    expect(llm).toEqual(["Main", "claude-3.7-sonnet"]);
    const web = (await buildModelsList(["webSearch", "webFetch"], {})).map((m) => m.id);
    expect(web).toEqual(["search-combo", "fetch-combo"]);
  });

  it("a web kind keeps its kind tag so the combo is routable on /v1/search", async () => {
    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const web = await buildModelsList(["webSearch"], {});
    expect(web.map((m) => m.kind)).toEqual(["webSearch"]);
  });

  it("media kinds are untouched (no combo UI there)", async () => {
    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const emb = await buildModelsList(["embedding"], {});
    expect(emb.length).toBeGreaterThan(0);
  });

  it("executes a web combo by name and hides the raw provider (404)", async () => {
    expect((await search({ model: "search-combo", query: "q" }, "sk-open")).status).toBe(200);
    const denied = await search({ model: "tavily", query: "q" }, "sk-open");
    expect(denied.status).toBe(404);
    expect((await denied.json()).error.message).toContain("tavily");
    expect(core.handleSearchCore).toHaveBeenCalledTimes(1);
  });

  it("hides a raw LLM model but keeps the same combo name callable", async () => {
    expect((await chat({ model: "af/anthropic/claude-3.7-sonnet", messages: [] }, "sk-open")).status).toBe(404);
    expect((await chat({ model: "claude-3.7-sonnet", messages: [] }, "sk-open")).status).toBe(200);
    expect(chatCore.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("with the toggle off, raw provider and model ids are callable again", async () => {
    fx.settings = { requireApiKey: false, combosOnly: false, comboStrategy: "fallback" };
    expect((await search({ model: "tavily", query: "q" }, "sk-open")).status).toBe(200);
    expect((await chat({ model: "openai/model-a", messages: [] }, "sk-open")).status).toBe(200);
  });

  it("both toggles together: the restricted key still gets 403 before combos-only", async () => {
    // sk-web is allowed only "search-combo"; an unlisted provider must be a 403
    // (key access) rather than the combos-only 404 — the key gate runs first.
    const r = await search({ model: "exa", query: "q" }, "sk-web");
    expect(r.status).toBe(403);
  });
});