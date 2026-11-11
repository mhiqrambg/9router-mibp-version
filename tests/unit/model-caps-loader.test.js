import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/localDb.js", () => ({ getCustomModels: vi.fn() }));

import { getCustomModels } from "../../src/lib/localDb.js";
import { installModelCapOverrides, refreshModelCapOverrides } from "../../src/lib/modelCaps/overrides.js";
import { getCapabilitiesForModel, setCustomCapsSource } from "../../open-sse/providers/capabilities.js";

const PROVIDER = "openai-compatible-chat-77bd";
const MODEL = "deepseek-v4.1-flash-1017:flex";

describe("model capability override loader", () => {
  beforeEach(() => {
    getCustomModels.mockReset();
  });

  afterEach(() => {
    setCustomCapsSource(null);
  });

  it("installs dashboard caps so routing sees them", async () => {
    getCustomModels.mockResolvedValue([
      { providerAlias: PROVIDER, id: MODEL, type: "llm", caps: { vision: false, reasoning: true } },
    ]);
    await installModelCapOverrides();
    expect(getCapabilitiesForModel(PROVIDER, MODEL)).toMatchObject({ vision: false, reasoning: true });
  });

  it("picks up a later save without a restart", async () => {
    getCustomModels.mockResolvedValue([]);
    await installModelCapOverrides();
    const before = getCapabilitiesForModel(PROVIDER, MODEL).vision;

    getCustomModels.mockResolvedValue([
      { providerAlias: PROVIDER, id: MODEL, type: "llm", caps: { vision: !before } },
    ]);
    await refreshModelCapOverrides();
    expect(getCapabilitiesForModel(PROVIDER, MODEL).vision).toBe(!before);
  });

  it("survives a database error and keeps the last good lookup", async () => {
    getCustomModels.mockResolvedValue([
      { providerAlias: PROVIDER, id: MODEL, caps: { vision: false } },
    ]);
    await installModelCapOverrides();
    getCustomModels.mockRejectedValue(new Error("db down"));
    await refreshModelCapOverrides();
    expect(getCapabilitiesForModel(PROVIDER, MODEL).vision).toBe(false);
  });
});
