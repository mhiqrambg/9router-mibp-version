const FORWARDED = new Set(["retry-after", "x-should-retry"]);
const FORWARDED_PREFIX = "anthropic-ratelimit-";
// A client cannot wait out an upstream ban of hours inline — several clients
// abort outright when the promised delay exceeds their own retry ceiling. Cap
// what we hand back; the pool rotation already absorbs the real wait.
const RETRY_AFTER_MAX_SECONDS = 300;

function forwardedValue(name, value) {
  if (name !== "retry-after") return value;
  const seconds = Number.parseInt(value, 10);
  // The HTTP-date form (and anything unparseable) passes through untouched.
  if (!Number.isFinite(seconds)) return value;
  return String(Math.min(seconds, RETRY_AFTER_MAX_SECONDS));
}

export function upstreamResponseHeaders(headers) {
  const out = {};
  if (typeof headers?.forEach !== "function") return out;
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (FORWARDED.has(key) || key.startsWith(FORWARDED_PREFIX)) out[key] = forwardedValue(key, value);
  });
  return out;
}
