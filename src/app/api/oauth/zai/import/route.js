import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProviderConnection } from "@/models";

// ZCode desktop config locations, in probe order. The app stores per-provider
// options (apiKey + baseURL) under data.provider — the enabled
// "builtin:zai-start-plan" entry carries the Start Plan session JWT.
const ZCODE_CONFIG_PATHS = [
  join(homedir(), ".zcode", "v2", "config.json"),
  join(homedir(), ".zcode", "config.json"),
];

// Provider entries worth importing, best first. Start Plan authenticates with
// the session JWT against the zcode-plan leg; the coding-plan entries carry
// "id.secret" keys for the paid coding legs.
const PLAN_PRIORITY = [
  "builtin:zai-start-plan",
  "builtin:bigmodel-start-plan",
  "builtin:zai-coding-plan",
  "builtin:bigmodel-coding-plan",
];

function pickProviderEntry(providers) {
  const enabled = PLAN_PRIORITY.filter((id) => providers?.[id]?.enabled === true);
  const present = PLAN_PRIORITY.filter((id) => providers?.[id]?.options?.apiKey);
  const id = enabled[0] || present[0];
  return id ? { id, entry: providers[id] } : null;
}

/**
 * POST /api/oauth/zai/import
 * Import ZCode desktop app credentials from the local config
 * (~/.zcode/v2/config.json → data.provider["builtin:zai-start-plan"]).
 * The enabled provider's apiKey becomes the connection credential — the Start
 * Plan JWT when the start-plan entry is enabled (the app's default), or the
 * coding-plan "id.secret" key otherwise. A coding-plan key from a sibling
 * entry is kept as codingApiKey for the paid coding legs.
 */
export async function POST() {
  try {
    let raw = null;
    let usedPath = null;
    for (const p of ZCODE_CONFIG_PATHS) {
      try {
        raw = await readFile(p, "utf8");
        usedPath = p;
        break;
      } catch { /* try next location */ }
    }
    if (!raw) {
      return NextResponse.json(
        { error: `ZCode config not found (looked in ${ZCODE_CONFIG_PATHS.join(", ")}). Log in to the ZCode desktop app first, or paste the JWT manually.` },
        { status: 404 },
      );
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: `${usedPath} is not valid JSON` }, { status: 400 });
    }

    const providers = config?.provider && typeof config.provider === "object" ? config.provider : {};
    const picked = pickProviderEntry(providers);
    const apiKey = picked?.entry?.options?.apiKey?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: "No ZCode provider credentials found in the config — log in to the ZCode desktop app first." },
        { status: 404 },
      );
    }
    const planId = picked.id;

    // Sibling coding-plan key ("id.secret") for the paid coding legs, when the
    // primary pick is a start-plan JWT.
    let codingApiKey = "";
    if (planId.includes("start-plan")) {
      codingApiKey = providers["builtin:zai-coding-plan"]?.options?.apiKey?.trim() || "";
    }

    const planLabel = planId.replace(/^builtin:/, "").replace(/-/g, " ");
    const isJwt = apiKey.split(".").length === 3 && apiKey.length > 100;

    const connection = await createProviderConnection({
      provider: "glm",
      authType: "oauth",
      apiKey: codingApiKey || undefined,
      accessToken: isJwt ? apiKey : undefined,
      name: `Z.AI (${planLabel})`,
      providerSpecificData: {
        authMethod: "config_import",
        sourcePath: usedPath,
        planId,
        useCodingPlan: isJwt,
        zcodeJwtToken: isJwt ? apiKey : undefined,
        ...(codingApiKey ? { codingApiKey } : {}),
      },
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
      },
    });
  } catch (error) {
    console.log("Z.AI import error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * GET /api/oauth/zai/import
 * Instructions for the import flow.
 */
export async function GET() {
  return NextResponse.json({
    provider: "glm",
    method: "config_import",
    instructions:
      "Log in to the ZCode desktop app, then click auto-detect — the gateway reads the session credential from ~/.zcode/v2/config.json (builtin:zai-start-plan). If that fails, paste the JWT from that config manually.",
    requiredFields: [
      {
        name: "apiKey",
        label: "ZCode credential",
        description: "Start Plan JWT (builtin:zai-start-plan options.apiKey) or coding-plan id.secret key",
        type: "textarea",
      },
    ],
  });
}
