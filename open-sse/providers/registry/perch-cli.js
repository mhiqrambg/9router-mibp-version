export default {
  id: "perch-cli",
  alias: "perch",
  aliases: ["perchai", "perch-ai"],
  uiAlias: "perch",
  display: {
    name: "Perch CLI",
    icon: "terminal",
    color: "#1F2937",
    textIcon: "PR",
    website: "https://www.perchai.app",
    notice: {
      signupUrl: "https://www.perchai.app/cli",
      text: "Sign in with Google or GitHub (one connection per account). Install the CLI first: `npm install -g perchai-cli` (the Docker image includes it). A new account must accept the free Starter plan once at https://chat.perchai.app. Roost streams through ACP and works on every plan; a named model runs one buffered turn via `perch run`, but named pins bill a separate manual lane (Starter includes $20) — an account with no remaining manual allowance is blocked by Perch as direct API access, and a blocked account fails fast after one attempt instead of retrying. Tool approvals are denied unless PERCH_CLI_AUTO_APPROVE=1.",
    },
  },
  category: "free",
  authType: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "perch://acp/stdio",
    format: "openai",
  },
  // Perch's login is Supabase Auth. These are fallbacks only: the provider
  // fetches the live values from configUrl (same endpoint the CLI uses).
  oauth: {
    appUrl: "https://app.perchai.app",
    configUrl: "https://app.perchai.app/api/perch-terminal/cli-auth/config",
    supabaseUrl: "https://zlfuvsfjtgsdtqcaykia.supabase.co",
    anonKey: "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO",
    providers: ["google", "github"],
    redirectHost: "127.0.0.1",
  },
  models: [
    { id: "roost", name: "Perch (Roost)" },
    // Starter plan lineup. Beam 1.0 (Starter) is left out: its trial ended
    // 2026-10-23 and the CLI rejects the slug after that.
    { id: "qwen-3.8-max", name: "Qwen 3.8 Max (Promo)" },
    { id: "laguna-s", name: "Laguna S 2.1" },
    { id: "deepseek-flash-starter", name: "DeepSeek V4.1 Flash 1017 (Starter)" },
    { id: "glm-5.3-flash-starter", name: "GLM 5.3 Flash (Starter)" },
  ],
};
