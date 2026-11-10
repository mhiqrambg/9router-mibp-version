// Strip multimodal content blocks a model cannot read, BEFORE translation.
// Driven by getCapabilitiesForModel: vision/audioInput/pdf. Replaces removed
// media with a short text placeholder so messages never become empty.
import { FORMATS } from "../formats.js";

// Placeholder text inserted where a media block was removed.
// Current turn: explain the active model can't read what the user just sent.
const PLACEHOLDER_CURRENT = {
  vision: "[image omitted: model has no vision support]",
  audioInput: "[audio omitted: model has no audio support]",
  pdf: "[file omitted: model has no document support]",
};
// Earlier turns: neutral (a combo may route to a different model each turn).
const PLACEHOLDER_PREV = {
  vision: "[Previous image omitted from context.]",
  audioInput: "[Previous audio omitted from context.]",
  pdf: "[Previous file omitted from context.]",
};
const ph = (cap, isLast) => (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];

// Map gemini inlineData/fileData mime prefix -> capability it requires.
function capForMime(mime) {
  if (typeof mime !== "string") return null;
  if (mime.startsWith("image/")) return "vision";
  if (mime.startsWith("audio/")) return "audioInput";
  if (mime === "application/pdf") return "pdf";
  return null;
}

// OpenAI chat content block -> required capability (null = plain text/other, keep).
function capForOpenAIBlock(block) {
  const t = block?.type;
  if (t === "image_url" || t === "image") return "vision";
  if (t === "input_audio" || t === "audio_url") return "audioInput";
  if (t === "file") return "pdf";
  return null;
}

// Claude content block -> required capability.
function capForClaudeBlock(block) {
  const t = block?.type;
  if (t === "image") return "vision";
  if (t === "document") return "pdf";
  return null;
}

// Truncated/placeholder data URIs inside plain STRING content. Some upstream
// lanes reject the whole request when the text merely *mentions* an image
// payload — e.g. a JSDoc `data:image/jpeg;base64,...` inside a tool result
// carrying source code (probed: even a bare `data:image/` prefix 400s).
// Redact the mention, keep surrounding text. Only mention-like tokens match:
// `...` payloads or payloads shorter than a real thumbnail — a genuine
// base64 payload (hundreds of chars) is left alone so vision routing and
// real image inputs keep working. Applies regardless of model capability:
// a truncated mention is never a viewable image for any model.
const MENTION_DATA_URI = [
  { cap: "vision", re: /data:image\/[A-Za-z0-9+.-]+;base64,(?:\.\.\.|[A-Za-z0-9+/=]{0,64}(?![A-Za-z0-9+/=]))/gi },
  { cap: "audioInput", re: /data:audio\/[A-Za-z0-9+.-]+;base64,(?:\.\.\.|[A-Za-z0-9+/=]{0,64}(?![A-Za-z0-9+/=]))/gi },
  { cap: "pdf", re: /data:application\/pdf(?:;[A-Za-z0-9+.-]+)?;base64,(?:\.\.\.|[A-Za-z0-9+/=]{0,64}(?![A-Za-z0-9+/=]))/gi },
];

function redactEmbeddedDataUris(text, isLast) {
  let out = text;
  for (const { cap, re } of MENTION_DATA_URI) {
    const next = out.replace(re, ph(cap, isLast));
    if (next !== out) out = next;
  }
  return out;
}

// Mention redaction across request shapes. Runs for every model — before the
// capability fast-exit in stripUnsupportedModalities: a truncated mention is
// never a viewable image, and strict upstream lanes 400 on the mere
// substring. Genuine payloads (blocks, long base64) are untouched, so vision
// routing (which scans the pre-strip body) and real image inputs keep working.
function redactMentionStrings(body, sourceFormat) {
  const redactMessages = (messages) => {
    if (!Array.isArray(messages)) return;
    const last = messages.length - 1;
    messages.forEach((msg, i) => {
      if (msg && typeof msg.content === "string") msg.content = redactEmbeddedDataUris(msg.content, i === last);
    });
  };
  const redactParts = (contents, getParts) => {
    if (!Array.isArray(contents)) return;
    const last = contents.length - 1;
    contents.forEach((c, i) => {
      const parts = getParts(c);
      if (!Array.isArray(parts)) return;
      parts.forEach((p) => {
        if (p && typeof p.text === "string") p.text = redactEmbeddedDataUris(p.text, i === last);
      });
    });
  };
  switch (sourceFormat) {
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      redactParts(body.input, (item) => item?.content?.filter?.((b) => b?.type === "input_text"));
      return;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      redactParts(body.contents, (c) => c?.parts);
      return;
    case FORMATS.ANTIGRAVITY:
      redactParts(body?.request?.contents, (c) => c?.parts);
      return;
    default:
      redactMessages(body.messages);
  }
}

// Filter an array of content blocks; drop unsupported, inject one placeholder per kind.
// isLast = block belongs to the current user turn (picks the explanatory placeholder).
function filterBlocks(blocks, capOf, caps, removed, isLast) {
  const out = [];
  for (const block of blocks) {
    const cap = capOf(block);
    if (cap && caps[cap] === false) { removed.add(cap); continue; }
    out.push(block);
  }
  for (const cap of removed) out.push({ type: "text", text: ph(cap, isLast) });
  return out;
}

// OpenAI / OpenAI-compatible chat messages[].content[].
function stripOpenAI(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (caps.vision === false) {
      if (Array.isArray(msg.images)) delete msg.images;
      if (Array.isArray(msg.experimental_attachments)) {
        msg.experimental_attachments = msg.experimental_attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
      if (Array.isArray(msg.attachments)) {
        msg.attachments = msg.attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
    }
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForOpenAIBlock, caps, removed, i === last);
  });
}

// Claude messages[].content[].
function stripClaude(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForClaudeBlock, caps, removed, i === last);
  });
}

// OpenAI Responses input[].content[] (input_image / input_file).
function stripResponses(body, caps) {
  if (!Array.isArray(body.input)) return;
  const last = body.input.length - 1;
  body.input.forEach((item, i) => {
    if (!Array.isArray(item.content)) return;
    const removed = new Set();
    item.content = item.content.filter((b) => {
      const cap = b?.type === "input_image" ? "vision" : b?.type === "input_file" ? "pdf" : null;
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) item.content.push({ type: "input_text", text: ph(cap, i === last) });
  });
}

// Gemini / gemini-cli contents[].parts[] (inlineData / fileData by mime).
function stripGeminiParts(contents, caps) {
  if (!Array.isArray(contents)) return;
  const last = contents.length - 1;
  contents.forEach((c, i) => {
    if (!Array.isArray(c.parts)) return;
    const removed = new Set();
    c.parts = c.parts.filter((p) => {
      const mime = p?.inlineData?.mimeType || p?.fileData?.mimeType;
      const cap = capForMime(mime);
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) c.parts.push({ text: ph(cap, i === last) });
  });
}

/**
 * Remove media blocks the model can't read, in-place on the source-format body.
 * @param {object} body - request body (source format)
 * @param {string} sourceFormat - one of FORMATS
 * @param {object} caps - capabilities from getCapabilitiesForModel
 * @returns {boolean} true if anything was stripped-eligible (cap false for some modality)
 */
export function stripUnsupportedModalities(body, sourceFormat, caps) {
  if (!body || !caps) return false;
  // Mention redaction first (capability-independent); fast exit only skips block-level strip.
  redactMentionStrings(body, sourceFormat);
  if (caps.vision !== false && caps.audioInput !== false && caps.pdf !== false) return false;

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      stripOpenAI(body, caps);
      break;
    case FORMATS.CLAUDE:
      stripClaude(body, caps);
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      stripResponses(body, caps);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      stripGeminiParts(body.contents, caps);
      break;
    case FORMATS.ANTIGRAVITY:
      stripGeminiParts(body?.request?.contents, caps);
      break;
    default:
      stripOpenAI(body, caps);
  }
  return true;
}
