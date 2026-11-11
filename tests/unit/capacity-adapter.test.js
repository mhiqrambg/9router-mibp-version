import { describe, it, expect } from "vitest";
import {
  augmentModelsWithCapacityAdapter,
  getCapacityAdapterModels,
  getActiveAdapterStrategy,
} from "../../open-sse/services/capacityAdapter.js";

const settings = {
  capacityAdapter: {
    vision: { enabled: true, models: ["nli/deepseek-v4.1-flash-1017", "cx/gpt-5.6-terra"] },
  },
};

describe("capacity adapter (vision)", () => {
  it("prepends vision pool models when the flex target cannot read images", () => {
    const out = augmentModelsWithCapacityAdapter(["mibp-router/deepseek-v4.1-flash-1017-flex"], ["vision"], settings);
    // nli/deepseek-v4.1-flash-1017 reads images itself (only its flex sibling
    // does not), so it stays the first candidate, ahead of the gpt pool entry
    expect(out[0]).toBe("nli/deepseek-v4.1-flash-1017");
    expect(out).toContain("cx/gpt-5.6-terra");
    expect(out).toContain("mibp-router/deepseek-v4.1-flash-1017-flex");
  });

  it("leaves a vision-capable target untouched", () => {
    for (const models of [["anthropic/claude-sonnet-5.5"], ["nli/deepseek-v4.1-flash-1017"]]) {
      expect(augmentModelsWithCapacityAdapter(models, ["vision"], settings)).toEqual(models);
    }
  });

  it("does nothing for text-only requests", () => {
    const models = ["mibp-router/deepseek-v4.1-flash-1017-flex"];
    expect(augmentModelsWithCapacityAdapter(models, [], settings)).toEqual(models);
  });

  it("reports the pool and strategy it used", () => {
    expect(getCapacityAdapterModels(settings)).toEqual(["nli/deepseek-v4.1-flash-1017", "cx/gpt-5.6-terra"]);
    expect(getActiveAdapterStrategy(["vision"], settings)).toBe("fallback");
  });
});
