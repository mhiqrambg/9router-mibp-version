"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getProviderConnections, createProviderConnection, updateProviderConnection } from "@/models";

const POSSIBLE_CONFIG_PATHS = [
  path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
  path.join(os.homedir(), ".config", "opencode", "auth.json"),
  path.join(os.homedir(), ".opencode", "auth.json"),
];

export async function GET() {
  try {
    let authData = null;
    let foundPath = null;

    for (const p of POSSIBLE_CONFIG_PATHS) {
      try {
        const raw = await fs.readFile(p, "utf-8");
        const json = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
        if (json && (json.apiKey || json.token || json.accessToken || json.auth)) {
          authData = json;
          foundPath = p;
          break;
        }
      } catch {}
    }

    if (!authData) {
      return NextResponse.json({
        success: false,
        message: "File kredensial OpenCode belum ditemukan. Silakan login terlebih dahulu via 'opencode auth login' di terminal.",
        checkedPaths: POSSIBLE_CONFIG_PATHS,
      }, { status: 404 });
    }

    const token = authData.apiKey || authData.token || authData.accessToken || authData.auth?.token;
    const email = authData.email || authData.user?.email || "opencode-user@local";

    const existing = await getProviderConnections("opencode-zen");
    if (existing && existing.length > 0) {
      await updateProviderConnection(existing[0].id, {
        apiKey: token,
        email,
        isActive: 1,
      });
      return NextResponse.json({
        success: true,
        action: "updated",
        source: foundPath,
        email,
      });
    }

    const created = await createProviderConnection({
      provider: "opencode-zen",
      name: `OpenCode Zen (${email})`,
      authType: "apikey",
      apiKey: token,
      email,
      isActive: 1,
      priority: 50,
      providerSpecificData: {
        prefix: "zen",
        baseUrl: "https://opencode.ai/zen/v1",
        nodeName: "OpenCode Zen",
      },
    });

    return NextResponse.json({
      success: true,
      action: "created",
      source: foundPath,
      id: created.id,
      email,
    });
  } catch (error) {
    console.error("OpenCode auto-import error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
