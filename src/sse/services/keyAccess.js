// Per-API-key access control for the /v1/* inference keys.
//
// Two modes per key: UNRESTRICTED (default — exactly today's behaviour) or
// RESTRICTED, where the key may call ONLY the combos and models in its allow
// list. No wildcards, no deny mode. Model/provider matching is case-insensitive
// on RESOLVED identities, so every spelling that routes to the same target is
// treated the same. Combo names are matched EXACTLY: combo routing is
// case-sensitive (`getComboByName`), so folding case here would let one listed
// combo grant a different, case-variant combo:
//
//   * a request that routes as a combo (getComboModels — the lookup routing
//     itself uses) is allowed iff that exact combo name is listed;
//   * a request that routes to a model is allowed iff its resolved
//     `providerId/model` equals the resolved `providerId/model` of a listed
//     model entry. So `cx/gpt-5`, `codex/gpt-5` and an alias that points there
//     are one target; a raw string that merely looks like a listed entry but
//     routes elsewhere (e.g. `MAIN` when the combo is `Main`, which routes to
//     `openai/MAIN`) is not;
//   * search/fetch (provider IS the model) are allowed iff the resolved
//     provider id is listed, or the request is a listed combo (exact name).
//
// An allowed combo grants its members when they are reached THROUGH that combo
// (the check runs once, on the requested target, before combo expansion). It
// does not grant calling a member directly by name — that needs its own entry.
// The check runs before any credential lookup, so a denied request never
// touches a provider account.
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getCombos } from "@/lib/db/repos/combosRepo.js";
import { getModelInfo, getComboModels } from "./model.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import {
  KEY_ACCESS_COMBO_OWNER,
  KEY_ACCESS_PROVIDER_AS_MODEL_KINDS,
  keyAccessDeniedMessage,
} from "@/shared/constants/keyAccess.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

const lower = (s) => String(s).toLowerCase();
const canonicalModel = (provider, model) => lower(`${provider}/${model}`);

/**
 * The client key, read from the same places and in the same order as the
 * middleware (src/dashboardGuard.js) reads the key it authorizes a remote
 * /v1 call with: Bearer, x-api-key, x-goog-api-key, ?key=. Handlers' own
 * extractApiKey() only reads the first two, so using it here would let a
 * restricted key sent as x-goog-api-key look like "no key" (= unrestricted).
 */
export function extractClientApiKey(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  const auth = headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  const googKey = headers.get("x-goog-api-key");
  if (googKey) return googKey;
  try {
    return new URL(request.url).searchParams.get("key") || null;
  } catch {
    return null;
  }
}

/**
 * Access context for the request's key, or null when the request is
 * unrestricted (no key, unknown key, or a key whose access is unrestricted).
 * Keys are only authenticated elsewhere (middleware / requireApiKey); this only
 * decides what an identified key may call.
 */
export async function getKeyAccessContext(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null;
  const record = await getApiKeyByKey(apiKey);
  if (!record?.access?.restricted) return null;
  return {
    keyId: record.id,
    keyName: record.name || record.id,
    allow: record.access.allow || [],
    _sets: null,
  };
}

// Resolve the allow list once per request: combo names, resolved model ids,
// and resolved provider ids (for provider-as-model kinds).
async function getAllowSets(ctx) {
  if (ctx._sets) return ctx._sets;
  const comboNames = new Set((await getCombos()).map((c) => c.name));
  const combos = new Set();
  const models = new Set();
  const providers = new Set();
  const modelProviders = new Set();
  for (const entry of ctx.allow) {
    if (comboNames.has(entry)) {
      combos.add(entry);
      continue;
    }
    const info = await getModelInfo(entry);
    if (info?.provider && info.model) {
      models.add(canonicalModel(info.provider, info.model));
      modelProviders.add(lower(resolveProviderId(info.provider)));
    }
    if (!entry.includes("/")) providers.add(lower(resolveProviderId(entry)));
  }
  ctx._sets = { combos, models, providers, modelProviders };
  return ctx._sets;
}

async function isModelStringAllowed(ctx, requested) {
  const sets = await getAllowSets(ctx);
  const info = await getModelInfo(requested);
  // provider null ⇔ an existing combo with no members (routes nowhere).
  if (!info?.provider) return sets.combos.has(requested);
  return sets.models.has(canonicalModel(info.provider, info.model));
}

/**
 * Boolean form of the gate for models that the gateway executes on the client's
 * behalf (a combo's fusion judge / smart router). Unrestricted context ⇒ true.
 */
export async function isModelAllowedForKey(ctx, requested) {
  if (!ctx) return true;
  if (typeof requested !== "string" || !requested) return false;
  const comboModels = await getComboModels(requested);
  if (comboModels) return (await getAllowSets(ctx)).combos.has(requested);
  return isModelStringAllowed(ctx, requested);
}

/**
 * Boolean check for a provider/model pair already resolved by the caller
 * (used where the catalog is iterated without per-entry resolution).
 */
export async function isProviderModelAllowedForKey(ctx, provider, model, kind = null) {
  if (!ctx) return true;
  if (!provider || !model) return false;
  const sets = await getAllowSets(ctx);
  if (KEY_ACCESS_PROVIDER_AS_MODEL_KINDS.includes(kind)) {
    return sets.providers.has(lower(resolveProviderId(provider)));
  }
  return sets.models.has(canonicalModel(resolveProviderId(provider), model));
}

/** Boolean check for a `/v1/models/info` record (`{ id, kind, owned_by }`). */
export async function isModelInfoAllowedForKey(ctx, info) {
  if (!ctx) return true;
  const slash = typeof info?.id === "string" ? info.id.indexOf("/") : -1;
  if (slash < 1) return false;
  return isProviderModelAllowedForKey(ctx, info.owned_by, info.id.slice(slash + 1), info.kind);
}

export function keyAccessDeniedResponse(ctx, requested) {
  log.warn("AUTH", `key-access: key "${ctx.keyName}" denied "${requested}"`);
  return errorResponse(HTTP_STATUS.FORBIDDEN, keyAccessDeniedMessage(requested));
}

/**
 * Gate for endpoints whose `model` may be a combo or a model (chat, image, tts).
 * Call with the requested string BEFORE combo expansion.
 * @returns {Promise<Response|null>} a 403 Response, or null when allowed.
 */
export async function enforceKeyAccess(ctx, requested) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  const comboModels = await getComboModels(requested);
  const allowed = comboModels
    ? sets.combos.has(requested)
    : await isModelStringAllowed(ctx, requested);
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}

/**
 * Gate for endpoints that resolve a single provider/model themselves
 * (embeddings, stt, systemone, video, Gemini-native TTS). A missing model
 * (e.g. a multipart video body we do not parse) is denied for restricted keys:
 * an unverifiable target is not an allowed one.
 */
export async function enforceKeyAccessResolved(ctx, requested, provider, model) {
  if (!ctx) return null;
  const label = requested || (provider ? `${provider}/${model ?? ""}` : "");
  if (!provider || !model) return keyAccessDeniedResponse(ctx, label);
  const sets = await getAllowSets(ctx);
  return sets.models.has(canonicalModel(provider, model)) ? null : keyAccessDeniedResponse(ctx, label);
}

/**
 * Gate for search/fetch, where the provider IS the model.
 * @param {string[]|null} comboModels - routing's own combo resolution for `requested`
 */
export async function enforceKeyAccessProvider(ctx, requested, comboModels) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  const allowed = comboModels
    ? sets.combos.has(requested)
    : sets.providers.has(lower(resolveProviderId(requested)));
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}

/**
 * Boolean provider-level check: a restricted key may touch a provider only when
 * the provider itself is listed or at least one allowed model belongs to it.
 */
export async function isProviderAllowedForKey(ctx, provider) {
  if (!ctx) return true;
  if (typeof provider !== "string" || !provider) return false;
  const pid = lower(resolveProviderId(provider));
  const sets = await getAllowSets(ctx);
  return sets.providers.has(pid) || sets.modelProviders.has(pid);
}

/**
 * Gate for video poll GETs (`/v1/videos/{id}`): the request carries no model, so
 * a restricted key may poll a provider only when that provider is named in the
 * allow list or at least one allowed model belongs to it.
 *
 * Residual: jobs are not bound to the creating key (no job table), so a key
 * allowed provider P can still poll another key's P job by id.
 */
export async function enforceKeyAccessVideoProvider(ctx, provider) {
  if (!ctx) return null;
  if (!(await isProviderAllowedForKey(ctx, provider))) {
    return keyAccessDeniedResponse(ctx, String(provider ?? ""));
  }
  return null;
}

/**
 * Capacity-adapter models are appended by the gateway, not chosen by the
 * client. For a restricted key keep only the adapter models the key may call
 * directly; the original targets (already gated) are always kept. Dropping a
 * model just shortens the fallback list, so combo failover is unaffected.
 */
export async function filterAdapterModels(ctx, augmented, original) {
  if (!ctx || !Array.isArray(augmented)) return augmented;
  const keep = new Set(original || []);
  const out = [];
  for (const m of augmented) {
    if (keep.has(m) || await isModelStringAllowed(ctx, m)) out.push(m);
    else log.info("AUTH", `key-access: key "${ctx.keyName}" skips adapter model "${m}" (not allowed)`);
  }
  return out;
}

/** /v1/models: a restricted key sees only the combos and models it may call. */
export async function filterModelsListForKey(ctx, list) {
  if (!ctx || !Array.isArray(list)) return list;
  const sets = await getAllowSets(ctx);
  const out = [];
  for (const entry of list) {
    if (!entry?.id) continue;
    if (entry.owned_by === KEY_ACCESS_COMBO_OWNER) {
      if (sets.combos.has(entry.id)) out.push(entry);
      continue;
    }
    const info = await getModelInfo(entry.id);
    if (!info?.provider) continue;
    if (KEY_ACCESS_PROVIDER_AS_MODEL_KINDS.includes(entry.kind)) {
      if (sets.providers.has(lower(info.provider))) out.push(entry);
      continue;
    }
    if (sets.models.has(canonicalModel(info.provider, info.model))) out.push(entry);
  }
  return out;
}

// Global combos-only mode: when settings.combosOnly is true, only combo names
// may be called. Raw provider/model ids are hidden from listing and rejected
// at execution, even for unrestricted keys. Checked once on the requested
// target, before combo expansion — an allowed combo still grants its members.
export function isCombosOnlyEnabled(settings) {
  return settings?.combosOnly === true;
}

// Combos-only applies to LLM + web kinds (the ones with combo UI). Media
// kinds without combo creation UI (image/tts/stt/embedding/...) stay untouched.
const COMBOS_ONLY_KINDS = new Set(["llm", "webSearch", "webFetch"]);

export function shouldApplyCombosOnly(kindFilter, settings) {
  if (!isCombosOnlyEnabled(settings)) return false;
  if (!Array.isArray(kindFilter) || kindFilter.length === 0) return false;
  return kindFilter.every((k) => COMBOS_ONLY_KINDS.has(k));
}

export function combosOnlyDeniedResponse(requested) {
  const id = String(requested ?? "");
  return errorResponse(
    HTTP_STATUS.NOT_FOUND,
    `The model '${id}' does not exist or you do not have access to it.`,
  );
}

/** Gate for combo-capable endpoints (chat, image, tts, search/fetch via comboModels). */
export function enforceCombosOnly(requested, comboModels, settings) {
  if (!isCombosOnlyEnabled(settings)) return null;
  if (comboModels) return null;
  log.warn("AUTH", `combos-only: denied "${requested}" (not a combo)`);
  return combosOnlyDeniedResponse(requested);
}
