/**
 * Freebuff — the free, ad-supported coding agent by Codebuff (freebuff.com).
 *
 * The Freebuff CLI (github.com/CodebuffAI/freebuff) is an interactive TUI that
 * talks to the Codebuff/Freebuff backend. Two hosts are involved:
 *   - login flow (freebuff mode) runs on  https://freebuff.com
 *       POST /api/auth/cli/code {fingerprintId} → { loginUrl, fingerprintHash, expiresAt }
 *       open loginUrl in browser, then GET /api/auth/cli/status until {user}.
 *       (The server echoes the request host into loginUrl, so calling
 *       freebuff.com yields freebuff.com/login?auth_code=… exactly like the
 *       official CLI — www.codebuff.com would yield the wrong link.)
 *   - LLM traffic goes to the OpenAI-compatible endpoint on
 *       https://www.codebuff.com/api/v1/chat/completions
 *     (freebuff.com does NOT serve /api/v1/* — it 404s with the SPA shell.)
 *
 * Both hosts share one backend: the authToken obtained via the freebuff.com
 * login validates against www.codebuff.com (Bearer auth). The request body
 * must carry the CLI's `codebuff` provider block
 * (`codebuff_metadata.run_id/client_id/cost_mode`) — injected by
 * executors/freebuff.js. cost_mode:"free" is what admits a session on the free
 * (country-gated, session-limited) tier instead of billing credits.
 */
export default {
  id: "freebuff",
  priority: 45,
  hasFree: true,
  alias: "fb",
  uiAlias: "fb",
  display: {
    name: "Freebuff",
    icon: "bolt",
    color: "#84CC16",
    textIcon: "FB",
    website: "https://freebuff.com",
    notice: {
      signupUrl: "https://freebuff.com",
      text: "Free ad-supported coding agent by Codebuff. Sign in with your Freebuff/Codebuff account via browser login. Each model is priced in Freebucks per hour of session, charged once when the session starts. Your daily Freebucks refill at midnight Pacific; the wallet keeps what you buy or earn. Free tier is ad-supported and limited in some regions (limited mode: 6 x 1-hour sessions/day); full mode runs in select countries. ⚠️ One account has ONE active session locked to ONE model — requesting a different model while a session is active returns 'model_locked' (409); wait for the session to expire (~1h) instead of forcing re-claims (ToS: one account per person, human-initiated sessions only). DeepSeek V4.1 Flash closes daily ~00:00–10:00 UTC (peak window) — MiMo is the fallback then.",
    },
  },
  category: "free",
  authType: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    headers: {
      "User-Agent": "ai-sdk/openai-compatible/1.0/codebuff",
    },
    retry: {
      429: { attempts: 2, delayMs: 2000 },
      503: { attempts: 2, delayMs: 1500 },
    },
    // Session endpoint doubles as the quota API: GET /api/v1/freebuff/session
    // returns the shared daily session quota (rateLimitsByModel) without
    // claiming anything — POST would burn a session, so quota reads are GET
    // only (see services/usage/freebuff.js).
    usage: {
      url: "https://www.codebuff.com/api/v1/freebuff/session",
    },
  },
  features: {
    usage: true,
  },
  // Mirrors the Freebuff waiting-room picker (upstream FREEBUFF_MODELS) as of
  // 2026-09-25. NO per-model prices live here: Freebucks pricing is
  // server-authoritative — the session response's `freebucks` block carries
  // `prices` (model → Freebucks/hr) plus an announced `priceChanges` schedule
  // (promos like Solar Pro 4's Labor Day run expire server-side; see
  // services/usage/freebuff.js which folds both in, exactly like the upstream
  // CLI which hardcodes no number). Plus the capacity-limited Fable trial.
  // deepseek-v4-pro and minimax-m3 were withdrawn upstream (2026-08-26 /
  // 2026-08-20) and ox-alpha (2026-08-27) never stuck — none are claimable anymore.
  // openai/gpt-5.6-luna was WITHDRAWN 2026-09-22 and PAUSED 2026-09-24
  // (dead pick) — replaced by openai/gpt-6-luna (same slot, flex lane, beta).
  // upstage/solar-mini4 joined 2026-09-23 (Pro 4's slot; Pro 4 returned beside
  // it 2026-09-25) and stealth/space-bunny-alpha joined 2026-09-23 as a beta
  // stealth row (anonymous provider retains prompts).
  // google/gemini-3.8-flash is back since 2026-09-21 but PAID-ONLY
  // (plan-gated, LOCKED without a plan) — intentionally omitted, the server
  // refuses free admission on it.
  // z-ai/glm-5.2 is a referral reward (not a free pick), luna-es / kimi-k3-eco
  // are god-only rows, mimo-v2.6-pro is premium full-access-only, and the
  // `-max` variants are provisioned per-account — all intentionally omitted.
  // Fable is a capacity-limited WAVE trial: sessions only claim while the
  // backend advertises `anthropic/claude-fable-5.1` via limitedModelOffers on
  // the session status (the executor auto-checks before claiming); the model is
  // otherwise refused.
  // meta/muse-spark-1.3-contributor was withdrawn upstream 2026-09-07 (Meta
  // returns 404 model_not_found on every key) and replaced in the picker by
  // meta/muse-spark-1.2-contributor — same Contributor terms/pool. 1.3 is
  // intentionally NOT listed: 9Router has no server-side coercion, so a dead
  // pick would only fail.
  // deepseek/deepseek-v4-flash was RENAMED upstream 2026-09-10 to DeepSeek
  // V4.1 Flash (same undated wire id, new build) — display label follows.
  // mimo/mimo-v2.5 now serves MiMo 2.6 Flash under the unchanged wire id
  // (same move as V4.1) — display label follows.
  // deepseek/deepseek-v4-flash is `off_peak_only`: CLOSED ~00:00–10:00 UTC
  // daily (peak window) — a pick then is refused, MiMo is the fallback.
  models: [
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4.1 Flash" },
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.6 Flash" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4" },
    { id: "upstage/solar-mini4", name: "Solar Mini 4" },
    { id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2" },
    { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1 (limited offer)" },
  ],
  // Login-flow host — the CLI in freebuff mode logs in via freebuff.com, and
  // the server builds loginUrl from the host it was called on, so the link the
  // user opens must come from freebuff.com to match the official CLI.
  oauth: {
    baseUrl: "https://freebuff.com",
    loginCodePath: "/api/auth/cli/code",
    loginStatusPath: "/api/auth/cli/status",
    oauthTimeoutMs: 300000,
  },
};
