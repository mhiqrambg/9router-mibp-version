import { NextResponse } from "next/server";
import { getProviderConnections, getCustomModels, deleteCustomModel } from "@/models";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { getModelKind } from "@/shared/constants/models";
import { getDisabledModels, disableModels } from "@/lib/disabledModelsDb";
import { pingModelByKind } from "../ping";
import { UPDATER_CONFIG } from "@/shared/constants/config";

// Global background task registry in server memory
const activeTasks = new Map(); // providerStorageAlias -> { status, total, current, model, passed, pruned, startedAt, updatedAt }

export const dynamic = "force-dynamic";

// Helper function to run tests in server background
async function runBackgroundAutoClean(providerStorageAlias) {
  const task = {
    status: "running",
    total: 0,
    current: 0,
    model: "",
    passed: 0,
    pruned: 0,
    log: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  activeTasks.set(providerStorageAlias, task);

  const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;

  try {
    const aliasToProviderId = Object.fromEntries(
      Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
    );
    const providerId = aliasToProviderId[providerStorageAlias] || providerStorageAlias;

    const [allCustom, disabledMap] = await Promise.all([
      getCustomModels(),
      getDisabledModels(),
    ]);

    const disabledList = disabledMap[providerStorageAlias] || [];
    const customForProvider = (allCustom || []).filter(
      (m) => m.providerAlias === providerStorageAlias && (m.kind || m.type || "llm") === "llm"
    );

    const builtIn = getModelsByProviderId(providerId)
      .filter((m) => {
        const k = getModelKind(m);
        return !k || k === "llm";
      })
      .filter((m) => !disabledList.includes(m.id));

    const targets = [
      ...customForProvider.map((m) => ({ id: m.id, isCustom: true })),
      ...builtIn.map((m) => ({ id: m.id, isCustom: false })),
    ];

    task.total = targets.length;
    task.updatedAt = new Date().toISOString();

    for (let i = 0; i < targets.length; i += 1) {
      const item = targets[i];
      task.current = i + 1;
      task.model = item.id;
      task.updatedAt = new Date().toISOString();

      try {
        const testRes = await pingModelByKind(`${providerStorageAlias}/${item.id}`, "llm", baseUrl);

        const isFatalError = !testRes.ok && (
          testRes.status === 401 ||
          testRes.status === 402 ||
          testRes.status === 404 ||
          testRes.status === 400 ||
          /payment|billing|balance|credits|insufficient|not found|unknown model|unsupported|does not exist|quota/i.test(String(testRes.error || ""))
        );

        if (testRes.ok) {
          task.passed += 1;
        } else if (isFatalError) {
          task.pruned += 1;
          task.log.push({ model: item.id, reason: testRes.error || `HTTP ${testRes.status}` });
          if (item.isCustom) {
            await deleteCustomModel({ providerAlias: providerStorageAlias, id: item.id, type: "llm" });
          } else {
            await disableModels(providerStorageAlias, [item.id]);
          }
        }
      } catch (err) {
        console.log(`[AutoClean] Error testing ${item.id}:`, err?.message || err);
      }
    }

    task.status = "completed";
    task.model = "";
    task.updatedAt = new Date().toISOString();
  } catch (error) {
    console.log("[AutoClean] Fatal error:", error);
    task.status = "failed";
    task.error = error.message;
    task.updatedAt = new Date().toISOString();
  }
}

// GET /api/models/test/auto-clean?provider=xxx - Check background task status
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");
  if (!provider) return NextResponse.json({ error: "provider required" }, { status: 400 });

  const task = activeTasks.get(provider) || { status: "idle" };
  return NextResponse.json(task);
}

// POST /api/models/test/auto-clean - Kick off background test & prune job on server
export async function POST(request) {
  try {
    const { provider } = await request.json();
    if (!provider) return NextResponse.json({ error: "provider required" }, { status: 400 });

    const currentTask = activeTasks.get(provider);
    if (currentTask && currentTask.status === "running") {
      return NextResponse.json({ message: "Task already running", task: currentTask });
    }

    // Fire & Forget in Node.js server background — independent of client browser connection!
    runBackgroundAutoClean(provider).catch((err) => {
      console.log("[AutoClean] Server task background uncaught error:", err);
    });

    return NextResponse.json({ success: true, message: "Background auto-clean started on host" });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
