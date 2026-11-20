/**
 * Capacity Adapter — global fallback pools of models per input-modality capability
 * (vision / pdf / audioInput / videoInput).
 *
 * The pool models are appended as extra fallback candidates behind whatever models
 * were already going to be tried (a combo's members, or a single target model).
 * combo.js's existing reorderByCapabilities then floats a capable pool model to the
 * front only when none of the original models can handle the request — so this
 * never overrides a combo that already has a member covering the capability.
 */
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { routeModelRejectsMedia } from "./mediaLaneSupport.js";

export const CAPABILITY_KEYS = ["vision", "pdf", "audioInput", "videoInput"];
const HARD_CAPS = new Set(CAPABILITY_KEYS);
// Retired free-tier id: only rewrites a pool entry the user explicitly saved.
const upgradeLegacyModel = (m) => (m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m);

// Normalize a capability entry to { enabled, roundRobin, models }. Backward-compat:
// accept the legacy array form [{model, enabled}] (treated as enabled, fallback).
function normalizeCapEntry(entry) {
  if (Array.isArray(entry)) {
    return { enabled: true, roundRobin: false, models: entry.map((e) => upgradeLegacyModel(e?.model || e)).filter(Boolean) };
  }
  if (entry && typeof entry === "object") {
    return {
      enabled: entry.enabled !== false,
      roundRobin: !!entry.roundRobin,
      models: Array.isArray(entry.models) ? entry.models.map(upgradeLegacyModel).filter(Boolean) : [],
    };
  }
  return { enabled: false, roundRobin: false, models: [] };
}

// Resolve one capability's full config. An enabled pool with no models adds
// nothing: the adapter is opt-in, and an empty pool must never silently route
// requests to a model the user did not configure.
export function getCapacityAdapterConfig(cap, settings) {
  return normalizeCapEntry(settings?.capacityAdapter?.[cap]);
}

// Flatten enabled models across all capability pools, in priority order, deduped.
export function getCapacityAdapterModels(settings) {
  const seen = new Set();
  const models = [];
  for (const cap of CAPABILITY_KEYS) {
    const { enabled, models: pool } = getCapacityAdapterConfig(cap, settings);
    if (!enabled) continue;
    for (const m of pool) {
      if (!seen.has(m)) {
        seen.add(m);
        models.push(m);
      }
    }
  }
  return models;
}

// Strategy for a capability: "round-robin" when enabled+roundRobin, else "fallback".
export function getCapacityAdapterStrategy(cap, settings) {
  const { enabled, roundRobin } = getCapacityAdapterConfig(cap, settings);
  return enabled && roundRobin ? "round-robin" : "fallback";
}

// Strategy from the request's required capabilities: picks the first capability
// whose adapter pool is enabled and can satisfy a hard requirement.
export function getActiveAdapterStrategy(requiredCapabilities, settings) {
  const hard = [...(requiredCapabilities || [])].filter((c) => HARD_CAPS.has(c));
  for (const cap of hard) {
    const { enabled, models } = getCapacityAdapterConfig(cap, settings);
    if (!enabled || models.length === 0) continue;
    return getCapacityAdapterStrategy(cap, settings);
  }
  return "fallback";
}

function modelSatisfies(modelStr, requiredHard) {
  const slash = modelStr.indexOf("/");
  const provider = slash > 0 ? modelStr.slice(0, slash) : "";
  const model = slash > 0 ? modelStr.slice(slash + 1) : modelStr;
  // The catalog can claim vision for a model whose gateway still rejects
  // image parts (nutaraline's `:flex` lane advertises vision:true and answers
  // 400 vision_not_supported). A learned rejection outranks the catalog: if
  // this model can't read images through its own route, the combo's pinned
  // reader must be seated instead.
  if (requiredHard.includes("vision") && routeModelRejectsMedia(provider, model)) return false;
  const caps = getCapabilitiesForModel(provider, model);
  return requiredHard.every((c) => caps[c] === true);
}

/** True when this model id reads every requested hard modality. */
export function satisfiesCapabilities(modelStr, capabilities) {
  const hard = [...(capabilities || [])].filter((c) => HARD_CAPS.has(c));
  if (hard.length === 0) return true;
  return modelSatisfies(modelStr, hard);
}

/** True when at least one of `models` reads every requested hard modality. */
export function modelsSatisfyCapabilities(models, capabilities) {
  return (models || []).some((m) => satisfiesCapabilities(m, capabilities));
}

/**
 * Per-combo vision model. A combo may name one model that reads images for it
 * when none of its own members can — the same delegation the global Vision
 * Adapter pool does, but scoped to that combo so different combos can use
 * different readers. Stored as settings.comboStrategies[name].visionModel.
 * Returns null when unset (fall through to the global pool).
 */
export function getComboVisionModel(comboStrategy) {
  const raw = comboStrategy?.visionModel;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

// Prepend capacity-adapter models as priority candidates when NONE of the
// original models (combo members, or the single target model) can satisfy the
// request's required capabilities. Adapter models go FIRST (priority); the
// original models follow as fallback. Leaves `models` untouched when the
// original list already covers it (combo.js's reorderByCapabilities handles
// that case via autoSwitch).
//
// `comboVisionModel` is the per-combo reader (vision only): it is tried before
// the global pool, so a combo that pins its own vision model never pays a
// failed round trip on a pool member, and the global pool still backstops it.
export function augmentModelsWithCapacityAdapter(models, requiredCapabilities, settings, comboVisionModel = null) {
  const hard = [...(requiredCapabilities || [])].filter((c) => HARD_CAPS.has(c));
  if (hard.length === 0 || !Array.isArray(models) || models.length === 0) return models;
  if (models.some((m) => modelSatisfies(m, hard))) return models;

  const reusable = (m) => !models.includes(m) && modelSatisfies(m, hard);
  // The combo's own pick is a vision reader; it must not silently become the
  // pdf/audio adapter, so it only joins a request that actually needs vision.
  const priority = comboVisionModel && hard.includes("vision") && reusable(comboVisionModel)
    ? [comboVisionModel]
    : [];

  const pool = getCapacityAdapterModels(settings).filter(reusable);
  const merged = [...new Set([...priority, ...pool])];
  if (merged.length === 0) return models;
  return [...merged, ...models];
}

/**
 * Fusion panels fan out to every member, and members that cannot read the
 * request's hard modalities get the media stripped — so an image request whose
 * panel has no reader would be judged on placeholders. Append the combo's own
 * vision model when it is reachable and the panel needs it. The global adapter
 * pool is deliberately not pulled in: it would silently grow every fusion panel.
 */
export function fusionPanelModels(comboModels, requiredCapabilities, comboVisionModel, reachableModels) {
  const picksItsReader = comboVisionModel
    && (reachableModels || []).includes(comboVisionModel)
    && !modelsSatisfyCapabilities(comboModels, requiredCapabilities);
  return picksItsReader ? [...comboModels, comboVisionModel] : comboModels;
}

const CHARS_PER_TOKEN = 4; // rough estimate; avoids pulling in a tokenizer dependency
const HEAD_KEEP = 6;      // messages after system kept verbatim before dropping the middle

function blockLength(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, b) => sum + (typeof b?.text === "string" ? b.text.length : 50), 0);
  }
  return 0;
}

// Chat and Responses shapes keep an assistant turn and its tool result as two
// separate messages. Dropping one side turns a valid history into an orphaned
// tool output, which strict upstreams reject with "No tool call found for
// function call output with call_id ..." (cx/Codex and other Responses lanes).
const isAssistantTurn = (m) =>
  m?.role === "assistant" || m?.role === "model" || m?.type === "function_call";
const isToolTurn = (m) =>
  m?.role === "tool" || m?.role === "function" || m?.type === "function_call_output";
function callIdsOf(m) {
  const ids = [];
  for (const tc of m?.tool_calls || []) if (tc?.id) ids.push(tc.id);
  if (m?.type === "function_call" && m?.call_id) ids.push(m.call_id);
  return ids;
}
function toolCallIdOf(m) {
  return m?.tool_call_id || m?.call_id || "";
}

// Trim history to fit a (possibly smaller) context window by dropping the MIDDLE.
// Preserves: all system/instruction messages (head), and the trailing user run
// carrying the media the switch happened for (tail). Older middle turns between
// the head instructions and the current turn are dropped first.
export function stripHistoryForContext(body, contextWindow) {
  const key = Array.isArray(body.messages) ? "messages"
    : Array.isArray(body.input) ? "input"
    : Array.isArray(body.contents) ? "contents"
    : null;
  if (!key) return body;
  const arr = body[key];
  if (!arr || arr.length === 0) return body;

  const contentOf = (m) => m?.content ?? m?.parts;
  const lengthOf = (m) => blockLength(contentOf(m));
  // Cap at 80% of the adapter model's context window — leaves room for the response.
  const budgetChars = (contextWindow || 200000) * 0.8 * CHARS_PER_TOKEN;

  // A history that already fits must pass through untouched. Trimming it anyway
  // dropped the middle of every conversation longer than HEAD_KEEP, orphaning the
  // trailing tool result whose assistant turn lived in the discarded span.
  if (arr.reduce((sum, m) => sum + lengthOf(m), 0) <= budgetChars) return body;

  const isSystem = (r) => r === "system" || r === "developer";
  const systemMsgs = arr.filter((m) => isSystem(m?.role));
  const rest = arr.filter((m) => !isSystem(m?.role));
  if (rest.length === 0) return body;

  let i = rest.length - 1;
  while (i >= 0 && !isAssistantTurn(rest[i])) i--;
  if (i < 0) return body;

  // Widen the kept tail until every kept tool result still has its call; the
  // last assistant turn is usually the owner of the trailing tool result.
  let start = i + 1;
  const keptCallIds = new Set();
  for (let k = start; k < rest.length; k++) for (const id of callIdsOf(rest[k])) keptCallIds.add(id);
  while (start > 0) {
    const orphaned = rest.slice(start).some((m) =>
      isToolTurn(m) && toolCallIdOf(m) && !keptCallIds.has(toolCallIdOf(m)));
    if (!orphaned) break;
    start -= 1;
    for (const id of callIdsOf(rest[start])) keptCallIds.add(id);
  }
  const tail = rest.slice(start);          // current user run + its tool round — always kept
  const older = rest.slice(0, start);      // everything before it
  if (older.length === 0) return body;

  // Prefer keeping the first HEAD_KEEP messages (initial instructions/context) verbatim;
  // only trim further if even that exceeds the adapter model's context window.
  const headKept = older.slice(0, HEAD_KEEP);
  let total = systemMsgs.concat(headKept, tail).reduce((s, m) => s + lengthOf(m), 0);

  // If head + tail overflow, drop head turns from the end (closest to middle) first.
  // Popping the suffix never splits a call from its own output: outputs always follow.
  let head = headKept;
  while (total > budgetChars && head.length > 0) {
    const dropped = head.pop();
    total -= lengthOf(dropped);
  }

  // The head cut has the mirror problem: if it lands on an assistant turn whose tool
  // result fell into the dropped middle (or on a tool result whose call did), the kept
  // span holds a call without output, which strict upstreams reject with
  // "No tool output found for function call ...". Drop trailing split messages.
  while (head.length > 0) {
    const headCalls = new Set();
    const headOutputIds = new Set();
    for (const m of head) {
      for (const id of callIdsOf(m)) headCalls.add(id);
      if (isToolTurn(m) && toolCallIdOf(m)) headOutputIds.add(toolCallIdOf(m));
    }
    const last = head[head.length - 1];
    const splitsCall = callIdsOf(last).some((id) => !headOutputIds.has(id));
    const splitsOutput = isToolTurn(last) && toolCallIdOf(last) && !headCalls.has(toolCallIdOf(last));
    if (!splitsCall && !splitsOutput) break;
    total -= lengthOf(head.pop());
  }

  if (head.length === older.length && start === i + 1) return body;
  return { ...body, [key]: [...systemMsgs, ...head, ...tail] };
}

// Wrap a handleSingleModel callback so calls to a capacity-adapter model strip
// history to fit its context window first. No-op passthrough when the pool is empty.
export function withCapacityAdapterStripping(handleSingleModel, adapterModels) {
  const adapterSet = new Set(adapterModels);
  if (adapterSet.size === 0) return handleSingleModel;
  return (body, modelStr, ...rest) => {
    if (adapterSet.has(modelStr)) {
      const slash = modelStr.indexOf("/");
      const provider = slash > 0 ? modelStr.slice(0, slash) : "";
      const model = slash > 0 ? modelStr.slice(slash + 1) : modelStr;
      const { contextWindow } = getCapabilitiesForModel(provider, model);
      body = stripHistoryForContext(body, contextWindow);
    }
    return handleSingleModel(body, modelStr, ...rest);
  };
}
