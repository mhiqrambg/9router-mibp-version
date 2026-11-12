// Provider list for the Usage page.
//
// GUARD — DO NOT DELETE the `!p.hidden` filter below. See AGENTS.md §3.
//
// Keep providers without serviceKinds (default LLM) or with "llm" in serviceKinds.
//
// A connection whose provider id is missing from the registry is an orphan: its
// provider was removed (e.g. `perch-cli`, dropped in af79f359) but its
// credential row survived. `AI_PROVIDERS[id]` is undefined for those, so the
// old `!p?.serviceKinds → true` check let them through and the topology fell
// back to the connection name (an email). Custom compatible nodes are also
// absent from AI_PROVIDERS, so honour `nodeNameMap` (provider-nodes) for them.
export function isLLMUsageProvider(providerId, providerRegistry = {}, nodeNameMap = {}) {
  const p = providerRegistry[providerId];
  if (!p) return Boolean(nodeNameMap[providerId]);
  if (!p.serviceKinds) return true;
  return p.serviceKinds.includes("llm");
}

// Two sources, deduped by provider id:
//   1. Active LLM connections (one entry per provider).
//   2. noAuth free providers that need no connection (e.g. opencode).
//
// Hidden providers are excluded — the Providers page filters `hidden`, so a
// hidden noAuth provider (devin-cli, mimo-free) must not leak into Usage with
// zero connections and zero traffic. `isHiddenProvider` extends that same
// exclusion to providers that DO have a connection (upstream dcc6a205).
// Covered by tests/unit/usage-provider-list.test.js.
export function buildUsageProviderList({
  connections = [],
  freeProviders = {},
  nodeNameMap = {},
  isLLMProvider = () => true,
  isHiddenProvider = () => false,
} = {}) {
  const seen = new Set();
  const unique = connections
    .filter((c) => {
      if (c.isActive === false) return false;
      if (!isLLMProvider(c.provider)) return false;
      if (isHiddenProvider(c.provider)) return false;
      if (seen.has(c.provider)) return false;
      seen.add(c.provider);
      return true;
    })
    .map((c) => ({
      ...c,
      nodeName: nodeNameMap[c.provider] || null,
    }));

  const noAuthProviders = Object.values(freeProviders)
    .filter((p) => p.noAuth && !p.hidden && !seen.has(p.id) && isLLMProvider(p.id))
    .map((p) => ({ provider: p.id, name: p.name }));

  return [...unique, ...noAuthProviders];
}
