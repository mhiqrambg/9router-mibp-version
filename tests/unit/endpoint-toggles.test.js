// Endpoint toggles audit: the two switches on dashboard/endpoint.
//
//   Require API key  → every /v1 route rejects a request with no/invalid key
//                      (401) before it does any work, even when the caller is
//                      a restricted key.
//   Combos only      → only combo names are listed in /v1/models and only combo
//                      names are executable for the LLM kind. Raw model ids get
//                      404. Web (search/fetch) and media kinds
//                      (image/tts/stt/embedding/video) are out of scope: the
//                      toggle is about model ids, and a search provider id is
//                      not a model.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  // Active connections decide what /v1/models lists: the raw web entries
  // (exa/search, firecrawl/fetch) only appear when their providers are
  // connected, which is what makes the web carve-out observable.
  connections: [
    { id: "p1", provider: "exa", isActive: true, authType: "apikey", data: "{}" },
    { id: "p2", provider: "firecrawl", isActive: true, authType: "apikey", data: "{}" },
  ],
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
  getProviderConnections: async () => fx.connections,
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

describe("Combos only (LLM kind)", () => {
  const models = async (kind) => {
    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    return buildModelsList(kind, {});
  };

  it("lists only combos for the llm kind", async () => {
    expect((await models(["llm"])).map((m) => m.id)).toEqual(["Main", "claude-3.7-sonnet"]);
  });

  it("leaves the web kinds fully listed (raw provider search/fetch entries stay)", async () => {
    const web = await models(["webSearch", "webFetch"]);
    const ids = web.map((m) => m.id);
    expect(ids).toContain("exa/search");
    expect(ids).toContain("firecrawl/fetch");
    expect(ids).toEqual(expect.arrayContaining(["search-combo", "fetch-combo"]));
    // the web combos keep their kind tag so a client can route them by kind
    expect(web.filter((m) => m.owned_by === "combo").map((m) => m.kind)).toEqual(["webSearch", "webFetch"]);
  });

  it("never applies to media kinds (embedding stays listed, combos-only is llm-only)", async () => {
    const keyAccess = await import("../../src/sse/services/keyAccess.js");
    const on = { combosOnly: true };
    expect(keyAccess.shouldApplyCombosOnly(["embedding"], on)).toBe(false);
    expect(keyAccess.shouldApplyCombosOnly(["image", "tts", "stt", "video"], on)).toBe(false);
    expect(keyAccess.shouldApplyCombosOnly(["webSearch"], on)).toBe(false);
    expect(keyAccess.shouldApplyCombosOnly(["webSearch", "webFetch"], on)).toBe(false);
    expect(keyAccess.shouldApplyCombosOnly(["llm"], on)).toBe(true);
  });

  it("hides a raw LLM model but keeps the same combo name callable", async () => {
    expect((await chat({ model: "af/anthropic/claude-3.7-sonnet", messages: [] }, "sk-open")).status).toBe(404);
    expect((await chat({ model: "claude-3.7-sonnet", messages: [] }, "sk-open")).status).toBe(200);
    expect(chatCore.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("does not touch /v1/search: the raw provider still runs and the combo still works", async () => {
    const raw = await search({ model: "tavily", query: "q" }, "sk-open");
    expect(raw.status).toBe(200);
    expect((await search({ model: "search-combo", query: "q" }, "sk-open")).status).toBe(200);
    expect(core.handleSearchCore).toHaveBeenCalledTimes(2);
  });

  it("does not touch /v1/web/fetch: the raw provider still runs", async () => {
    const r = await fetchWeb({ model: "firecrawl", url: "https://example.com" }, "sk-open");
    expect(r.status).not.toBe(404);
  });

  it("with the toggle off, raw LLM model ids are callable again", async () => {
    fx.settings = { requireApiKey: false, combosOnly: false, comboStrategy: "fallback" };
    expect((await chat({ model: "openai/model-a", messages: [] }, "sk-open")).status).toBe(200);
  });

  it("key access still wins over the LLM gate for a restricted key", async () => {
    // sk-web may call only "search-combo", so an LLM combo is a 403 (key gate),
    // not the combos-only 404 — the key gate runs first.
    const r = await chat({ model: "Main", messages: [] }, "sk-web");
    expect(r.status).toBe(403);
  });
});