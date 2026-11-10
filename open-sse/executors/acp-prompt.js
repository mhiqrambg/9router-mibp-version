// Shared ACP prompt flattening for CLI providers (devin-cli).
// ACP takes a single prompt turn, so the whole conversation — including prior
// tool_calls / tool_results — is inlined as text.

export function buildPromptText(messages) {
  const lines = [];
  for (const m of messages) {
    const role = String(m.role || "user");
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === "string") {
          text += p;
          continue;
        }
        if (!p || typeof p !== "object") continue;
        // Responses-style parts use input_text/output_text with the same
        // shape as chat `text` parts — same convention as
        // muse-web/prompt.js and chatgpt-web/adapter.js.
        if (p.type === "text" || p.type === "input_text" || p.type === "output_text")
          text += String(p.text ?? p.input_text ?? "");
        else if (p.type === "tool_use") {
          text += `\n[Tool call ${p.name} id=${p.id}]\n${JSON.stringify(p.input ?? {})}\n`;
        } else if (p.type === "tool_result") {
          const c =
            typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
          text += `\n[Tool result id=${p.tool_use_id}]\n${c}\n`;
        }
      }
    }
    // OpenAI tool_calls on assistant messages
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = m.tool_calls.map((tc) => {
        const name = tc.function?.name || tc.name || "tool";
        const args = tc.function?.arguments ?? tc.arguments ?? {};
        const argStr = typeof args === "string" ? args : JSON.stringify(args);
        return `[Tool call ${name} id=${tc.id}]\n${argStr}`;
      });
      text = [text, ...parts].filter(Boolean).join("\n\n");
    }
    // OpenAI role=tool messages
    if (role === "tool") {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      text = `[Tool result id=${m.tool_call_id || ""}]\n${c}`;
    }
    if (!text.trim()) continue;
    if (role === "system") {
      lines.push(`[System]\n${text}`);
    } else if (role === "assistant") {
      lines.push(`[Assistant]\n${text}`);
    } else if (role === "tool") {
      lines.push(`[Tool]\n${text}`);
    } else {
      lines.push(`[User]\n${text}`);
    }
  }
  return lines.join("\n\n") || "(empty)";
}
