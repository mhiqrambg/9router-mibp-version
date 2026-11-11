// Custom-model capability overrides: the dashboard's Vision / Reasoning /
// Speech-to-text toggles, made authoritative at request time.
//
// Storage already exists (`customModels` kv rows carry `caps`), but capability
// resolution never read it, so a model marked text-only in the UI still looked
// vision-capable to the Vision Adapter and to the pre-dispatch media stripper.
// This module builds a lookup from those rows and installs it into
// capabilities.js; the API route refreshes it after every save/delete.
import { getCustomModels } from "../localDb.js";
import { setCustomCapsSource } from "open-sse/providers/capabilities.js";
import { buildCapsLookup, lookupCaps } from "open-sse/providers/customCaps.js";

let overrides = null;

async function load() {
  try {
    overrides = buildCapsLookup(await getCustomModels());
  } catch (error) {
    // A DB hiccup must not break routing: keep the previous lookup in place.
    console.log("Error loading custom capability overrides:", error);
    if (!overrides) overrides = new Map();
  }
  return overrides;
}

export async function refreshModelCapOverrides() {
  return load();
}

export async function installModelCapOverrides() {
  await load();
  setCustomCapsSource({
    getCaps(provider, model) {
      return lookupCaps(overrides, provider, model);
    },
  });
}
