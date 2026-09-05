import type { JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";
import type { LiveCommand } from "./types.ts";

export const MAX_LIVE_SDP_BYTES = 64 * 1024;
export const MAX_LIVE_REQUEST_BYTES = 96 * 1024;
export const LIVE_SESSION_HEADER = "x-collie-omp-session";
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Same admission rules at the phone bridge and at the private OMP listener. */
export function parseLiveCommand(raw: JsonValue): LiveCommand | null {
  const value = jsonRecord(raw);
  const requestId = jsonStringField(value?.requestId);
  if (!value || !requestId || !UUID.test(requestId)) return null;
  const action = value.action;
  if (action === "offer") {
    const sdp = jsonStringField(value.sdp);
    if (!sdp || Buffer.byteLength(sdp) > MAX_LIVE_SDP_BYTES || !sdp.startsWith("v=0")) return null;
    return { action, requestId, sdp };
  }
  if (action === "mute" && (value.muted === true || value.muted === false)) return { action, requestId, muted: value.muted };
  if (action === "ready" || action === "heartbeat" || action === "stop") return { action, requestId };
  return null;
}
