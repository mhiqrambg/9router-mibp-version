// Compatible-node base URLs are the API ROOT: the runtime appends the path
// itself (`/chat/completions`, `/responses`, `/models`). Pasting the full
// endpoint into the node form is the common mistake — "https://x/v1/chat/completions"
// became "https://x/v1/chat/completions/chat/completions" and every request
// 404'd while Test Connection blamed the API key. Anthropic-compatible and
// custom-embedding nodes already strip their own endpoint suffix; this closes
// the same gap for OpenAI-compatible nodes.
const OPENAI_ENDPOINT_SUFFIXES = ["/chat/completions", "/responses"];

const trimSlashes = (url) => url.replace(/\/+$/, "");

export function normalizeOpenAICompatibleBaseUrl(raw = "") {
  let url = trimSlashes(String(raw).trim());
  for (const suffix of OPENAI_ENDPOINT_SUFFIXES) {
    if (!url.toLowerCase().endsWith(suffix)) continue;
    url = trimSlashes(url.slice(0, -suffix.length));
    break;
  }
  return url;
}
