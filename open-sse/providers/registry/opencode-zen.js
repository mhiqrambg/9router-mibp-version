export const OPENCODE_CLI_VERSION = "0.1.48";
export const OPENCODE_CLI_USER_AGENT = "opencode/0.1.48 (linux x64)";

export default {
  id: "opencode-zen",
  priority: 200,
  alias: "zen",
  aliases: ["oc-zen", "opencode-zen"],
  uiAlias: "zen",
  display: {
    name: "OpenCode Zen",
    icon: "terminal",
    color: "#E87040",
    textIcon: "ZEN",
    website: "https://opencode.ai",
    notice: {
      signupUrl: "https://opencode.ai/auth",
    },
  },
  category: "oauth",
  hasOAuth: true,
  authModes: ["oauth", "apikey"],
  serviceKinds: ["llm"],
  transport: {
    baseUrls: ["https://opencode.ai"],
    format: "openai",
    headers: {
      "User-Agent": OPENCODE_CLI_USER_AGENT,
      "x-opencode-client": "cli",
      "x-opencode-version": OPENCODE_CLI_VERSION,
      "originator": "opencode",
    },
    chatPath: "/zen/v1/chat/completions",
    messagesPath: "/zen/v1/messages",
    responsesPath: "/zen/v1/responses",
  },
  models: [
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
  ],
  modelsFetcher: {
    url: "https://opencode.ai/zen/v1/models",
    type: "opencode-free",
    headers: {
      "User-Agent": OPENCODE_CLI_USER_AGENT,
      "x-opencode-client": "cli",
      "originator": "opencode",
    },
  },
  passthroughModels: true,
};
