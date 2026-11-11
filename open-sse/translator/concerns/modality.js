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
// The lane — not the model — refused the media (caps.mediaUnsupportedByLane).
// Saying "the model has no vision support" would be a capability claim we don't
// have evidence for: the same model id may read images behind another upstream.
const PLACEHOLDER_LANE = {
  vision: "[image omitted: this upstream lane does not accept image input]",
  audioInput: "[audio omitted: this upstream lane does not accept audio input]",
  pdf: "[file omitted: this upstream lane does not accept file input]",
};
const ph = (cap, isLast, caps) =>
  caps?.mediaUnsupportedByLane ? PLACEHOLDER_LANE[cap] : (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];

// Mention redaction never asserts a missing capability: the bytes were
// dropped from TEXT, not because the model cannot see images.
const MENTION_NEUTRAL = {
  vision: "[inline image data URI omitted from text]",
  audioInput: "[inline audio data URI omitted from text]",
  pdf: "[inline PDF data URI omitted from text]",
};
const mentionPh = (cap, isLast, caps) =>
  !caps || caps[cap] === false ? ph(cap, isLast, caps) : MENTION_NEUTRAL[cap];

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
  // `;base64,` is optional: a bare token (`data:image/png`, `data:image/`)
  // inside a tool result 400s the lane as well (probed: `data:audio/` and
  // `data:application/pdf` do not). The lookahead keeps a genuine long payload
  // intact so vision routing and real inline images still see it.
  { cap: "vision", re: /data:image\/[A-Za-z0-9+.-]*(?![A-Za-z0-9+.-])(?!;base64,[A-Za-z0-9+/=]{65})(?:;base64,(?:\.\.\.|[A-Za-z0-9+/=]{0,64}(?![A-Za-z0-9+/=])))?/gi },
  { cap: "audioInput", re: /data:audio\/[A-Za-z0-9+.-]+;base64,(?:\.\.\.|[A-Za-z0-9+/=]{0,64}(?![A-Za-z0-9+/=]))/gi },
  { cap: "pdf", re: /data:application\/pdf(?:;[A-Za-z0-9+.-]+)?;base64,(?:\.\.\.|[A-Za-z0-9+/=]{0,64}(?![A-Za-z0-9+/=]))/gi },
];

function redactEmbeddedDataUris(text, isLast, caps) {
  let out = text;
  for (const { cap, re } of MENTION_DATA_URI) {
    const next = out.replace(re, mentionPh(cap, isLast, caps));
    if (next !== out) out = next;
  }
  return out;
}

// Full inline data URIs inside plain STRING content. Same strict lanes reject
// these too (probed: a 3.5 KB jpeg data URI as text -> 400 on every attempt,
// while the identical bytes work as an image block). Only models whose lane is
// known to reject inline text payloads get this (caps.dropInlineMediaPayloads):
// the bytes are unusable as an image there, and keeping them kills the whole
// request. Blocks are never touched, so real image inputs still work.
const INLINE_DATA_URI = [
  { cap: "vision", re: /data:image\/[A-Za-z0-9+.-]+;base64,([A-Za-z0-9+/=]+)/gi },
  { cap: "audioInput", re: /data:audio\/[A-Za-z0-9+.-]+;base64,([A-Za-z0-9+/=]+)/gi },
  { cap: "pdf", re: /data:application\/pdf(?:;[A-Za-z0-9+.-]+)?;base64,([A-Za-z0-9+/=]+)/gi },
];
const INLINE_LABEL = { vision: "image", audioInput: "audio", pdf: "PDF" };

function redactInlinePayloads(text) {
  let out = text;
  for (const { cap, re } of INLINE_DATA_URI) {
    out = out.replace(re, (_m, payload) => `[inline ${INLINE_LABEL[cap]} data URI omitted: ${payload.length} base64 chars]`);
  }
  return out;
}

// Mention redaction across request shapes. Runs for every model — before the
// capability fast-exit in stripUnsupportedModalities: a truncated mention is
// never a viewable image, and strict upstream lanes 400 on the mere
// substring. Genuine payloads (blocks, long base64) are untouched, so vision
// routing (which scans the pre-strip body) and real image inputs keep working.
function redactMentionStrings(body, sourceFormat, caps) {
  const dropInline = caps?.dropInlineMediaPayloads === true;
  const scrub = (text, isLast) => {
    const out = redactEmbeddedDataUris(text, isLast, caps);
    return dropInline ? redactInlinePayloads(out) : out;
  };
  const redactMessages = (messages) => {
    if (!Array.isArray(messages)) return;
    const last = messages.length - 1;
    messages.forEach((msg, i) => {
      if (msg && typeof msg.content === "string") msg.content = scrub(msg.content, i === last);
    });
  };
  const redactParts = (contents, getParts) => {
    if (!Array.isArray(contents)) return;
    const last = contents.length - 1;
    contents.forEach((c, i) => {
      const parts = getParts(c);
      if (!Array.isArray(parts)) return;
      parts.forEach((p) => {
        if (p && typeof p.text === "string") p.text = scrub(p.text, i === last);
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
      redactParts(body.messages, (msg) => msg?.content?.filter?.((b) => b?.type === "text"));
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
  for (const cap of removed) out.push({ type: "text", text: ph(cap, isLast, caps) });
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
    for (const cap of removed) item.content.push({ type: "input_text", text: ph(cap, i === last, caps) });
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
    for (const cap of removed) c.parts.push({ text: ph(cap, i === last, caps) });
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
  // Mention redaction first (capability-independent); the inline-payload pass
  // is gated by caps.dropInlineMediaPayloads. Fast exit only skips the
  // block-level strip.
  redactMentionStrings(body, sourceFormat, caps);
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

/**
 * True when the body still carries media parts (image/audio/file) for its
 * format. Lets a caller tell "upstream rejected this because of media" from an
 * unrelated bad request before retrying with the media stripped.
 * @param {object} body - request body in `sourceFormat` shape
 * @param {string} sourceFormat - one of FORMATS
 */
export function hasMediaBlocks(body, sourceFormat) {
  if (!body) return false;
  switch (sourceFormat) {
    case FORMATS.CLAUDE:
      return (body.messages || []).some(
        (m) => Array.isArray(m?.content) && m.content.some((b) => capForClaudeBlock(b))
      );
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      return (body.input || []).some(
        (item) => Array.isArray(item?.content) && item.content.some((b) => b?.type === "input_image" || b?.type === "input_file")
      );
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      return (body.contents || []).some(
        (c) => Array.isArray(c?.parts) && c.parts.some((p) => capForMime(p?.inlineData?.mimeType || p?.fileData?.mimeType))
      );
    case FORMATS.ANTIGRAVITY:
      return hasMediaBlocks({ contents: body?.request?.contents }, FORMATS.GEMINI);
    default:
      return (body.messages || []).some(
        (m) =>
          (Array.isArray(m?.content) && m.content.some((b) => capForOpenAIBlock(b))) ||
          (Array.isArray(m?.images) && m.images.length > 0) ||
          (Array.isArray(m?.attachments) && m.attachments.length > 0)
      );
  }
}
