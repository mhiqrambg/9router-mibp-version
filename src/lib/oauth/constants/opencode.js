export const OPENCODE_CLI_VERSION = "0.1.48";
export const OPENCODE_CLI_USER_AGENT = "opencode/0.1.48 (linux x64)";

export const OPENCODE_OAUTH_CONFIG = {
  provider: "opencode-zen",
  authUrl: "https://auth.opencode.ai/authorize",
  tokenUrl: "https://auth.opencode.ai/oauth/token",
  clientId: "app",
  clientSecret: "",
  scopes: ["openid", "profile", "email", "offline_access"],
  redirectUri: "/api/oauth/opencode-zen/callback",
  userAgent: OPENCODE_CLI_USER_AGENT,
  originator: "opencode",
};
