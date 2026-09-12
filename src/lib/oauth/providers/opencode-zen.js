import { OPENCODE_OAUTH_CONFIG, OPENCODE_CLI_USER_AGENT } from "../constants/opencode.js";

const opencodeZen = {
  config: OPENCODE_OAUTH_CONFIG,
  flowType: "authorization_code_pkce",
  buildAuthUrl: (config, redirectUri, state, codeChallenge) => {
    const params = new URLSearchParams({
      client_id: config.clientId || "app",
      response_type: "code",
      redirect_uri: redirectUri,
      scope: (config.scopes || ["openid", "profile", "email", "offline_access"]).join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      originator: "opencode",
    });
    return `${config.authUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": OPENCODE_CLI_USER_AGENT,
        "x-opencode-client": "cli",
        "originator": "opencode",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId || "app",
        code: code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenCode token exchange failed: ${errText}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type,
    };
  },
  postExchange: async (tokens) => {
    // Seperti flow antigravity/codex: simulasi handshake CLI setelah login
    try {
      const verifyRes = await fetch("https://opencode.ai/zen/v1/models", {
        headers: {
          "Authorization": `Bearer ${tokens.accessToken || tokens.access_token}`,
          "User-Agent": OPENCODE_CLI_USER_AGENT,
          "x-opencode-client": "cli",
          "originator": "opencode",
        },
      });
      if (verifyRes.ok) {
        console.log("OpenCode Zen CLI handshake successful!");
      }
    } catch (e) {
      console.log("OpenCode CLI handshake non-blocking error:", e?.message);
    }
    return tokens;
  },
};

export default opencodeZen;
