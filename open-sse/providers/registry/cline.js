export default {
  id: "cline",
  priority: 80,
  alias: "cl",
  uiAlias: "cl",
  display: {
    name: "Cline",
    icon: "smart_toy",
    color: "#5B9BD5",
    textIcon: "CL",
    website: "https://cline.bot",
    notice: {
      signupUrl: "https://cline.bot",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "API key dari app.cline.bot → Settings > API Keys, atau login OAuth via browser.",
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      // Hook owns Authorization: workos:-prefixed OAuth vs plain API key
      // (a merged token can't express both) — see applyAuth.
      preserveHookAuth: true,
      hooks: [
        "clineHeaders",
      ],
    },
  },
  models: [
    { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex" },
    { id: "openai/gpt-5.4", name: "GPT-5.4" },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "google/gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview" },
    { id: "kwaipilot/kat-coder-pro", name: "KAT Coder Pro" },
    // Free tier (verified live via GET /api/v1/ai/cline/recommended-models):
    // billed $0 on usage, limited quota separate from ClinePass. The
    // cline-free/* aliases require Cline product headers (see shared/clineAuth.js)
    // or upstream 403s with "only available via Cline product surfaces".
    { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 (Free)" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (Free)" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash (Free)" },
    { id: "cline-free/solar-pro4", name: "Solar Pro 4 (Free)" },
    { id: "cline-free/longcat-2.0", name: "LongCat 2.0 (Free)" },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (Free)" },
  ],
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenExchangeUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
};
