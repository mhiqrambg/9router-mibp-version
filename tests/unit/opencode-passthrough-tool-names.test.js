import { describe, expect, it } from "vitest";

import { restoreToolNames } from "../../open-sse/utils/opencodeFingerprint.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

function sseChunk(name) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "{}" } }],
        },
      },
    ],
  };
}

function lineOf(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function collectPassthrough(lines, toolNameMap = null) {
  const encoder = new TextEncoder();
  const input = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  const reader = input
    .pipeThrough(createPassthroughStreamWithLogger(null, null, "test-model", null, null, null, null, toolNameMap))
    .getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("restoreToolNames concealment-suffix fallback", () => {
  it("strips the _client suffix without a rename map", () => {
    const restored = restoreToolNames(sseChunk("read_client"), null);
    expect(restored.choices[0].delta.tool_calls[0].function.name).toBe("read");
  });

  it("strips numbered suffixes left by repeated renames", () => {
    expect(restoreToolNames(sseChunk("read_client2"), null).choices[0].delta.tool_calls[0].function.name).toBe("read");
    expect(restoreToolNames(sseChunk("shell_client"), null).choices[0].delta.tool_calls[0].function.name).toBe("shell");
  });

  it("leaves unrelated *_client tools alone and keeps payload identity", () => {
    const payload = sseChunk("custom_client");
    expect(restoreToolNames(payload, null)).toBe(payload);
  });

  it("prefers the per-request rename map over the suffix fallback", () => {
    const map = new Map([["read_client", "my_reader"]]);
    expect(restoreToolNames(sseChunk("read_client"), map).choices[0].delta.tool_calls[0].function.name).toBe("my_reader");
  });
});

describe("passthrough SSE tool-name restore", () => {
  it("rewrites fingerprint aliases back to the caller's names", async () => {
    const out = await collectPassthrough([lineOf(sseChunk("read_client")), "data: [DONE]\n\n"]);
    expect(out).toContain('"name":"read"');
    expect(out).not.toContain("read_client");
  });

  it("keeps untouched chunks byte-identical", async () => {
    const payload = sseChunk("write_file");
    const out = await collectPassthrough([lineOf(payload), "data: [DONE]\n\n"]);
    expect(out).toContain(`data: ${JSON.stringify(payload)}`);
  });

  it("applies the rename map when the passthrough stream receives one", async () => {
    const map = new Map([["read_client", "my_reader"]]);
    const out = await collectPassthrough([lineOf(sseChunk("read_client")), "data: [DONE]\n\n"], map);
    expect(out).toContain('"name":"my_reader"');
  });
});
