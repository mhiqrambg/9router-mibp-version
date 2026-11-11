import { describe, it, expect } from "vitest";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const NO_VISION = { vision: false, audioInput: true, pdf: true };
const NO_AUDIO = { vision: true, audioInput: false, pdf: true };
const NO_PDF = { vision: true, audioInput: true, pdf: false };
const ALL = { vision: true, audioInput: true, pdf: true };

describe("stripUnsupportedModalities", () => {
  it("fast-exits when model supports all modalities", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, ALL)).toBe(false);
    expect(body.messages[0].content).toHaveLength(1);
  });

  it("openai: strips image when vision:false, leaves placeholder", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    const types = body.messages[0].content.map((b) => b.type);
    expect(types).toContain("text");
    expect(types).not.toContain("image_url");
    expect(body.messages[0].content.some((b) => b.type === "text" && /image omitted/.test(b.text))).toBe(true);
  });

  it("openai: strips input_audio when audioInput:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "input_audio", input_audio: { data: "x", format: "wav" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(body.messages[0].content.some((b) => b.type === "input_audio")).toBe(false);
    expect(body.messages[0].content.some((b) => /audio omitted/.test(b.text || ""))).toBe(true);
  });

  it("openai: strips file when pdf:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "file", file: { filename: "d.pdf", file_data: "data:application/pdf;base64,x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_PDF);
    expect(body.messages[0].content.some((b) => b.type === "file")).toBe(false);
  });

  it("openai: keeps image when vision:true", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(body.messages[0].content.some((b) => b.type === "image_url")).toBe(true);
  });

  it("claude: strips image + document by capability", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false, audioInput: true, pdf: false });
    const types = body.messages[0].content.map((b) => b.type);
    expect(types).not.toContain("image");
    expect(types).not.toContain("document");
    expect(types).toContain("text");
  });

  it("gemini: strips inlineData image by mime when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { text: "hi" },
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    expect(body.contents[0].parts.some((p) => p.inlineData)).toBe(false);
    expect(body.contents[0].parts.some((p) => /image omitted/.test(p.text || ""))).toBe(true);
  });

  it("gemini: keeps inlineData pdf when pdf:true, strips image when vision:false", () => {
    const body = { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
      { inlineData: { mimeType: "application/pdf", data: "y" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    const mimes = body.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.mimeType);
    expect(mimes).toEqual(["application/pdf"]);
  });

  it("antigravity: strips inside request.contents", () => {
    const body = { request: { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
    ] }] } };
    stripUnsupportedModalities(body, FORMATS.ANTIGRAVITY, NO_VISION);
    expect(body.request.contents[0].parts.some((p) => p.inlineData)).toBe(false);
  });

  it("responses: strips input_image when vision:false", () => {
    const body = { input: [{ role: "user", content: [
      { type: "input_text", text: "hi" },
      { type: "input_image", image_url: "data:image/png;base64,x" },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, NO_VISION);
    expect(body.input[0].content.some((b) => b.type === "input_image")).toBe(false);
    expect(body.input[0].content.some((b) => b.type === "input_text" && /image omitted/.test(b.text))).toBe(true);
  });

  it("openai: redacts data:image token inside string tool content, keeps code", () => {
    const code = "export interface ScreenshotAttachment {\n  /** `data:image/jpeg;base64,...` */\n  dataUrl: string;\n}";
    const body = { messages: [{ role: "tool", content: code }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    expect(body.messages[0].content).not.toContain("data:image/");
    expect(body.messages[0].content).toContain("ScreenshotAttachment");
    expect(body.messages[0].content).toContain("dataUrl: string;");
    expect(body.messages[0].content).toMatch(/image omitted/);
  });

  it("openai: uses current-turn placeholder on last message, neutral earlier", () => {
    const last = { messages: [{ role: "user", content: "see data:image/png;base64,..." }] };
    stripUnsupportedModalities(last, FORMATS.OPENAI, NO_VISION);
    expect(last.messages[0].content).toMatch(/model has no vision support/);
    const prev = { messages: [
      { role: "user", content: "see data:image/png;base64,..." },
      { role: "assistant", content: "ok" },
    ] };
    stripUnsupportedModalities(prev, FORMATS.OPENAI, NO_VISION);
    expect(prev.messages[0].content).toMatch(/Previous image omitted/);
  });

  it("openai: redacts mention even when vision:true, keeps real payload", () => {
    const mention = { messages: [{ role: "tool", content: "x `data:image/jpeg;base64,...` y" }] };
    stripUnsupportedModalities(mention, FORMATS.OPENAI, ALL);
    expect(mention.messages[0].content).not.toContain("data:image/");
    expect(mention.messages[0].content).toBe("x `[inline image data URI omitted from text]` y");
    expect(mention.messages[0].content).not.toMatch(/model has no vision support/);
    const real = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUg".repeat(10)}`;
    const intact = { messages: [{ role: "user", content: `see ${real} here` }] };
    stripUnsupportedModalities(intact, FORMATS.OPENAI, ALL);
    expect(intact.messages[0].content).toContain(real);
  });

  it("openai: mentions of audio/pdf use neutral text when the model supports them", () => {
    const body = { messages: [{ role: "tool", content: "a data:audio/mp3;base64,... b data:application/pdf;base64,... c" }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, ALL);
    expect(body.messages[0].content).toBe(
      "a [inline audio data URI omitted from text] b [inline PDF data URI omitted from text] c",
    );
    expect(body.messages[0].content).not.toMatch(/no audio support|no document support/);
  });

  it("openai: redacts a bare mime mention with no payload", () => {
    const body = { messages: [{ role: "tool", content: 'if (mime === "data:image/png") return;' }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    expect(body.messages[0].content).not.toContain("data:image/");
    expect(body.messages[0].content).toContain('if (mime === "');
    expect(body.messages[0].content).toContain('") return;');
    expect(body.messages[0].content).toMatch(/image omitted/);
  });

  it("openai: redacts a bare data:image/ prefix and keeps surrounding code", () => {
    const body = { messages: [{ role: "tool", content: 'if (m.content.includes("data:image/")) required.add("vision");' }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, ALL);
    expect(body.messages[0].content).not.toContain("data:image/");
    expect(body.messages[0].content).toContain('required.add("vision");');
    expect(body.messages[0].content).not.toMatch(/model has no vision support/);
  });

  it("openai: drops a full inline data URI only when the lane rejects them", () => {
    const payload = "iVBORw0KGgoAAAANSUhEUg".repeat(10);
    const text = `upload payload => data:image/jpeg;base64,${payload}; done`;
    const strict = { messages: [{ role: "tool", content: text }] };
    stripUnsupportedModalities(strict, FORMATS.OPENAI, { ...ALL, dropInlineMediaPayloads: true });
    expect(strict.messages[0].content).not.toContain("data:image/");
    expect(strict.messages[0].content).not.toContain(payload);
    expect(strict.messages[0].content).toMatch(/inline image data URI omitted: 220 base64 chars/);
    expect(strict.messages[0].content).toContain("upload payload =>");
    expect(strict.messages[0].content).toContain("; done");
  });

  it("openai: keeps image blocks when inline payloads are dropped", () => {
    const payload = "iVBORw0KGgoAAAANSUhEUg".repeat(10);
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: `see data:image/png;base64,${payload}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, { ...ALL, dropInlineMediaPayloads: true });
    expect(body.messages[0].content[0].text).not.toContain("data:image/");
    expect(body.messages[0].content[1].image_url.url).toContain(payload);
  });

  it("openai: redacts embedded audio/pdf URIs by capability", () => {
    const body = { messages: [{ role: "user", content: "a data:audio/mp3;base64,ZZZ b data:application/pdf;base64,YYY" }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, { vision: true, audioInput: false, pdf: false });
    expect(body.messages[0].content).not.toContain("data:audio/");
    expect(body.messages[0].content).not.toContain("data:application/pdf");
  });


  it("handles missing/empty body safely", () => {
    expect(stripUnsupportedModalities(null, FORMATS.OPENAI, NO_VISION)).toBe(false);
    expect(stripUnsupportedModalities({}, FORMATS.OPENAI, null)).toBe(false);
    expect(stripUnsupportedModalities({ messages: [] }, FORMATS.OPENAI, NO_VISION)).toBe(true);
  });
});
