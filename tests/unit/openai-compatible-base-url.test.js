import { describe, it, expect } from "vitest";
import { normalizeOpenAICompatibleBaseUrl as normalize } from "@/shared/utils/baseUrl.js";

describe("openai-compatible base URL", () => {
  it("strips a pasted endpoint so the runtime cannot double-append it", () => {
    // The bug from the field: base URL saved as the full endpoint made every
    // request hit /v1/chat/completions/chat/completions and 404, while Test
    // Connection blamed the API key.
    expect(normalize("https://nutaraline.co.uk/v1/chat/completions")).toBe("https://nutaraline.co.uk/v1");
    expect(normalize("https://nutaraline.co.uk/v1/chat/completions/")).toBe("https://nutaraline.co.uk/v1");
    expect(normalize("https://api.openai.com/v1/responses")).toBe("https://api.openai.com/v1");
  });

  it("leaves an API root alone", () => {
    expect(normalize("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalize("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalize("  https://gateway.example.com/openai/v1  ")).toBe("https://gateway.example.com/openai/v1");
    expect(normalize("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });

  it("only strips the suffix at the end of the path", () => {
    // A path segment that merely contains the words must survive untouched.
    expect(normalize("https://x/v1/chat/completions-proxy")).toBe("https://x/v1/chat/completions-proxy");
    expect(normalize("https://x/chat/completions/v1")).toBe("https://x/chat/completions/v1");
  });
});
