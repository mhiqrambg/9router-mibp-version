// Some upstream lanes reject the whole request when it carries a media part,
// regardless of model capability. Probed 2026-11-11: an `image_url` part —
// base64 data URI or https URL — answers 400 `upstream_invalid_request` on the
// runcrate DeepSeek flex lanes and on a custom OpenAI-compatible node fronting
// nutaraline, while the same model id keeps vision:true behind gateways that do
// accept images. Capabilities describe the MODEL; this map describes the LANE,
// and it can only be learned from the wire: a 400 that carries media teaches us
// that the lane is text-only, so later requests strip the media up front
// instead of paying for a failed round trip.
const LANE_TEXT_ONLY_MS = 6 * 60 * 60 * 1000;

// key -> expiresAt (ms). Module-level and per-process, like the pool fitness map.
const textOnlyLanes = new Map();

const laneKey = (provider, connectionId, model) =>
  `${provider || ""}\u0000${connectionId || ""}\u0000${model || ""}`;

/** True when this lane already rejected a request that carried media. */
export function laneRejectsMedia(provider, connectionId, model, now = Date.now()) {
  const key = laneKey(provider, connectionId, model);
  const until = textOnlyLanes.get(key);
  if (!until) return false;
  if (until <= now) {
    textOnlyLanes.delete(key);
    return false;
  }
  return true;
}

export function markLaneRejectsMedia(provider, connectionId, model, now = Date.now()) {
  textOnlyLanes.set(laneKey(provider, connectionId, model), now + LANE_TEXT_ONLY_MS);
}

/** Caps for a lane known to reject media parts: keep everything else. */
export function textOnlyCaps(caps) {
  return { ...caps, vision: false, audioInput: false, pdf: false, mediaUnsupportedByLane: true };
}

/** Test seam: drop every learned lane. */
export function resetMediaLaneState() {
  textOnlyLanes.clear();
}
