import * as nodeMachineId from "node-machine-id";
import crypto from "node:crypto";

let cachedRawId = null;

function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    const fn = nodeMachineId.machineIdSync || nodeMachineId.default?.machineIdSync || nodeMachineId;
    cachedRawId = typeof fn === "function" ? fn() : crypto.randomUUID();
  } catch {
    cachedRawId = crypto.randomUUID();
  }
  return cachedRawId;
}

export async function getConsistentMachineId(salt = "endpoint-proxy-salt") {
  const rawId = loadRawMachineId();
  return crypto.createHash("sha256").update(rawId + salt).digest("hex").substring(0, 16);
}
