import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args) => spawnMock(...args),
}));

const { default: PerchCliExecutor } = await import("open-sse/executors/perch-cli.js");
const { buildPromptText } = await import("open-sse/executors/acp-prompt.js");

function makeFakeChild({ authRequired = false } = {}) {
  const child = new EventEmitter();
  child.writes = [];
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (data) => {
    child.writes.push(String(data));
    try {
      handle(JSON.parse(String(data).trim()));
    } catch {
      /* ignore */
    }
    return true;
  };
  child.stdin.end = () => {
    child.stdin.destroyed = true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };

  const send = (obj) =>
    child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));

  function handle(msg) {
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "perch", version: "2.4.120" },
        },
      });
    } else if (msg.method === "session/new") {
      if (authRequired) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message: "Authentication required" },
        });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session" } });
    } else if (msg.method === "session/prompt") {
      // Perch asks before running a tool, then streams the reply.
      send({
        jsonrpc: "2.0",
        id: 777,
        method: "session/request_permission",
        params: {
          sessionId: "fake-session",
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "(thinking)" } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello world" } },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }

  return child;
}

async function runExecute({ authRequired = false } = {}) {
  const child = makeFakeChild({ authRequired });
  spawnMock.mockImplementation((bin, args, opts) => {
    child.bin = bin;
    child.args = args;
    child.opts = opts;
    return child;
  });
  const exec = new PerchCliExecutor();
  const { response } = await exec.execute({
    model: "roost",
    body: { messages: [{ role: "user", content: "hi" }] },
    credentials: CREDENTIALS,
    log: { info() {}, debug() {} },
  });
  const reader = response.body.getReader();
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  return { acc, child };
}

const CREDENTIALS = {
  connectionId: "perch-test-conn",
  accessToken: "sb-access-token",
  refreshToken: "sb-refresh-token",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  providerSpecificData: {
    appUrl: "https://app.perchai.app",
    userId: "user-1",
    email: "perch@example.com",
  },
};

function makeFakeRunChild(stdout, { stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  child.finishRun = () => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  };
  return child;
}

async function runPinned(stdout, model = "qwen-3.8-max", runOpts = {}, creds = CREDENTIALS) {
  const child = makeFakeRunChild(stdout, runOpts);
  spawnMock.mockReset();
  spawnMock.mockImplementation((bin, args, opts) => {
    child.bin = bin;
    child.args = args;
    child.opts = opts;
    return child;
  });
  const warnings = [];
  const exec = new PerchCliExecutor();
  const { response } = await exec.execute({
    model,
    body: { messages: [{ role: "user", content: "hi" }] },
    credentials: creds,
    log: { info() {}, debug() {}, warn: (...a) => warnings.push(a.join(" ")) },
  });
  child.finishRun();
  const reader = response.body.getReader();
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
  }
  return { acc, child, warnings };
}

const written = (child) => child.writes.map((w) => JSON.parse(w.trim()));

describe("PerchCliExecutor ACP flow", () => {
  it("spawns `perch acp` in a temp cwd", async () => {
    const { child } = await runExecute();
    expect(child.args).toEqual(["acp"]);
    expect(child.opts.cwd).toBe(os.tmpdir());
  });

  it("sends session/new with mcpServers as an array", async () => {
    const { child } = await runExecute();
    const newMsg = written(child).find((m) => m.method === "session/new");
    expect(newMsg).toBeTruthy();
    expect(newMsg.params.mcpServers).toEqual([]);
    expect(newMsg.params.cwd).toBe(os.tmpdir());
  });

  it("sends session/prompt with prompt as an array", async () => {
    const { child } = await runExecute();
    const promptMsg = written(child).find((m) => m.method === "session/prompt");
    expect(promptMsg).toBeTruthy();
    expect(promptMsg.params.prompt).toEqual([{ type: "text", text: "[User]\nhi" }]);
  });

  it("streams agent_message_chunk and skips agent_thought_chunk", async () => {
    const { acc } = await runExecute();
    expect(acc).toContain("hello world");
    expect(acc).not.toContain("(thinking)");
    expect(acc).toContain('"finish_reason":"stop"');
    expect(acc).toContain("data: [DONE]");
  });

  it("denies permission prompts by default", async () => {
    const { child } = await runExecute();
    const reply = written(child).find((m) => m.id === 777);
    expect(reply.result.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("writes the Supabase session where the CLI reads it", async () => {
    const { child } = await runExecute();
    const authDir = child.opts.env.PERCH_CLI_AUTH_DIR;
    expect(authDir).toBeTruthy();
    expect(child.opts.env.PERCH_CLI_SETTINGS_DIR).toBe(authDir);

    const session = JSON.parse(
      fs.readFileSync(path.join(authDir, "cli-auth-session.json"), "utf8"),
    );
    expect(session.version).toBe(1);
    expect(session.appUrl).toBe("https://app.perchai.app");
    expect(session.accessToken).toBe("sb-access-token");
    expect(session.refreshToken).toBe("sb-refresh-token");
    expect(session.userId).toBe("user-1");
    expect(session.email).toBe("perch@example.com");
    // Perch treats expiresAt as epoch SECONDS.
    expect(session.expiresAt).toBeGreaterThan(1_700_000_000);
    expect(session.expiresAt).toBeLessThan(4_000_000_000);
    expect(session.updatedAt).toBeTruthy();
  });

  it("surfaces a reconnect hint when Perch rejects the session", async () => {
    const { acc } = await runExecute({ authRequired: true });
    expect(acc).toContain("Reconnect");
    expect(acc).toContain("Perch CLI");
  });
});

describe("PerchCliExecutor named model flow", () => {
  it("runs `perch run` with the model slug and a unique thread", async () => {
    const { child } = await runPinned(
      JSON.stringify({ ok: true, status: "completed", assistantText: "QWEN-OK", events: [] }),
    );
    expect(child.args[0]).toBe("run");
    expect(child.args).toContain("--model");
    expect(child.args[child.args.indexOf("--model") + 1]).toBe("qwen-3.8-max");
    const thread = child.args[child.args.indexOf("--thread") + 1];
    expect(thread).toMatch(/^9router-/);
    expect(child.args).toContain("--json");
    expect(child.args).toContain("--mode");
  });

  it("emits the buffered assistantText as one chunk", async () => {
    const { acc } = await runPinned(
      JSON.stringify({ ok: true, status: "completed", assistantText: "QWEN-OK", events: [] }),
    );
    expect(acc).toContain("QWEN-OK");
    expect(acc).toContain('"finish_reason":"stop"');
    expect(acc).toContain("data: [DONE]");
  });

  it("surfaces the failing model call instead of an empty reply", async () => {
    const { acc } = await runPinned(
      JSON.stringify({
        ok: false,
        status: "failed",
        assistantText: "",
        events: [
          { type: "model_call_failed", error: "openrouter is not configured for auto routing" },
          { type: "turn_failed", error: "stream exhausted" },
        ],
      }),
    );
    expect(acc).toContain("stream exhausted");
    expect(acc).not.toContain('"finish_reason":"stop"');
  });

  it("turns the plan gate message into an actionable error", async () => {
    const { acc } = await runPinned(
      JSON.stringify({
        ok: true,
        status: "completed",
        assistantText: "This account needs a plan before Perch can answer.",
        events: [],
      }),
    );
    expect(acc).toContain("Choose Starter");
    expect(acc).toContain("chat.perchai.app");
  });

  it("matches the interactive plan refusal wording too", async () => {
    const { acc } = await runPinned(
      JSON.stringify({
        ok: true,
        status: "completed",
        assistantText: "Perch needs a plan on this account before it can answer.",
        events: [],
      }),
    );
    expect(acc).toContain("Choose Starter");
  });

  it("treats status failed as failure even without ok:false", async () => {
    const { acc, warnings } = await runPinned(
      JSON.stringify({
        status: "failed",
        assistantText: "",
        error: "model route exhausted",
        events: [],
      }),
    );
    expect(acc).toContain("model route exhausted");
    expect(acc).not.toContain('"finish_reason":"stop"');
    expect(warnings.join("\n")).toContain("model route exhausted");
  });

  it("surfaces event errors when ok is true but text is empty", async () => {
    const { acc } = await runPinned(
      JSON.stringify({
        ok: true,
        status: "completed",
        assistantText: "",
        events: [{ type: "model_call_failed", error: "This model's quota is used up for now." }],
      }),
    );
    expect(acc).toContain("quota is used up");
    expect(acc).not.toContain("empty reply");
  });

  it("includes exit code and stderr when stdout is not JSON", async () => {
    const { acc } = await runPinned("", "qwen-3.8-max", {
      stderr: "Unknown model: qwen-3.8-max. Try a tier (standard, pro)",
      code: 1,
    });
    expect(acc).toContain("exit 1");
    expect(acc).toContain("Unknown model");
  });

  it("short-circuits pins after a direct-API block without spawning", async () => {
    const creds = { ...CREDENTIALS, connectionId: "perch-blocked-conn" };
    const blocked = JSON.stringify({
      ok: false,
      status: "failed",
      assistantText: "",
      error:
        "Your plan includes Perch-hosted models for use in Perch AI Web, Desktop, and CLI only. Direct API access is not included. Repeated direct-access attempts may result in account suspension.",
      events: [],
    });
    const first = await runPinned(blocked, "qwen-3.8-max", {}, creds);
    expect(first.acc).toContain("Direct API access is not included");
    spawnMock.mockReset();
    const second = await runPinned(blocked, "laguna-s", {}, creds);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(second.acc).toContain("blocks manual model pins");
    expect(second.acc).toContain("perch-cli/roost");
  });
});

describe("buildPromptText content parts", () => {
  it("keeps Responses-style input_text/output_text parts", () => {
    const text = buildPromptText([
      { role: "user", content: [{ type: "input_text", text: "list files" }] },
      { role: "assistant", content: [{ type: "output_text", text: "here" }] },
    ]);
    expect(text).toContain("list files");
    expect(text).toContain("here");
    expect(text).not.toBe("(empty)");
  });
});
