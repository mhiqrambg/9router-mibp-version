import { describe, it, expect, vi } from "vitest";
import { checkEndpointUrl } from "@/shared/utils/endpointUrl.js";
import { isInternalUrl } from "@/shared/utils/ssrfGuard.js";

describe("provider endpoint guard", () => {
  it("rejects malformed and non-http URLs", () => {
    expect(checkEndpointUrl("not a url").ok).toBe(false);
    expect(checkEndpointUrl("ftp://example.com/v1").ok).toBe(false);
    expect(checkEndpointUrl("http://example.com/v1").ok).toBe(true);
    expect(checkEndpointUrl("https://example.com/v1").ok).toBe(true);
  });

  it("refuses private targets from a remote dashboard", () => {
    for (const url of [
      "http://127.0.0.1:1234/v1",
      "http://localhost:1234/v1",
      "http://10.0.0.5/v1",
      "http://192.168.1.9:8080/v1",
      "http://gateway.internal/v1",
    ]) {
      expect(checkEndpointUrl(url, { allowPrivate: false }).ok, url).toBe(false);
    }
  });

  it("allows a self-hosted gateway from the local dashboard", () => {
    for (const url of [
      "http://127.0.0.1:1234/v1",
      "http://localhost:1234/v1",
      "http://192.168.1.9:8080/v1",
      "http://gateway.internal/v1",
    ]) {
      expect(checkEndpointUrl(url, { allowPrivate: true }).ok, url).toBe(true);
    }
  });

  it("always refuses cloud metadata, even locally", () => {
    for (const url of [
      "http://169.254.169.254/latest",
      "http://100.100.100.200/latest",
      "http://[fd00:ec2::254]/latest",
    ]) {
      expect(checkEndpointUrl(url, { allowPrivate: true }).ok, url).toBe(false);
    }
  });

  it("keeps the rest of CGNAT usable (Tailscale gateways)", () => {
    expect(checkEndpointUrl("http://100.101.102.103:11434/v1", { allowPrivate: true }).ok).toBe(true);
  });

  it("distinguishes literal internal hosts from public ones", () => {
    expect(isInternalUrl("http://127.0.0.1:1234/v1")).toBe(true);
    expect(isInternalUrl("http://localhost:1234/v1")).toBe(true);
    expect(isInternalUrl("http://[::1]:1234/v1")).toBe(true);
    expect(isInternalUrl("http://gateway.internal/v1")).toBe(true);
    expect(isInternalUrl("https://api.openai.com/v1")).toBe(false);
  });
});

describe("executor dispatch guard", () => {
  it("refuses a saved metadata endpoint before any network call", async () => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const executor = new DefaultExecutor("openai-compatible-chat-test", {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { response } = await executor.execute({
      model: "test-model",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "sk-test", providerSpecificData: { baseUrl: "http://169.254.169.254/v1" } },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("private endpoint allowance", () => {
  it("counts a loopback Host as local (Docker publishes to 127.0.0.1)", async () => {
    const { allowsPrivateEndpoint } = await import("@/dashboardGuard.js");
    const request = (host) => ({ headers: new Headers({ host }) });

    expect(allowsPrivateEndpoint(request("localhost:20128"))).toBe(true);
    expect(allowsPrivateEndpoint(request("127.0.0.1:20128"))).toBe(true);
    expect(allowsPrivateEndpoint(request("[::1]:20128"))).toBe(true);
    expect(allowsPrivateEndpoint(request("9router.example.com"))).toBe(false);
    expect(allowsPrivateEndpoint(request("192.168.1.20:20128"))).toBe(false);
  });
});
