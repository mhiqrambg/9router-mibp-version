import { describe, it, expect } from "vitest";

import { stripHistoryForContext, withCapacityAdapterStripping } from "../../open-sse/services/capacityAdapter.js";

// stripHistoryForContext runs for every capacity-adapter candidate (e.g. cx/gpt-5.6-terra
// at 272k) before the request leaves the gateway. Two invariants matter:
//   1. a history that fits the window is left untouched;
//   2. whatever is dropped never splits an assistant tool call from its result, because
//      Responses upstreams reject the surviving output with
//      "No tool call found for function call output with call_id ...".

function turn(i, text = "ok") {
  return [
    { role: "assistant", content: "", tool_calls: [{ id: `call_${i}_0`, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", content: text, tool_call_id: `call_${i}_0` },
  ];
}

function chatBody(turns, pad = "") {
  const messages = [{ role: "system", content: `sys ${pad}` }];
  for (let i = 0; i < turns; i++) messages.push(...turn(i, `result ${i} ${pad}`));
  messages.push({ role: "user", content: "lanjut" });
  return { model: "m", messages };
}

function orphanedToolIds(body) {
  const ids = [];
  const calls = new Set();
  for (const m of body.messages || []) {
    for (const tc of m.tool_calls || []) calls.add(tc.id);
  }
  for (const m of body.messages || []) {
    if (m.role === "tool" && m.tool_call_id && !calls.has(m.tool_call_id)) ids.push(m.tool_call_id);
  }
  return ids;
}

function unpairedToolIds(body) {
  const calls = new Set();
  const outputs = new Set();
  for (const m of body.messages || []) {
    for (const tc of m.tool_calls || []) calls.add(tc.id);
    if (m.role === "tool" && m.tool_call_id) outputs.add(m.tool_call_id);
  }
  return {
    outputsWithoutCalls: [...outputs].filter((id) => !calls.has(id)),
    callsWithoutOutputs: [...calls].filter((id) => !outputs.has(id)),
  };
}

describe("stripHistoryForContext", () => {
  it("leaves a fitting history untouched, even when longer than HEAD_KEEP", () => {
    const body = chatBody(12);
    expect(stripHistoryForContext(body, 272000)).toBe(body);
    expect(orphanedToolIds(body)).toEqual([]);
  });

  it("trims the middle of an oversized history without orphaning the trailing tool result", () => {
    const pad = "x".repeat(300);
    const body = chatBody(12, pad);
    const out = stripHistoryForContext(body, 1000); // 3200-char budget, body is ~4.1k

    expect(out).not.toBe(body);
    const msgs = out.messages;
    expect(msgs[0].role).toBe("system");
    expect(msgs[1]).toEqual(body.messages[1]); // head instructions stay verbatim
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "lanjut" });
    expect(orphanedToolIds(out)).toEqual([]);

    // The kept tool round carries its call.
    const lastCall = msgs.filter((m) => m.role === "assistant" && m.tool_calls).pop();
    expect(msgs.includes(lastCall)).toBe(true);
    const lastTool = msgs.filter((m) => m.role === "tool").pop();
    expect(lastTool.tool_call_id).toBe(lastCall.tool_calls[0].id);

    // It actually shrank.
    expect(msgs.length).toBeLessThan(body.messages.length);
  });

  it("hands a production-sized history to the adapter model untouched", () => {
    // The wrapper is what the gateway calls for capacity-adapter candidates
    // (cx/gpt-5.6-terra, 272k). A ~16k-char history is far below 80% of that window,
    // so the adapter must receive the exact body the caller sent.
    const body = chatBody(40, "z".repeat(200));
    let seen = null;
    const wrapped = withCapacityAdapterStripping((b) => { seen = b; return b; }, ["cx/gpt-5.6-terra"]);
    wrapped(body, "cx/gpt-5.6-terra");
    expect(seen).toBe(body);
    expect(orphanedToolIds(seen)).toEqual([]);
  });

  it("drops a head tail that would keep a call but lose its tool result", () => {
    // Real conversations start with a user turn, so a verbatim HEAD_KEEP of 6 ends on
    // an assistant tool call (user, a, t, a, t, a). Cutting there hands the upstream a
    // call whose result sits in the dropped middle: "No tool output found for function
    // call ...". The head must retreat to its last complete pair.
    const pad = "x".repeat(3000);
    const body = { model: "m", messages: [{ role: "system", content: "sys" }, { role: "user", content: `start ${pad}` }] };
    for (let i = 0; i < 12; i++) body.messages.push(...turn(i, `result ${i} ${pad}`));
    body.messages.push({ role: "user", content: "lanjut" });

    const out = stripHistoryForContext(body, 8000); // 25.6k budget; body is ~39k
    expect(out).not.toBe(body);
    expect(unpairedToolIds(out)).toEqual({ outputsWithoutCalls: [], callsWithoutOutputs: [] });
    expect(out.messages.length).toBeLessThan(body.messages.length);

    // The kept head still starts with the original user turn.
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[1]).toEqual(body.messages[1]);
  });

  it("keeps Responses-shaped function_call/function_call_output pairs together", () => {
    const pad = "y".repeat(4000);
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: `start ${pad}` }] }];
    for (let i = 0; i < 10; i++) {
      input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] });
      input.push({ type: "function_call", call_id: `call_${i}_0`, name: "bash", arguments: "{}" });
      input.push({ type: "function_call_output", call_id: `call_${i}_0`, output: `r ${i} ${pad}` });
    }
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "lanjut" }] });

    const out = stripHistoryForContext({ model: "m", input }, 1000);
    expect(out).not.toBe(undefined);
    const items = out.input;
    const calls = new Set(items.filter((x) => x.type === "function_call").map((x) => x.call_id));
    const orphans = items.filter((x) => x.type === "function_call_output" && !calls.has(x.call_id));
    expect(orphans).toEqual([]);
    expect(items.length).toBeLessThan(input.length);
  });
});
