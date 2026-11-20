import { describe, it, expect, beforeEach } from "vitest";
import {
  augmentModelsWithCapacityAdapter,
  getCapacityAdapterModels,
  getActiveAdapterStrategy,
  getComboVisionModel,
  fusionPanelModels,
  satisfiesCapabilities,
  modelsSatisfyCapabilities,
} from "../../open-sse/services/capacityAdapter.js";
import { markRouteModelRejectsMedia, resetMediaLaneState } from "../../open-sse/services/mediaLaneSupport.js";

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

  it("leaves an unconfigured pool inert instead of inventing a default model", () => {
    const unset = { capacityAdapter: { vision: { enabled: true, models: [] } } };
    const member = "nli/deepseek-v4.1-flash-1017:flex";
    expect(getCapacityAdapterModels(unset)).toEqual([]);
    expect(augmentModelsWithCapacityAdapter([member], ["vision"], unset)).toEqual([member]);
    // A per-combo pin still works without any global pool.
    expect(augmentModelsWithCapacityAdapter([member], ["vision"], unset, "nli/deepseek-v4.1-flash-1017"))
      .toEqual(["nli/deepseek-v4.1-flash-1017", member]);
  });

  it("reports the pool and strategy it used", () => {
    expect(getCapacityAdapterModels(settings)).toEqual(["nli/deepseek-v4.1-flash-1017", "cx/gpt-5.6-terra"]);
    expect(getActiveAdapterStrategy(["vision"], settings)).toBe("fallback");
  });
});

describe("per-combo vision model", () => {
  // Both members are text-only: flex rejects media, and qwen3-coder is not a
  // vision model at all.
  const flexCombo = ["mibp-router/deepseek-v4.1-flash-1017-flex", "oc/qwen3-coder-free"];

  it("tries the combo's own vision model before the global pool", () => {
    const out = augmentModelsWithCapacityAdapter(flexCombo, ["vision"], settings, "cerebras/qwen3-vl-235b-a22b");
    expect(out[0]).toBe("cerebras/qwen3-vl-235b-a22b");
    expect(out).toContain("nli/deepseek-v4.1-flash-1017");
    expect(out).toContain("mibp-router/deepseek-v4.1-flash-1017-flex");
  });

  it("backs the combo's pick with the global pool when the pick is disabled", () => {
    // Same model pinned, but the combo cannot reach it: the pool still answers.
    const out = augmentModelsWithCapacityAdapter(flexCombo, ["vision"], settings, "gone-model/x");
    expect(out[0]).toBe("nli/deepseek-v4.1-flash-1017");
    expect(out).not.toContain("gone-model/x");
  });

  it("ignores the combo's pick when a member already reads images", () => {
    const models = ["anthropic/claude-sonnet-5.5"];
    expect(augmentModelsWithCapacityAdapter(models, ["vision"], settings, "cerebras/qwen3-vl-235b-a22b")).toEqual(models);
  });

  it("keeps the combo's vision pick out of a pdf-only request", () => {
    const out = augmentModelsWithCapacityAdapter(flexCombo, ["pdf"], settings, "cerebras/qwen3-vl-235b-a22b");
    // No pdf pool in these settings, so the members alone remain - a vision model
    // must not silently become the document reader.
    expect(out).toEqual(flexCombo);
  });

  it("reads the delegate off the stored combo strategy", () => {
    expect(getComboVisionModel({ visionModel: " cx/gpt-5.6-terra " })).toBe("cx/gpt-5.6-terra");
    expect(getComboVisionModel({ visionModel: "   " })).toBeNull();
    expect(getComboVisionModel({})).toBeNull();
    expect(getComboVisionModel(null)).toBeNull();
  });

  it("answers capability checks from the same rule the router uses", () => {
    expect(satisfiesCapabilities("nli/deepseek-v4.1-flash-1017", ["vision"])).toBe(true);
    expect(satisfiesCapabilities("mibp-router/deepseek-v4.1-flash-1017-flex", ["vision"])).toBe(false);
    expect(satisfiesCapabilities("mibp-router/deepseek-v4.1-flash-1017-flex", ["search"])).toBe(true);
    expect(modelsSatisfyCapabilities(flexCombo, ["vision"])).toBe(false);
    expect(modelsSatisfyCapabilities([...flexCombo, "cx/gpt-5.6-terra"], ["vision"])).toBe(true);
  });

  it("adds the pinned reader to a fusion panel only when the panel needs it", () => {
    const reader = "cx/gpt-5.6-terra";
    expect(fusionPanelModels(flexCombo, ["vision"], reader, [...flexCombo, reader])).toEqual([...flexCombo, reader]);
    // Panel already reads images: the reader is not an extra billed panel member.
    expect(fusionPanelModels(["kr/claude-sonnet-4.5"], ["vision"], reader, [...reader, "kr/claude-sonnet-4.5"]))
      .toEqual(["kr/claude-sonnet-4.5"]);
    // Text-only request: panel stays exactly the configured members.
    expect(fusionPanelModels(flexCombo, [], reader, [...flexCombo, reader])).toEqual(flexCombo);
  });

  it("does not seat the pinned reader when key access dropped it", () => {
    expect(fusionPanelModels(flexCombo, ["vision"], "cx/gpt-5.6-terra", flexCombo)).toEqual(flexCombo);
  });
});

describe("learned route rejection", () => {
  beforeEach(() => resetMediaLaneState());

  it("outranks capabilities that claim vision", () => {
    // A gateway can publish vision:true for a lane that still answers 400 on
    // image parts (nutaraline `:flex` does exactly that). Once the wire has
    // taught us the lane is text-only, selection must stop trusting the caps.
    const member = "nli/deepseek-v4.1-flash-1017";
    expect(satisfiesCapabilities(member, ["vision"])).toBe(true);
    markRouteModelRejectsMedia("nli", "deepseek-v4.1-flash-1017");
    expect(satisfiesCapabilities(member, ["vision"])).toBe(false);
    // The combo's pinned reader now takes priority over the (now excluded) member.
    const out = augmentModelsWithCapacityAdapter([member], ["vision"], settings, "cerebras/qwen3-vl-235b-a22b");
    expect(out[0]).toBe("cerebras/qwen3-vl-235b-a22b");
    // The member stays last as a fallback, but never ahead of the reader.
    expect(out[out.length - 1]).toBe(member);
  });

  it("is scoped to the alias that rejected the media", () => {
    markRouteModelRejectsMedia("nli", "deepseek-v4.1-flash-1017");
    expect(satisfiesCapabilities("nli/deepseek-v4.1-flash-1017", ["vision"])).toBe(false);
    expect(satisfiesCapabilities("openrouter/deepseek-v4.1-flash-1017", ["vision"])).toBe(true);
  });
});
