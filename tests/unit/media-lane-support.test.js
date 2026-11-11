import { describe, it, expect, beforeEach } from "vitest";
import {
  laneRejectsMedia,
  markLaneRejectsMedia,
  textOnlyCaps,
  resetMediaLaneState,
} from "../../open-sse/services/mediaLaneSupport.js";
import { hasMediaBlocks, stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("media lane support registry", () => {
  beforeEach(() => resetMediaLaneState());

  it("is per provider + connection + model", () => {
    markLaneRejectsMedia("openai-compatible-chat-abc", "conn1", "deepseek-v4.1-flash-1017:flex");
    expect(laneRejectsMedia("openai-compatible-chat-abc", "conn1", "deepseek-v4.1-flash-1017:flex")).toBe(true);
    expect(laneRejectsMedia("openai-compatible-chat-abc", "conn2", "deepseek-v4.1-flash-1017:flex")).toBe(false);
    expect(laneRejectsMedia("openai-compatible-chat-abc", "conn1", "other-model")).toBe(false);
    expect(laneRejectsMedia("runcrate", "conn1", "deepseek-v4.1-flash-1017:flex")).toBe(false);
  });

  it("expires the learned mark", () => {
    const now = Date.now();
    markLaneRejectsMedia("runcrate", "conn1", "m", now);
    expect(laneRejectsMedia("runcrate", "conn1", "m", now + 60_000)).toBe(true);
    expect(laneRejectsMedia("runcrate", "conn1", "m", now + 7 * 60 * 60 * 1000)).toBe(false);
    // expired marks are dropped, not carried forward
    expect(laneRejectsMedia("runcrate", "conn1", "m", now + 7 * 60 * 60 * 1000)).toBe(false);
  });

  it("textOnlyCaps clears media capabilities only", () => {
    const caps = { vision: true, audioInput: true, pdf: true, reasoning: true, dropInlineMediaPayloads: true };
    expect(textOnlyCaps(caps)).toMatchObject({
      vision: false,
      audioInput: false,
      pdf: false,
      reasoning: true,
      dropInlineMediaPayloads: true,
    });
  });
});

describe("hasMediaBlocks", () => {
  it("detects openai media parts, images and attachments", () => {
    expect(hasMediaBlocks({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }, FORMATS.OPENAI)).toBe(false);
    expect(hasMediaBlocks({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: IMG } }] }] }, FORMATS.OPENAI)).toBe(true);
    expect(hasMediaBlocks({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] }, FORMATS.OPENAI)).toBe(true);
    expect(hasMediaBlocks({ messages: [{ role: "user", content: "plain" }] }, FORMATS.OPENAI)).toBe(false);
    expect(hasMediaBlocks({ messages: [{ role: "user", content: "", images: [IMG] }] }, FORMATS.OPENAI)).toBe(true);
    expect(hasMediaBlocks({ messages: [{ role: "user", content: "", attachments: [{ url: IMG }] }] }, FORMATS.OPENAI)).toBe(true);
  });

  it("detects claude, responses and gemini media parts", () => {
    expect(hasMediaBlocks({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }, FORMATS.CLAUDE)).toBe(true);
    expect(hasMediaBlocks({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, FORMATS.CLAUDE)).toBe(false);
    expect(hasMediaBlocks({ input: [{ role: "user", content: [{ type: "input_image", image_url: IMG }] }] }, FORMATS.OPENAI_RESPONSES)).toBe(true);
    expect(hasMediaBlocks({ input: [{ role: "user", content: [{ type: "input_text", text: "x" }] }] }, FORMATS.OPENAI_RESPONSES)).toBe(false);
    expect(hasMediaBlocks({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png" } }] }] }, FORMATS.GEMINI)).toBe(true);
    expect(hasMediaBlocks({ contents: [{ role: "user", parts: [{ text: "x" }] }] }, FORMATS.GEMINI)).toBe(false);
    expect(hasMediaBlocks({ request: { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "application/pdf" } }] }] } }, FORMATS.ANTIGRAVITY)).toBe(true);
  });

  it("reports false for empty bodies", () => {
    expect(hasMediaBlocks(null, FORMATS.OPENAI)).toBe(false);
    expect(hasMediaBlocks({}, FORMATS.OPENAI)).toBe(false);
    expect(hasMediaBlocks({ messages: [] }, FORMATS.OPENAI)).toBe(false);
  });

  it("agrees with what the stripping pass removes", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: IMG } },
    ] }] };
    expect(hasMediaBlocks(body, FORMATS.OPENAI)).toBe(true);
    stripUnsupportedModalities(body, FORMATS.OPENAI, textOnlyCaps({ vision: true, audioInput: true, pdf: true }));
    expect(hasMediaBlocks(body, FORMATS.OPENAI)).toBe(false);
    expect(body.messages[0].content[1].text).toMatch(/image omitted/);
  });

  it("blames the lane, not the model, for the stripped media", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: IMG } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, textOnlyCaps({ vision: true, audioInput: true, pdf: true }));
    expect(body.messages[0].content[1].text).toBe("[image omitted: this upstream lane does not accept image input]");
    expect(body.messages[0].content[1].text).not.toMatch(/no vision support/);
  });
});
