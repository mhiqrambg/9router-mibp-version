// Custom-model capability overrides: the dashboard's Vision / Reasoning /
// Speech-to-text toggles, made authoritative at request time.
//
// Storage already exists (`customModels` kv rows carry `caps`), but capability
// resolution never read it, so a model marked text-only in the UI still looked
// vision-capable to the Vision Adapter and to the pre-dispatch media stripper.
// This module builds a lookup from those rows and installs it into
// capabilities.js; the API route refreshes it after every save/delete.
//
// webpack gives each chunk that imports this file its own module instance, so
// the map cannot live in module scope: the route bundle's refresh would update
// a copy the installed reader never sees. Both the map and the installed source
// therefore go through globalThis slots, which every chunk copy shares.
import { getCustomModels } from "../localDb.js";
import { setCustomCapsSource } from "open-sse/providers/capabilities.js";
import { buildCapsLookup, lookupCaps } from "open-sse/providers/customCaps.js";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

const MAP_SLOT = "__9rCustomCapsMap";
// alias -> canonical provider id, the direction request handling uses.
const ALIAS_TO_PROVIDER_ID = Object.fromEntries(
  Object.entries(PROVIDER_ID_TO_ALIAS).map(([providerId, alias]) => [alias, providerId])
);

function currentMap() {
  return globalThis[MAP_SLOT] || null;
}

function installSource() {
  setCustomCapsSource({
    getCaps(provider, model) {
      return lookupCaps(currentMap(), provider, model);
    },
  });
}

async function load() {
  try {
    const rows = await getCustomModels();
    // STT rows carry type-specific settings, not chat capabilities; indexing
    // their toggles would shadow an llm row with the same model id.
    const chatRows = rows
      .filter((row) => (row?.type || row?.kind || "llm") !== "stt")
      .map((row) => ({ ...row, providerId: ALIAS_TO_PROVIDER_ID[row?.providerAlias] || row?.providerAlias }));
    globalThis[MAP_SLOT] = buildCapsLookup(chatRows);
  } catch (error) {
    // A DB hiccup must not break routing: keep the previous lookup in place.
    console.log("Error loading custom capability overrides:", error);
    if (!currentMap()) globalThis[MAP_SLOT] = new Map();
  }
  return currentMap();
}

export async function refreshModelCapOverrides() {
  await load();
  installSource();
}

export async function installModelCapOverrides() {
  await load();
  installSource();
}
