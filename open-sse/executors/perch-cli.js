/**
 * PerchCliExecutor — routes completions through the official Perch CLI
 * (`perch acp`) via the Agent Client Protocol (ACP) JSON-RPC 2.0 over stdio.
 *
 * Protocol flow:
 *   1. Spawn `perch acp`.
 *   2. initialize → session/new { cwd, mcpServers } → session/prompt.
 *   3. Stream `session/update` notifications with
 *      update.sessionUpdate === "agent_message_chunk".
 *   4. Emit deltas as OpenAI-compatible SSE chunks, kill on completion.
 *
 * Auth: OAuth (Perch's Supabase Auth, one connection per account). Each
 * connection gets its own directory under DATA_DIR holding the
 * `cli-auth-session.json` shape the CLI expects; the subprocess is spawned with
 * PERCH_CLI_AUTH_DIR (and PERCH_CLI_SETTINGS_DIR) pointing there. That is what
 * lets several Perch accounts coexist without touching ~/.perch. 9router
 * refreshes the Supabase token before it expires, so the CLI itself never has
 * to rotate the refresh token behind the DB's back.
 * If Perch still answers -32000 "Authentication required" we surface a
 * reconnect hint instead of an opaque protocol error.
 *
 * Model: `perch acp` has no model selector — session/new and session/prompt
 * carry no model, and the ACP session ignores `manualModelOptionId` from
 * cli-settings.json. "roost" therefore uses the ACP path (Perch's Roost router).
 * Any other registry model id is a Perch option slug (e.g. "qwen-3.8-max") and
 * runs one buffered `perch run --json --model <slug>` turn with a unique thread
 * id, so replies arrive as a single chunk instead of a token stream.
 *
 * Tools: Perch ignores client-supplied mcpServers (it only reads
 * ~/.perch/mcp.json and ./.perch/mcp.json), so OpenAI tool calling is not
 * bridged. Permission prompts are denied unless PERCH_CLI_AUTO_APPROVE=1,
 * because auto-approving would let a remote model run shell commands here.
 *
 * Binary discovery: CLI_PERCH_BIN env → same bin dir as the running node
 * (nvm/npm global) → common npm global locations → PATH.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "./base.js";
import { buildPromptText } from "./acp-prompt.js";
import { DATA_DIR } from "../../src/lib/dataDir.js";

const ACP_PROTOCOL_VERSION = 1;

// Write the Supabase session in the exact shape perch reads from
// PERCH_CLI_AUTH_DIR (version/appUrl/accessToken/updatedAt are required;
// expiresAt is epoch SECONDS).
function writePerchSession(credentials) {
  const psd = credentials.providerSpecificData || {};
  const dir = path.join(
    DATA_DIR,
    "perch-cli",
    String(credentials.connectionId || "default").replace(/[^\w.-]/g, "_"),
  );
  const expiresAtMs = credentials.expiresAt ? new Date(credentials.expiresAt).getTime() : NaN;
  const session = {
    version: 1,
    appUrl: psd.appUrl || "https://app.perchai.app",
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken || null,
    expiresAt: Number.isFinite(expiresAtMs) ? Math.floor(expiresAtMs / 1000) : null,
    userId: psd.userId || null,
    email: psd.email || credentials.email || null,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "cli-auth-session.json"), JSON.stringify(session, null, 2), {
    mode: 0o600,
  });
  return dir;
}

function resolvePerchBin() {
  const envBin = process.env.CLI_PERCH_BIN?.trim();
  if (envBin) return envBin;

  const isWin = process.platform === "win32";
  const home = os.homedir();
  const exe = isWin ? "perch.cmd" : "perch";

  const candidates = [
    // npm global installs share the running node's bin dir (nvm, Homebrew node).
    path.join(path.dirname(process.execPath), exe),
    ...(isWin
      ? [
        path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm", exe),
        path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "npm", exe),
      ]
      : [
        path.join(home, ".local", "bin", exe),
        path.join(home, ".npm-global", "bin", exe),
        "/opt/homebrew/bin/perch",
        "/usr/local/bin/perch",
        "/usr/bin/perch",
      ]),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return exe;
}

function rpc(method, params, id) {
  const msg = { jsonrpc: "2.0", method, params };
  if (id !== undefined) msg.id = id;
  return JSON.stringify(msg) + "\n";
}

function extractResultText(result) {
  if (typeof result?.content === "string") return result.content;
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.message?.content === "string") return result.message.content;
  const msgs = result?.messages;
  if (Array.isArray(msgs)) {
    return msgs
      .filter((m) => m.role === "assistant")
      .map((m) => String(m.content || ""))
      .join("\n");
  }
  return "";
}

// `perch run --json` prints one JSON document on stdout. Anything else on
// stdout means the CLI bailed before running (e.g. "Unknown model: ...").
function parsePerchRunJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to a trailing-object parse */
  }
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

// Connections whose plan the server has refused a manual pin on
// (`perch_surface_required` — the plan treats named slugs as direct API
// access). Remembered per process so a blocked account stops after ONE
// failed attempt instead of risking suspension with repeats. Roost (ACP)
// is unaffected and keeps working.
const PIN_BLOCKED = new Set();
const PIN_BLOCK_RE = /direct API access is not included|perch_surface_required/i;
const PIN_BLOCKED_MSG =
  "This Perch account's plan blocks manual model pins (Perch counts named models as direct API access). Use perch-cli/roost instead.";

// Last failing model/turn event, if any — surfaced instead of a generic
// "empty reply" when the CLI ran but produced no text (e.g. quota/route
// failure recorded in events while `ok` stayed truthy).
function eventFailure(parsed) {
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "turn_failed" || event?.type === "model_call_failed") {
      const msg = event.error || event.message;
      if (msg) return String(msg);
      if (event.limit?.limitKind) return `Perch limit reached (${event.limit.limitKind})`;
    }
  }
  return null;
}

function perchRunError(parsed) {
  const err = parsed?.error;
  if (typeof err === "string" && err) return err;
  if (err?.message) return err.message;
  return eventFailure(parsed) || `Perch run failed (${parsed?.status || "unknown"})`;
}

export class PerchCliExecutor extends BaseExecutor {
  constructor() {
    super("perch-cli", { id: "perch-cli", baseUrl: "perch://acp/stdio" });
  }

  buildUrl() {
    return "perch://acp/stdio";
  }

  buildHeaders() {
    return {};
  }

  transformRequest() {
    return null;
  }

  async execute({ model, body, credentials, signal, log }) {
    if (!credentials?.accessToken) {
      throw new Error("Perch connection has no access token — reconnect the account from Providers → Perch CLI.");
    }
    const b = body ?? {};
    const messages = Array.isArray(b.messages)
      ? b.messages
      : Array.isArray(b.input)
        ? b.input
        : [];
    const promptText = buildPromptText(messages);
    const perchBin = resolvePerchBin();
    // Named models run one buffered `perch run` turn; "roost" keeps the
    // streaming ACP path.
    const pinnedModel = model && model !== "roost" ? model : null;
    // Chat-only proxy: keep Perch away from the user's project folder so its
    // file tools cannot read or modify a real repo.
    const cwd = os.tmpdir();
    const autoApprove = process.env.PERCH_CLI_AUTO_APPROVE === "1";
    const authDir = writePerchSession(credentials);

    log?.info?.(
      "PERCH",
      `perch ${pinnedModel ? `run --model ${pinnedModel}` : "acp"} → bin=${perchBin}, cwd=${cwd}, authDir=${authDir}`
    );

    const sseStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const emit = (data) => controller.enqueue(enc.encode(data));

        const responseId = `chatcmpl-perch-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        let idCounter = 1;
        let initDone = false;
        let sessionCreated = false;
        let promptSent = false;
        let roleEmitted = false;
        let totalText = "";
        let finished = false;
        let stdinClosed = false;
        let spawnError = null;
        let child = null;

        const emitDelta = (delta) => {
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
              })}\n\n`
            );
            roleEmitted = true;
          }
          totalText += delta;
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`
          );
        };

        const finish = (error, finishReason = "stop") => {
          if (finished) return;
          finished = true;

          if (error) {
            emit(
              `data: ${JSON.stringify({ error: { message: error, type: "perch_cli_error" } })}\n\n`
            );
          } else {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage: {
                  prompt_tokens: Math.ceil(promptText.length / 4),
                  completion_tokens: Math.ceil(totalText.length / 4),
                  total_tokens: Math.ceil((promptText.length + totalText.length) / 4),
                  estimated: true,
                },
              })}\n\n`
            );
          }
          emit("data: [DONE]\n\n");

          try {
            if (child && !stdinClosed) {
              stdinClosed = true;
              child.stdin.end();
            }
          } catch {
            /* ignore */
          }

          const killTimer = setTimeout(() => {
            if (child && !child.killed) child.kill("SIGKILL");
          }, 2000);
          killTimer.unref?.();

          controller.close();
        };

        const spawnErrorMessage = (err) =>
          err.message.includes("ENOENT") || err.message.includes("not found")
            ? `Perch CLI not found (${perchBin}). Install with \`npm install -g perchai-cli\` or set CLI_PERCH_BIN.`
            : `Perch CLI spawn error: ${err.message}`;

        // ACP has no model selector. A named model therefore runs one buffered
        // `perch run` turn: same account/session, JSON output instead of SSE.
        // Each request gets its own thread id so threads never share history.
        if (pinnedModel) {
          const pinKey = String(credentials.connectionId || "default");
          if (PIN_BLOCKED.has(pinKey)) {
            // Plan already refused a pin on this connection — fail without
            // spawning so this attempt can't count toward suspension.
            emit(
              `data: ${JSON.stringify({ error: { message: PIN_BLOCKED_MSG, type: "perch_cli_error" } })}\n\n`
            );
            emit("data: [DONE]\n\n");
            controller.close();
            return;
          }
          const threadId = `9router-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          child = spawn(
            perchBin,
            [
              "run",
              promptText,
              "--json",
              "--mode",
              "ask",
              "--model",
              pinnedModel,
              "--thread",
              threadId,
              "--cwd",
              cwd,
            ],
            {
              cwd,
              env: {
                ...process.env,
                // Perch bootstraps ~/.perch. In Docker HOME is /root, which the
                // node user cannot write; point it at the per-connection dir.
                HOME: authDir,
                PERCH_CLI_AUTH_DIR: authDir,
                PERCH_CLI_SETTINGS_DIR: authDir,
              },
              stdio: ["ignore", "pipe", "pipe"],
            }
          );

          if (signal) {
            signal.addEventListener("abort", () => {
              if (!child.killed) child.kill("SIGTERM");
            });
          }

          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            log?.debug?.("PERCH", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
          });
          child.on("error", (err) => finish(spawnErrorMessage(err)));
          child.on("close", (code) => {
            if (finished) return;
            const parsed = parsePerchRunJson(stdout);
            const stderrTail = stderr.trim().split("\n").slice(-3).join("\n").slice(0, 500);
            // A finish(error) emits an error chunk with no usage, so combo
            // logs show only "empty (no-content)". Log the cause server-side.
            const fail = (message) => {
              if (PIN_BLOCK_RE.test(message)) PIN_BLOCKED.add(pinKey);
              log?.warn?.(
                "PERCH",
                `run --model ${pinnedModel} failed: ${message} (status=${parsed?.status ?? "?"}, exit=${code}${stderrTail ? `, stderr=${stderrTail}` : ""})`
              );
              finish(message);
            };
            if (!parsed) {
              fail(
                stderrTail
                  ? `Perch CLI failed (exit ${code}): ${stderrTail}`
                  : (() => {
                      const firstLine = stdout.trim().split("\n")[0]?.slice(0, 200);
                      return firstLine
                        ? `Perch CLI: ${firstLine}`
                        : `Perch CLI returned no output (exit ${code}). Check \`perch status\` and CLI_PERCH_BIN.`;
                    })()
              );
              return;
            }
            if (parsed.ok === false || parsed.status === "failed") {
              fail(perchRunError(parsed));
              return;
            }
            const text = typeof parsed.assistantText === "string" ? parsed.assistantText : "";
            if (!text.trim()) {
              fail(eventFailure(parsed) || "Perch returned an empty reply.");
              return;
            }
            // CLI refusal wording: "Perch needs a plan on this account before
            // it can answer." (interactive) / "This account needs a plan
            // before Perch can answer. ..." (headless).
            if (/needs a plan .*before .* can answer/i.test(text)) {
              fail(
                "This Perch account has no plan yet. Choose Starter at https://chat.perchai.app (or run `perch` once) and retry."
              );
              return;
            }
            emitDelta(text);
            finish();
          });
          return;
        }

        child = spawn(perchBin, ["acp"], {
          cwd,
          env: {
            ...process.env,
            HOME: authDir,
            PERCH_CLI_AUTH_DIR: authDir,
            PERCH_CLI_SETTINGS_DIR: authDir,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        const sendRpc = (method, params) => {
          if (stdinClosed || child.stdin.destroyed) return;
          const id = idCounter++;
          try {
            child.stdin.write(rpc(method, params, id));
          } catch {
            /* ignore write errors after close */
          }
          return id;
        };

        const authError = () =>
          "Perch rejected this account's session. Reconnect it from Providers → Perch CLI (Sign in again).";

        child.on("error", (err) => {
          spawnError = err;
          emit(
            `data: ${JSON.stringify({ error: { message: spawnErrorMessage(err), type: "perch_cli_error", code: "spawn_failed" } })}\n\n`
          );
          emit("data: [DONE]\n\n");
          if (!finished) {
            finished = true;
            controller.close();
          }
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            if (!child.killed) child.kill("SIGTERM");
          });
        }

        let buffer = "";

        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;

            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue; // banner text, not JSON-RPC
            }

            // ── Initialize response → open a session ─────────────────────
            if (!initDone && msg.result !== undefined && !msg.method) {
              initDone = true;
              sendRpc("session/new", { cwd, mcpServers: [] });
              continue;
            }

            // ── session/new response → send the prompt ───────────────────
            if (initDone && !sessionCreated && msg.result !== undefined && !msg.method) {
              const sessionId = msg.result?.sessionId;
              if (!sessionId) {
                finish("Perch ACP: session/new returned no sessionId");
                return;
              }
              sessionCreated = true;
              promptSent = true;
              sendRpc("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: promptText }],
              });
              continue;
            }

            // ── session/prompt final result ──────────────────────────────
            if (sessionCreated && promptSent && msg.result !== undefined && !msg.method) {
              if (!roleEmitted) {
                const content = extractResultText(msg.result);
                if (content) emitDelta(content);
              }
              finish();
              return;
            }

            // ── Permission prompts → deny unless explicitly allowed ─────
            if (msg.method === "session/request_permission" && msg.id !== undefined) {
              const options = msg.params?.options || [];
              const allow = autoApprove
                ? options.find((o) => /allow/i.test(String(o.kind || ""))) || options[0]
                : options.find((o) => /reject/i.test(String(o.kind || "")));
              const result = allow
                ? { outcome: { outcome: "selected", optionId: allow.optionId } }
                : { outcome: { outcome: "cancelled" } };
              try {
                child.stdin.write(
                  JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n"
                );
              } catch {
                /* ignore */
              }
              continue;
            }

            // ── Streaming notifications ──────────────────────────────────
            if (msg.method === "session/update") {
              const update = msg.params?.update || {};
              const type = update.sessionUpdate;
              const contentField = update.content;
              const deltaText =
                typeof contentField === "string"
                  ? contentField
                  : contentField?.text ?? "";

              if (type === "agent_message_chunk") {
                if (deltaText) emitDelta(deltaText);
              }
              // agent_thought_chunk and tool_call/tool_call_update are internal.
              continue;
            }

            // ── Error responses ──────────────────────────────────────────
            if (msg.error) {
              if (msg.error.code === -32000 && /auth/i.test(String(msg.error.message))) {
                finish(authError());
              } else {
                finish(`Perch ACP error ${msg.error.code}: ${msg.error.message}`);
              }
              return;
            }
          }
        });

        child.stderr.on("data", (chunk) => {
          log?.debug?.("PERCH", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
        });

        child.on("close", (code) => {
          if (!finished) {
            if (code !== 0 && !spawnError && !roleEmitted) {
              finish(`Perch CLI exited with code ${code}`);
            } else {
              finish();
            }
          }
        });

        sendRpc("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: { name: "9router", version: "1.0" },
          capabilities: {},
        });
      },
    });

    return {
      response: new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: "perch://acp/stdio",
      headers: {},
      transformedBody: {
        model,
        cwd,
        promptLength: messages.length,
      },
    };
  }
}

export default PerchCliExecutor;
