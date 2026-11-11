// Pure lookup helpers for dashboard-edited capability overrides. Kept apart
// from the DB loader so tests can exercise key resolution without a database.
const norm = (value) => String(value ?? "").trim().toLowerCase();

// `caps` rows are whitelisted by the API, but rows also arrive from imported DB
// dumps; keep only booleans so a stray string can never flip a capability check.
export function sanitizeCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(caps)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// Map custom-model rows to `provider|model` keys, plus a provider-less fallback:
// solo requests can arrive as a bare model id, and a dashboard edit is
// unambiguous for an id that only exists on one provider.
export function buildCapsLookup(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = norm(row?.id);
    const caps = sanitizeCaps(row?.caps);
    if (!id || !caps) continue;
    map.set(`${norm(row?.providerAlias)}|${id}`, caps);
    const loose = `|${id}`;
    if (!map.has(loose)) map.set(loose, caps);
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
