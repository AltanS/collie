// The Hermes gateway's answers, read once (ADR 0142). This is the ONE file under bridge/door/ that reads
// an unvalidated gateway field, `beacon/parse.ts`'s pattern: the control socket's `identify` and
// `session-ticket` lines, and the WebSocket's JSON-RPC frames, `session.resume`'s snapshot and
// `prompt.submit`'s admission. Every `typeof` here sits inside one of these readers and IS the parse.
// What comes out is a named type, and nothing past it is trusted more than that: the session id the door
// sends is the binding's, never the gateway's, and an `api_origin` that is not a loopback literal is never
// a URL the door dials.

import { resolve } from "node:path";

import type { JsonObject, JsonValue } from "../json.ts";

/** The capability that says the gateway is the canonical one the door speaks to (ADR 0142 point 6). */
const SESSION_AUTHORITY = "session-authority-v1";

/** The loopback literals a gateway may name (ADR 0142 point 3); `URL` keeps IPv6 in brackets. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/** The gateway as `identify` described it. */
export interface Endpoint {
  readonly profileId: string;
  readonly instanceId: string;
  /** `ws://<loopback literal>:<port>/api/ws`. */
  readonly url: string;
}

/** The `identify` answer: the endpoint, or why there is no door (`absent`) or no send (a refusal). */
export type Identified = { readonly ok: true; readonly endpoint: Endpoint } | { readonly ok: false; readonly why: string; readonly absent?: true };

/** The attach's snapshot, as the door reads it. */
export interface Attached {
  readonly subscriptionId: string;
  /** A turn runs, a turn waits, or a question is open: a submit now waits its turn (SPEC V13). */
  readonly busy: boolean;
  /** The `input_id`s already in the session's queue. */
  readonly pendingIds: readonly string[];
}

/** An admission receipt: `queued` for every new one, idle or not; `terminal` only for one admitted before. */
export interface Admission {
  readonly admissionId: string;
  readonly status: string;
}

/** One WebSocket frame, as the door acts on it. */
export type GatewayFrame =
  | { readonly kind: "ready" }
  | { readonly kind: "event" }
  | { readonly kind: "request"; readonly id: string | number }
  | { readonly kind: "result"; readonly id: number; readonly result: JsonValue }
  | { readonly kind: "error"; readonly id: number; readonly message: string };

function readObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value;
}

function readString(row: JsonObject, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function readList(row: JsonObject, key: string): JsonValue[] {
  const value = row[key];
  return Array.isArray(value) ? value : [];
}

/** The WebSocket URL for `api_origin`, or null unless it is plain http on a loopback literal with a port. */
export function gatewayUrl(apiOrigin: string): string | null {
  let origin: URL;
  try {
    origin = new URL(apiOrigin);
  } catch {
    return null;
  }
  if (origin.protocol !== "http:" || !LOOPBACK_HOSTS.has(origin.hostname) || origin.port === "") return null;
  if (origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") return null;
  return `ws://${origin.host}/api/ws`;
}

/**
 * The `identify` answer (`hermes_cli/gateway_runtime.py` `_endpoint`). A gateway with no session
 * authority is one this door cannot speak to: absent. One that answers but is not ready, not this home's
 * or not on loopback refuses.
 */
export function readIdentify(answer: JsonValue, home: string): Identified {
  const top = readObject(answer);
  const r = top?.ok === true ? readObject(top.result) : null;
  if (r === null) return { ok: false, why: "the gateway refused identify" };
  if (r.runtime_protocol !== 1 || !readList(r, "capabilities").includes(SESSION_AUTHORITY)) {
    return { ok: false, why: "the Hermes gateway has no session authority", absent: true };
  }
  if (r.state !== "ready") return { ok: false, why: `the Hermes gateway is ${readString(r, "state") ?? "not ready"}` };
  const want = resolve(home);
  const served = readList(r, "served_profiles").flatMap((entry) => {
    const profile = readObject(entry);
    const profileHome = profile === null ? null : readString(profile, "home");
    const profileId = profile === null ? null : readString(profile, "profile_id");
    return profileHome !== null && resolve(profileHome) === want ? [profileId] : [];
  });
  const [profileId] = served;
  if (profileId === undefined || profileId === null || served.length > 1) return { ok: false, why: "the Hermes gateway does not serve this home" };
  const instanceId = readString(r, "instance_id");
  if (instanceId === null) return { ok: false, why: "the Hermes gateway names no instance" };
  const origin = readString(r, "api_origin");
  const url = origin === null ? null : gatewayUrl(origin);
  if (url === null) return { ok: false, why: "the Hermes gateway is not on loopback" };
  return { ok: true, endpoint: { profileId, instanceId, url } };
}

/** The ticket a `session-ticket` answer grants for `instanceId`, or null. */
export function readTicket(answer: JsonValue, instanceId: string): string | null {
  const top = readObject(answer);
  const grant = top?.ok === true ? readObject(top.result) : null;
  if (grant === null || grant.instance_id !== instanceId) return null;
  return readString(grant, "ticket");
}

/** `session.resume`'s snapshot, or null unless it attached `sessionId` with a subscription. */
export function readSnapshot(value: JsonValue, sessionId: string): Attached | null {
  const snapshot = readObject(value);
  if (snapshot === null || snapshot.session_id !== sessionId) return null;
  const subscriptionId = readString(snapshot, "subscription_id");
  if (subscriptionId === null) return null;
  const pending = readList(snapshot, "pending");
  return {
    subscriptionId,
    busy: snapshot.running === true || pending.length > 0 || readList(snapshot, "prompts").length > 0,
    pendingIds: pending.flatMap((entry) => {
      const row = readObject(entry);
      const id = row === null ? null : readString(row, "input_id");
      return id === null ? [] : [id];
    }),
  };
}

/** `prompt.submit`'s admission receipt, or null when it carries none this build reads. */
export function readAdmission(value: JsonValue): Admission | null {
  const receipt = readObject(value);
  if (receipt === null) return null;
  const admissionId = readString(receipt, "admission_id");
  const status = readString(receipt, "status");
  return admissionId === null || status === null ? null : { admissionId, status };
}

/** One WebSocket frame, or null for one the door ignores. */
export function readFrame(text: string): GatewayFrame | null {
  let decoded: JsonValue;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const frame = readObject(decoded);
  if (frame === null) return null;
  if (frame.method === "event") {
    const params = readObject(frame.params);
    return params?.type === "gateway.ready" ? { kind: "ready" } : { kind: "event" };
  }
  const id = frame.id;
  if (typeof frame.method === "string") return typeof id === "string" || typeof id === "number" ? { kind: "request", id } : { kind: "event" };
  if (typeof id !== "number") return null;
  if (frame.error !== undefined) {
    const error = readObject(frame.error);
    return { kind: "error", id, message: (error === null ? null : readString(error, "message")) ?? "error" };
  }
  return { kind: "result", id, result: frame.result ?? {} };
}

/** A control-socket answer line, or null when it is not JSON. */
export function readControlLine(line: string): JsonValue | null {
  try {
    const decoded: JsonValue = JSON.parse(line);
    return decoded;
  } catch {
    return null;
  }
}
