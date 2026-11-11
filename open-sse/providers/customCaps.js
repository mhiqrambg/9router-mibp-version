// Pure lookup helpers for dashboard-edited capability overrides. Kept apart
// from the DB loader so tests can exercise key resolution without a database.
const norm = (value) => String(value ?? "").trim().toLowerCase();

// Dashboard-editable capability keys. Must mirror CAPACITY_META in
// src/shared/constants/models.js: that module pulls the provider registry and the
// UI alias table, which unit tests cannot resolve, so the list lives here and
// the API whitelist there gates writes. Anything else in a row (pdf, tools, …)
// is dropped: imported DB dumps must not flip capabilities with no toggle.
export const EDITABLE_CAPS = Object.freeze(["vision", "reasoning"]);

// `caps` rows are whitelisted by the API, but rows also arrive from imported DB
// dumps. Keep only booleans the dashboard can actually edit, so a stray key can
// never flip a capability (pdf, tools, …) that has no toggle behind it.
export function sanitizeCaps(caps, allowedKeys = EDITABLE_CAPS) {
  if (!caps || typeof caps !== "object") return null;
  const keys = Array.isArray(allowedKeys) && allowedKeys.length ? allowedKeys : Object.keys(caps);
  const out = {};
  for (const key of keys) {
    if (typeof caps[key] === "boolean") out[key] = caps[key];
  }
  return Object.keys(out).length ? out : null;
}

// Map custom-model rows to `provider|model` keys. A row is indexed under both
// its dashboard alias (combo seats resolve `alias/model`) and its canonical
// provider id (chatCore/sync call with the provider id), so one edit applies on
// every code path. The provider-less `|model` key exists for bare-id lookups,
// but only when the id is unambiguous: two providers carrying the same id with
// different caps must not lend each other's values.
export function buildCapsLookup(rows, allowedKeys = EDITABLE_CAPS) {
  const map = new Map();
  const idsByProvider = new Map();
  const looseCaps = new Map();
  for (const row of rows || []) {
    const id = norm(row?.id);
    const caps = sanitizeCaps(row?.caps, allowedKeys);
    if (!id || !caps) continue;
    const providers = [norm(row?.providerAlias), norm(row?.providerId)].filter(Boolean);
    for (const p of providers) map.set(`${p}|${id}`, caps);
    let providers_seen = idsByProvider.get(id);
    if (!providers_seen) idsByProvider.set(id, (providers_seen = new Set()));
    providers_seen.add(providers[0] || "");
    if (!looseCaps.has(id)) looseCaps.set(id, caps);
  }
  for (const [id, providers_seen] of idsByProvider) {
    if (providers_seen.size === 1) map.set(`|${id}`, looseCaps.get(id));
  }
  return map;
}

export function lookupCaps(map, provider, model) {
  if (!map || !model) return null;
  const m = norm(model);
  const base = m.includes("/") ? m.split("/").pop() : m;
  const p = norm(provider);
  return (
    map.get(`${p}|${m}`) ||
    map.get(`${p}|${base}`) ||
    map.get(`|${m}`) ||
    map.get(`|${base}`) ||
    null
  );
}
