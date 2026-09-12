export default {
  id: "tokenharbor",
  alias: "th",
  aliases: ["tokenharbor"],
  uiAlias: "tokenharbor",
  display: {
    name: "Token Harbor",
    icon: "hub",
    color: "#0EA5E9",
    textIcon: "TH",
    website: "https://tokenharbor.ai",
    notice: {
      text: "OpenAI-compatible gateway providing free tiers for select models.",
      apiKeyUrl: "https://tokenharbor.ai/docs/getting-started/quickstart",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://tokenharbor.ai/v1/chat/completions",
    validateUrl: "https://tokenharbor.ai/v1/models",
  },
  models: [
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "deepseek-v4-flash:free", name: "DeepSeek V4 Flash (Free)" },
    { id: "mimo-v2.5:free", name: "MiMo V2.5 (Free)" }
  ],
  serviceKinds: ["llm", "image", "audio", "video"],
  modelsFetcher: { url: "https://tokenharbor.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
